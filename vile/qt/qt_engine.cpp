#include "qt_engine.h"

#include <QCoreApplication>

#include <QDir>
#include <QUrl>
#include <QWebEngineCookieStore>
#include <QWebEngineDownloadRequest>
#include <QWebEngineFindTextResult>
#include <QWebEngineHistory>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebEngineSettings>
#include <QWebEngineUrlRequestInfo>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineView>

#include "faviconstore.h"
#include "theme.h"

#include "vile/url.hpp"

namespace {

// Runs on Chromium's IO thread: asks the Shield about every request.
class ShieldInterceptor : public QWebEngineUrlRequestInterceptor {
public:
    ShieldInterceptor(ShieldAccess* access, QtEngine* engine, QObject* parent = nullptr)
        : QWebEngineUrlRequestInterceptor(parent), access_(access), engine_(engine) {}

    void interceptRequest(QWebEngineUrlRequestInfo& info) override {
        // Lock-free: the Shield is an immutable snapshot. The only lock
        // on this thread is the BlockLog's, taken only when a request is
        // actually blocked (the rare path), never across the check.
        const std::shared_ptr<const vile::Shield> shield = access_->shield.load();
        if (!shield) return;
        const std::string url = info.requestUrl().toString().toStdString();
        const std::string top = info.firstPartyUrl().toString().toStdString();
        vile::ShieldDecision d = shield->check_request(url, top);
        if (d.action == vile::ShieldDecision::Action::Block) {
            info.block(true);
            {
                std::lock_guard<std::mutex> lock(access_->logMutex);
                access_->blockLog.record({url, top, d.reason, d.rule});
            }
            emit engine_->shieldDecision(
                QString::fromStdString(d.rule), QString::fromStdString(url),
                QUrl(QString::fromStdString(top)).host());
        } else if (d.action == vile::ShieldDecision::Action::UpgradeToHttps) {
            info.redirect(QUrl(QString::fromStdString(vile::upgrade_to_https(url))));
        }
        for (const auto& h : shield->request_headers())
            info.setHttpHeader(QByteArray::fromStdString(h.first),
                               QByteArray::fromStdString(h.second));
    }

private:
    ShieldAccess* access_;
    QtEngine* engine_;
};

}  // namespace

namespace {
// The web-content scrollbar is Chromium's stock light-grey widget —
// on every page, the loudest element in an otherwise dark UI. There
// is no profile-level scrollbar theme in WebEngine, so restyle it
// with a user script injected at document creation. The colours come
// from the ACTIVE PALETTE (round 14's design review measured the old
// hardcoded #3d3d3d thumb sitting in the light theme — and in the
// dark theme too, where the palette's scroll role differs).
// One correction to this block's original claim: it said pages that
// style their own scrollbars "keep theirs, their rules come later in
// the cascade" — false in practice. The DOMContentLoaded fallback
// appends this style AFTER the page's parsed head styles, so at
// equal specificity the injected rule wins; it overrode even the new
// tab page's own palette rule. The NTP no longer carries scrollbar
// rules of its own: this injection is the one scrollbar system, and
// it is palette-driven.
void installScrollbarStyle(QWebEngineProfile* profile) {
    const Palette& p = activePalette();
    QWebEngineScript script;
    script.setName(QStringLiteral("vile-scrollbar"));
    script.setInjectionPoint(QWebEngineScript::DocumentCreation);
    script.setWorldId(QWebEngineScript::MainWorld);
    script.setRunsOnSubFrames(true);
    // The guard is load-bearing: at DocumentCreation the parser
    // has usually not created the root element yet, and the naive
    // one-liner throws on appendChild and dies — silently, on every
    // page (a probe verified the style never landed until the
    // DOMContentLoaded fallback was added).
    script.setSourceCode(QStringLiteral(
        "(function(){function add(){var s=document.createElement('style');"
        "s.textContent='::-webkit-scrollbar{width:10px;height:10px}"
        "::-webkit-scrollbar-thumb{background:%1;border-radius:5px;"
        "border:2px solid transparent;background-clip:content-box}"
        "::-webkit-scrollbar-thumb:hover{background-color:%2}"
        "::-webkit-scrollbar-track{background:transparent}"
        "::-webkit-scrollbar-corner{background:transparent}';"
        "(document.head||document.documentElement).appendChild(s);}"
        "if(document.documentElement){add();}"
        "else{document.addEventListener('DOMContentLoaded',add);}})();")
                             .arg(p.scroll, p.scrollHover));
    // Replace-by-name: a theme refresh re-installs with new colours.
    auto* scripts = profile->scripts();
    const QList<QWebEngineScript> old =
        scripts->find(QStringLiteral("vile-scrollbar"));
    for (const QWebEngineScript& s : old) scripts->remove(s);
    scripts->insert(script);
}
}  // namespace

QtEngine::QtEngine(const QString& dataDir, ShieldAccess* access, QObject* parent)
    : QObject(parent), access_(access) {
    favicons_ = new FaviconStore(dataDir, this);
    profile_ = new QWebEngineProfile(QStringLiteral("vile"), this);
    profile_->setPersistentStoragePath(dataDir + QStringLiteral("/webengine"));
    profile_->setCachePath(dataDir + QStringLiteral("/webengine-cache"));
    profile_->setPersistentCookiesPolicy(QWebEngineProfile::ForcePersistentCookies);
    profile_->setHttpCacheType(QWebEngineProfile::DiskHttpCache);
    wireProfile(profile_);

    // The private-mode profile: no storage name, so Qt keeps it
    // off-the-record — cookies, cache, local storage and IndexedDB live
    // in memory only and die with the process.
    otrProfile_ = new QWebEngineProfile(this);
    installScrollbarStyle(profile_);
    installScrollbarStyle(otrProfile_);
    // (refreshScrollbarStyle below re-runs this pair on a theme
    // switch; scripts apply at document creation, so pages pick the
    // new colours up at their next load.)
    wireProfile(otrProfile_);
}

void QtEngine::refreshScrollbarStyle() {
    installScrollbarStyle(profile_);
    installScrollbarStyle(otrProfile_);
}

void QtEngine::wireProfile(QWebEngineProfile* profile) {
    auto* interceptor = new ShieldInterceptor(access_, this, this);
    profile->setUrlRequestInterceptor(interceptor);

    // PDFs download instead of opening in Chromium's built-in viewer.
    profile->settings()->setAttribute(QWebEngineSettings::PdfViewerEnabled, false);
    connect(profile, &QWebEngineProfile::downloadRequested, this,
            &QtEngine::downloadRequested);

    // Cookie filter: refuse third-party cookies. Qt hands us the cookie's
    // origin, the first-party URL and a thirdParty flag, so this is exactly
    // the check_cookie call INTEGRATION.md §3 describes.
    profile->cookieStore()->setCookieFilter(
        [access = access_, engine = this](
            const QWebEngineCookieStore::FilterRequest& request) {
            if (!request.thirdParty) return true;
            const std::shared_ptr<const vile::Shield> shield = access->shield.load();
            if (!shield) return true;
            const std::string origin = request.origin.toString().toStdString();
            const std::string top = request.firstPartyUrl.toString().toStdString();
            auto d = shield->check_cookie(origin, top);
            if (d.action != vile::ShieldDecision::Action::Block) return true;
            {
                std::lock_guard<std::mutex> lock(access->logMutex);
                access->blockLog.record({origin, top, d.reason, d.rule});
            }
            // A refused cookie is a Shield block like any other:
            // report it too, or the per-site counts and the session
            // total (which counts the log) would tell two stories.
            // The slot connection is queued, so emitting from the
            // cookie store's thread is safe.
            emit engine->shieldDecision(QString::fromStdString(d.rule),
                                        QString::fromStdString(origin),
                                        request.firstPartyUrl.host());
            return false;
        });
}

QWebEngineProfile* QtEngine::currentProfile() const {
    return privateMode_ ? otrProfile_ : profile_;
}

void QtEngine::attachPage(QWebEngineView* view) {
    auto* page = new QWebEnginePage(currentProfile(), view);
    // Dark before first paint: a page must never flash white against the
    // dark chrome while it loads.
    page->setBackgroundColor(QColor(0x16, 0x16, 0x16));
    // Track OUR page per view in attachedPages_: setPage does NOT delete
    // the page it replaces, so without this every private-mode swap
    // leaked a page (and its profile kept it alive — Qt's "Release of
    // profile requested but WebEnginePage still not deleted" warning,
    // surfaced by the UI tests). The replaced page can NOT be recovered
    // via view->page(): the view deletes its own default page when a
    // page is set, so that pointer dangles after the first swap. Our
    // pages are parented to the view and deleted explicitly on the next
    // swap; destroy_view drops the map entry before deleting the view
    // (the view then deletes the page it still holds as its child).
    QWebEnginePage* old = attachedPages_.take(view);
    view->setPage(page);
    attachedPages_[view] = page;
    // Deleted outright, not deleteLater: the view no longer
    // references the old page once setPage returns, attachPage is
    // only ever called from view creation and the private-mode swap
    // (both window-driven, never from inside a page signal), and the
    // engine's destructor already deletes its remaining pages
    // synchronously. Retirement is owned here, not delegated to the
    // event loop's goodwill.
    if (old && old != page) delete old;
}

void QtEngine::set_private_mode(bool on) {
    if (privateMode_ == on) return;
    privateMode_ = on;
    // Live views move too: swap each view's page onto the other profile
    // and reload it. Page state (scroll, form entries, back/forward) is
    // lost — deliberately: keeping the old page would keep writing to the
    // old profile's storage from the very tabs the user just switched.
    for (QWebEngineView* view : views_) {
        const QUrl url = view->url();
        attachPage(view);
        if (url.isValid() && !url.isEmpty()) view->load(url);
    }
}

QtEngine::~QtEngine() {
    // Flush pending deferred deletions first: when the Browser tears
    // down it closes its tabs through destroy_view, which only
    // deleteLater()s the views — those views still own pages on our
    // profiles, and the profiles (QObject children, destroyed right
    // after this body) must not be released while a page exists: that
    // is exactly Qt's "Release of profile requested but WebEnginePage
    // still not deleted" warning, which the UI tests printed twice per
    // run while passing. Whatever views remain afterwards are deleted
    // synchronously, pages and all, before the profiles die.
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    for (QWebEngineView* v : views_) {
        attachedPages_.remove(v);
        delete v;
    }
    views_.clear();
    attachedPages_.clear();
}

QWebEngineView* QtEngine::viewFor(vile::ViewId id) const {
    return views_.value(id, nullptr);
}

void QtEngine::set_listener(vile::EngineEvents* listener) { listener_ = listener; }

vile::ViewId QtEngine::create_view(const std::string& url) {
    vile::ViewId id = nextId_++;
    auto* view = new QWebEngineView;
    views_[id] = view;
    attachPage(view);  // a page on the current (persistent or OTR) profile
    connect(view, &QWebEngineView::urlChanged, this, [this, id](const QUrl& u) {
        if (listener_) listener_->on_url_changed(id, u.toString().toStdString());
    });
    connect(view, &QWebEngineView::titleChanged, this, [this, id](const QString& t) {
        if (listener_) listener_->on_title_changed(id, t.toStdString());
    });
    connect(view, &QWebEngineView::iconChanged, this, [this, view](const QIcon& icon) {
        // Keep the site's logo for the chrome (tab rail, new-tab
        // bookmark tiles, suggestion rows). GOVERNANCE, revised:
        // this used to refuse off-the-record views entirely, but
        // private mode here is the history-off DEFAULT posture, so
        // the refusal silently disabled logos for nearly everyone —
        // the user's repeated complaint. A logo is a per-host image
        // with no URL, no timestamp and no page content, and it is
        // wiped with the rest of the site data (clear_site_data,
        // which clear-on-exit also routes through): logos live
        // exactly as long as the user's other site data, no longer.
        favicons_->capture(view->url().host(), icon);
    });
    connect(view, &QWebEngineView::loadStarted, this, [this, id]() {
        if (listener_) listener_->on_loading_changed(id, true);
    });
    connect(view, &QWebEngineView::loadFinished, this, [this, id](bool) {
        if (listener_) listener_->on_loading_changed(id, false);
    });
    view->load(QUrl(QString::fromStdString(url)));
    return id;
}

void QtEngine::destroy_view(vile::ViewId id) {
    auto it = views_.find(id);
    if (it == views_.end()) return;
    attachedPages_.remove(it.value());  // the view's deletion takes its page
    it.value()->deleteLater();
    views_.erase(it);
    zoom_.remove(id);
}

bool QtEngine::load_url(vile::ViewId id, const std::string& url) {
    QWebEngineView* v = viewFor(id);
    if (!v) return false;  // no live view: the load cannot start
    const QUrl qurl = QUrl(QString::fromStdString(url));
    if (!qurl.isValid()) return false;
    v->load(qurl);
    return true;
}

void QtEngine::find_text(vile::ViewId id, const std::string& text, bool backward,
                         std::function<void(int, int)> on_result) {
    QWebEngineView* v = viewFor(id);
    if (!v) return;
    const QString q = QString::fromStdString(text);
    if (!on_result) {
        v->findText(q);
        return;
    }
    v->findText(q, backward ? QWebEnginePage::FindBackward : QWebEnginePage::FindFlags(),
                [on_result](const QWebEngineFindTextResult& r) {
                    on_result(r.activeMatch(), r.numberOfMatches());
                });
}

void QtEngine::set_zoom(vile::ViewId id, double factor) {
    if (QWebEngineView* v = viewFor(id)) {
        v->setZoomFactor(factor);
        zoom_[id] = factor;
    }
}

double QtEngine::zoom(vile::ViewId id) const {
    return zoom_.value(id, 1.0);
}

void QtEngine::page_text(vile::ViewId id,
                         std::function<void(const std::string&)> on_text) {
    QWebEngineView* v = viewFor(id);
    if (!v || !on_text) return;
    // If the view dies first, Chromium drops this callback — the
    // interface contract says callers must not wait unguarded.
    v->page()->toPlainText([on_text](const QString& text) {
        on_text(text.toStdString());
    });
}

void QtEngine::go_back(vile::ViewId id) {
    if (QWebEngineView* v = viewFor(id)) v->back();
}

void QtEngine::go_forward(vile::ViewId id) {
    if (QWebEngineView* v = viewFor(id)) v->forward();
}

void QtEngine::reload(vile::ViewId id) {
    if (QWebEngineView* v = viewFor(id)) v->reload();
}

void QtEngine::stop(vile::ViewId id) {
    if (QWebEngineView* v = viewFor(id)) v->stop();
}

bool QtEngine::can_go_back(vile::ViewId id) const {
    QWebEngineView* v = viewFor(id);
    return v && v->history()->canGoBack();
}

bool QtEngine::can_go_forward(vile::ViewId id) const {
    QWebEngineView* v = viewFor(id);
    return v && v->history()->canGoForward();
}

void QtEngine::clear_site_data() {
    // Stored site logos are site data too (and a per-host record):
    // they clear with everything else here, which also covers
    // clear-on-exit — Browser::close_session routes through this.
    favicons_->clear();
    profile_->cookieStore()->deleteAllCookies();
    profile_->clearHttpCache();
    profile_->clearAllVisitedLinks();
    // Qt 6.4 exposes no API for local storage, IndexedDB, service workers
    // and friends — they live as files under the profile's storage path.
    // Remove the known storage subtrees so "clear site data" is true.
    // (Best effort: a page holding a store open may recreate its
    // directory, but the stored data itself is deleted.)
    const QString storage = profile_->persistentStoragePath();
    for (const QString& sub :
         {QStringLiteral("Local Storage"), QStringLiteral("IndexedDB"),
          QStringLiteral("Session Storage"), QStringLiteral("databases"),
          QStringLiteral("Service Worker"), QStringLiteral("blob_storage"),
          QStringLiteral("GPUCache"), QStringLiteral("Code Cache"),
          QStringLiteral("File System"), QStringLiteral("shared_proto_db"),
          QStringLiteral("WebStorage"), QStringLiteral("Network")})
        QDir(storage + QStringLiteral("/") + sub).removeRecursively();
    // The HTTP cache lives in its own directory: remove it wholesale.
    QDir(profile_->cachePath()).removeRecursively();
}
