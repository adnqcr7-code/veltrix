#pragma once
// QtEngine: the vile::Engine implementation backed by Qt WebEngine (Chromium).
// This is the piece INTEGRATION.md §1 describes: it implements the Engine
// interface, and the Browser core talks to it — never to Chromium directly.
//
// Shield wiring (INTEGRATION.md §3) lives here too:
//  - every network request goes through ShieldInterceptor (a
//    QWebEngineUrlRequestInterceptor): Block -> cancel, UpgradeToHttps ->
//    redirect, plus the Sec-GPC header on every request.
//  - every cookie goes through the profile's cookie filter, which calls
//    Shield::check_cookie with the cookie's origin and the first-party URL
//    Qt hands us (FilterRequest gives us both, plus a thirdParty flag).
#include <QMap>
#include <QObject>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>

#include "tabviewsource.h"
#include "faviconstore.h"
#include "vile/engine.hpp"
#include "vile/privacy.hpp"

class QWebEngineProfile;
class QWebEngineView;
class QWebEnginePage;
class QWebEngineDownloadRequest;
class FaviconStore;

namespace vile {
class Shield;
}

// How the engine reaches the Shield. The interceptor and the cookie
// filter run on Chromium's IO thread; the UI thread owns configuration.
//
// The Shield itself is handed over as an IMMUTABLE SNAPSHOT: readers
// load it lock-free, and a settings or blocklist change builds a new
// Shield and stores it (copy-on-write) — there is no window where a
// reader can observe a half-updated rule set, and no lock is held
// across a check. What was blocked accumulates in the BlockLog beside
// it, under its own small mutex (written by the IO thread on a block,
// read by the UI thread for the Privacy panel).
struct ShieldAccess {
    std::atomic<std::shared_ptr<const vile::Shield>> shield;
    vile::BlockLog blockLog;
    mutable std::mutex logMutex;  // mutable: stats are read from const paths too
};

class QtEngine : public QObject, public vile::Engine, public TabViewSource {
    Q_OBJECT
public:
    explicit QtEngine(const QString& dataDir, ShieldAccess* access, QObject* parent = nullptr);
    ~QtEngine() override;

    // The widget for a view, to embed in a tab. Null for unknown ids.
    QWebEngineView* viewFor(vile::ViewId id) const;

    // Re-install the scrollbar style with the active palette's
    // colours (theme switches). Pages loaded afterwards pick it up.
    void refreshScrollbarStyle();

    // Site logos captured from loaded pages (see faviconstore.h).
    FaviconStore& favicons() { return *favicons_; }
    QWebEngineView* viewForTab(vile::TabId id) override { return viewFor(id); }
    QPixmap faviconPixmap(const QString& host, int size) const override {
        return favicons_->has(host) ? favicons_->pixmap(host, size) : QPixmap();
    }

    // vile::Engine
    void set_listener(vile::EngineEvents* listener) override;
    vile::ViewId create_view(const std::string& url) override;
    void destroy_view(vile::ViewId id) override;
    bool load_url(vile::ViewId id, const std::string& url) override;
    void find_text(vile::ViewId, const std::string& text, bool backward,
                   std::function<void(int, int)> on_result) override;
    void set_zoom(vile::ViewId, double factor) override;
    double zoom(vile::ViewId) const override;
    void page_text(vile::ViewId,
                   std::function<void(const std::string&)> on_text) override;
    void go_back(vile::ViewId id) override;
    void go_forward(vile::ViewId id) override;
    void reload(vile::ViewId id) override;
    void stop(vile::ViewId id) override;
    bool can_go_back(vile::ViewId id) const override;
    bool can_go_forward(vile::ViewId id) const override;
    void clear_site_data() override;
    // vile::Engine: private mode runs views on an off-the-record profile
    // (memory-only cookies, cache and site storage); live views are moved
    // onto it, not just future ones.
    void set_private_mode(bool on) override;

signals:
    // Emitted (from the IO thread) when the Shield blocks or upgrades something.
    void shieldDecision(const QString& rule, const QString& url, const QString& pageHost);
    // Emitted when a download starts; the receiver accepts it (or not).
    void downloadRequested(QWebEngineDownloadRequest* download);

private:
    void wireProfile(QWebEngineProfile* profile);
    QWebEngineProfile* currentProfile() const;
    void attachPage(QWebEngineView* view);

    QWebEngineProfile* profile_ = nullptr;     // persistent
    QWebEngineProfile* otrProfile_ = nullptr;  // off-the-record (private)
    bool privateMode_ = false;
    ShieldAccess* access_ = nullptr;
    FaviconStore* favicons_ = nullptr;
    vile::EngineEvents* listener_ = nullptr;
    QMap<vile::ViewId, QWebEngineView*> views_;
    QMap<vile::ViewId, double> zoom_;  // per-view zoom factors (the
                                       // adapter owns this state now)
    // The page WE attached to each view (see attachPage): setPage never
    // deletes the page it replaces, so the engine tracks its own.
    QMap<QWebEngineView*, QWebEnginePage*> attachedPages_;
    vile::ViewId nextId_ = 1;
};
