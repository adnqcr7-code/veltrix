#pragma once
// VILE main window: a slim tab rail (site logos only), the address
// bar and the page stack. No side panels — Settings opens from the
// rail's gear button, downloads in their own popup.
// Wires the backend (Browser + Shield + LocalAssistant) to Qt WebEngine
// through QtEngine, following INTEGRATION.md's start-up order:
//   Database -> onboarding (done in main) -> PrivacySettings -> Shield
//   -> Browser(engine, history) -> private mode + search engine.
#include <QColor>
#include <QButtonGroup>
#include <QHash>
#include <QPointer>
#include <QMainWindow>
#include <QMap>
#include <QSet>
#include <functional>
#include <memory>
#include <vector>

#include "addressbar.h"
#include "icons.h"
#include "findbar.h"
#include "qt_engine.h"
#include "vile/browser.hpp"
#include "vile/http.hpp"
#include "vile/local_ai.hpp"
#include "vile/privacy.hpp"
#include "vile/storage.hpp"

class QAction;
class QToolBar;
class QVBoxLayout;
class QDialog;
class QGraphicsOpacityEffect;
class QTimer;
class QLabel;
class QLineEdit;
class QListWidget;
class QListWidget;
class QListWidgetItem;
class QPropertyAnimation;
class QProgressBar;
class QAbstractButton;
class QPushButton;
class QStackedWidget;
class QTabWidget;
class QTextEdit;
class QToolButton;
class QWebEngineDownloadRequest;
class SettingsDialog;

class SessionStore;
class DownloadsPanel;
class TabStripController;
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    MainWindow(vile::Database& db, vile::PrivacySettings settings,
               const std::vector<vile::LocalAiProvider>& detected, const QString& dataDir,
               QWidget* parent = nullptr);
    ~MainWindow() override;

#ifdef VILE_DEMO
    // Demo hooks: declared only in the vile-demo build and
    // implemented in mainwindow_demo.cpp, which the production
    // target never links. Precisely: the production class carries
    // demo-only flags inside the components (the address bar's
    // suggestions bypass; the downloads panel
    // holds its own pause-next flag, set through it)
    // that only these demo methods can set — with no demo code
    // linked, they are always false and the branches they guard
    // never run. (This hook: opens two example tabs.)
    void demoOpenTabs();
    bool demoSettled() const;
#endif
    // Opens a fresh tab (about:blank, which shows the new tab page).
    void openNewTab() { if (browser_) browser_->open_tab(); }
    // Navigates the current tab (address-bar input, so "!w rust" works here).
    void navigateCurrentTab(const std::string& input) {
        if (vile::TabId id = currentTabId()) browser_->navigate(id, input);
    }
#ifdef VILE_DEMO
    // Demo only: navigate the Browser's active tab. (currentTabId() reads
    // the UI, which syncs a beat later via a queued call; the Browser's
    // active tab is never stale.)
    void demoNavigateActiveTab(const std::string& input) {
        if (browser_)
            if (auto id = browser_->active_tab()) browser_->navigate(*id, input);
    }
    // Demo only: the Browser's active tab's URL (same reason as above).
    std::string demoActiveTabUrl() const {
        if (browser_)
            if (auto id = browser_->active_tab())
                if (const vile::Tab* t = browser_->find(*id)) return t->url;
        return {};
    }
    // Demo only: pin the tab whose URL contains the given text.
    void demoPinTabByUrl(const QString& needle) {
        if (!browser_) return;
        for (const auto& t : browser_->tabs())
            if (QString::fromStdString(t.url).contains(needle)) {
                browser_->set_pinned(t.id, true);
                return;
            }
    }
    // Demo only: activate the tab whose URL contains the given text.
    void demoActivateTabByUrl(const QString& needle) {
        if (!browser_) return;
        for (const auto& t : browser_->tabs())
            if (QString::fromStdString(t.url).contains(needle)) {
                browser_->activate(t.id);
                return;
            }
    }
    // Demo only: duplicate the Browser's active tab.
    void demoDuplicateActiveTab() {
        if (browser_)
            if (auto id = browser_->active_tab()) browser_->duplicate_tab(*id);
    }
    // Demo only: run the same clear-data flow the Settings button triggers
    // in the real app (the demo shows Settings without openSettings(), so
    // nothing else connects the dialog's request signal).
    void demoClearData() { onClearDataRequested(); }
    // The demo shows Settings directly (not via openSettings), so it
    // drives the modal scrim itself, like the real dialog stack.
    void demoShowScrim() { showScrim(); }
    void demoHideScrim() { hideScrim(); }
    // Demo only: middle-click the active tab's strip item — exercises the
    // same event-filter path a real middle-click takes.
    void demoMiddleClickActiveTab();
    // Demo helper: the current tab's URL (lets the demo wait for a navigation
    // to actually land before screenshotting it).
    std::string demoCurrentUrl() const {
        if (const vile::Tab* t = browser_ ? browser_->find(currentTabId()) : nullptr)
            return t->url;
        return {};
    }
    // Demo only: turn history recording on so the address-bar suggestions
    // have something to match. The shipped default stays off (private).
    void demoEnableHistory() {
        settings_.save_history = true;
        if (browser_) browser_->set_private_mode(false);
    }
    // Demo only: type into the address bar and show its suggestions popup.
    void demoShowSuggestions(const QString& text);
    // Demo only: what the Ctrl+L shortcut does (focus the address bar and
    // select the URL). The shortcut itself is a standard menu-action
    // shortcut; under Xvfb no window is ever active, so the key event
    // never reaches it there — the demo drives the same slot directly.
    void demoFocusAddressBar();
#endif
    // Cycle the active tab (Ctrl+Tab / Ctrl+Shift+Tab).
    void cycleTab(int direction);
    // Zoom for the current page (View menu / Ctrl +/-/0), remembered per site.
    void zoomIn();
    void zoomOut();
    void zoomReset();
    // Reopen the most recently closed tab, at its old position (Ctrl+Shift+T).
    void reopenClosedTab();
    // Find in page (Ctrl+F).
    void runFind(const QString& text, bool backward);
    void onFindClosed();
    // Downloads live in DownloadsPanel now; the window only navigates
    // to the panel when one starts.
    void showDownloadsPanel();
#ifdef VILE_DEMO
    // Demo only: close the current tab, and search the current page.
    void demoCloseCurrentTab();
    void demoFindInPage(const QString& text);
    void demoHideFindBar();
    // Demo only: start a download (opens a tab to the file's URL).
    void demoDownloadFile(const QString& url);
    bool demoHasFinishedDownload() const;
    // Demo only: pause the next download as soon as it starts (so the
    // paused state can be screenshotted without racing a fast transfer).
    void demoPauseNextDownload();  // forwards to the downloads panel
    bool demoHasPausedDownload() const;
    // Demo only: pause whatever is currently downloading (the poll drives
    // this so the pause lands mid-transfer even on a fast file).
    void demoPauseDownload();
    void demoResumeDownload();
    // Demo only: clear the finished / cancelled / interrupted rows.
    void demoClearFinishedDownloads();
    // Demo only: point downloads at a folder (writes the real setting).
    void demoSetDownloadFolder(const QString& path);
    // Demo only: turn "Ask where to save each file" on or off.
    void demoSetAskEachTime(bool on);
    void demoResetDownloadFolder();
    // Demo only: clear the address bar and give the page focus, so the
    // bar shows the current tab's URL again after the suggestions demo
    // typed into it (the bar keeps its text while it has focus).
    void demoResetAddressBar();
#endif
    // Session restore: save the open tabs (addresses + active index) to the
    // SettingsStore, and reopen them on the next launch.
    void saveSession();
    void restoreSession();
    void restoreSessionImpl();
    // Rebuild the History panel's list from the store (respects the
    // panel's search box). These guard their storage reads internally
    // — they run on the sync path, where a throw would terminate the
    // process; on failure the panel shows empty and the user is
    // warned once (warnStorageReadOnce).
    void refreshHistory();
    // Rebuild the Bookmarks panel's list from the store.
    void refreshBookmarks();
    // Bookmarks live in the tab rail: the package tile at the top
    // (a 2x2 of the sites' colours), opening into a list of the
    // saved sites in the tabs' place.
    void refreshBookmarkRail();
    void applyTabLayout();
    void refreshBookmarkBar();
    void setBookmarksOpen(bool open);
    void warnStorageReadOnce(const std::exception& e);
    // Update the address-bar star for the current tab.
    void refreshBookmarkStar();
    // Zoom plumbing: setZoom acts on the current view and persists per
    // host; applyZoomForTab runs on every URL change; refreshZoomButton
    // keeps the toolbar percentage in step with the current view.
    // Zoom state lives in the engine now (Browser::zoom/set_zoom);
    // the window only persists the per-host preference and renders
    // the indicator.
    void setZoom(double factor);
    void applyZoomForTab(vile::TabId id, const QUrl& url);
    void refreshZoomButton();
    QPushButton* zoomBtn_ = nullptr;
    QAction* zoomBtnAction_ = nullptr;
    QHash<vile::TabId, QString> zoomHostApplied_;  // per-tab host whose
                                                   // stored zoom was applied
    QAction* reloadAction_ = nullptr;
    QAction* stopAction_ = nullptr;
    // Bookmark the current tab, or remove it if already bookmarked.
    void toggleBookmark();
#ifdef VILE_DEMO
    // Demo only: bookmark the current tab (so the Bookmarks shot has one).
    void demoBookmarkCurrentTab();
#endif
    // Applies an accent color (Settings → Appearance) immediately and saves it.
    void applyTheme(const QString& themeId);
    vile::PrivacySettings settings() const { return settings_; }
    QString blocklistInfo() const { return blocklistInfo_; }
    const std::vector<vile::LocalAiProvider>& detected() const { return detected_; }
    // Late-arriving local-AI detection (probed off the UI thread after
    // the window exists, so a hung local server can't delay first paint).
    void setLocalAiProviders(std::vector<vile::LocalAiProvider> providers);

public slots:
    void syncTabs();
    void refreshShieldStats();
    void openSettings();

protected:
    void closeEvent(QCloseEvent* event) override;

private slots:
    // Chrome follow-up to a tab sync (the strip itself is the
    // TabStripController's; see onTabStripSynced in mainwindow.cpp).
    void onTabStripSynced(bool anyLoading);
    void onAddressReturn();
    void onShieldDecision(const QString& rule, const QString& url,
                          const QString& pageHost);
    // The address-bar shield badge's popup: what the Shield did on
    // this site, this session's totals, and the actions that belong
    // here (block this site, open Shield settings).
    void showShieldPopup();
    void openSettingsAt(int page);
    void onBlocklistUpdateRequested();
    void onBlocklistUpdated(bool ok, const QString& message);
    void onClearDataRequested();

private:
    void applySettings(const vile::PrivacySettings& s);
    void recreateShield();
    // Layers the user's own blocked domains over a freshly built
    // Shield (ctor + recreateShield both go through here).
    void applyUserDomains(vile::Shield& shield);
    // Constructor assembly phases, in call order (the constructor
    // itself is now wiring + the phases below).
    void buildMenus();
    // Downloads live in their own popup dialog (the side dock is
    // gone); the panel itself is unchanged.
    void buildDownloadsDialog();
    // The settings tab's page: a search bar over the embedded
    // SettingsDialog. Built by the tab strip's provider hook when
    // an about:settings tab appears.
    QWidget* buildSettingsPage();
    // Rail hover behaviour: expand to the classic list (titles) or
    // collapse back to logos only, animating the rail's width.
    void setRailExpanded(bool expanded);
    vile::TabId currentTabId() const;
    // Runs a storage-touching callable behind an error boundary: a
    // storage failure becomes a dialog, never a std::terminate.
    void guardStorage(const QString& what, const std::function<void()>& fn);
    // The local new-tab page (search box, quick links, !bang hints).
    QString newTabHtml();

    vile::Database& db_;
    vile::SettingsStore settingsStore_;
    vile::HistoryStore history_;
    vile::BookmarkStore bookmarks_;
    vile::PrivacySettings settings_;
    std::vector<vile::LocalAiProvider> detected_;
    QString dataDir_;
    QString blocklistInfo_;

    ShieldAccess shieldAccess_;  // owns the Shield snapshot + BlockLog
    std::unique_ptr<QtEngine> engine_;
    std::unique_ptr<vile::Browser> browser_;
    vile::LoopbackHttp http_;
    QPointer<SettingsDialog> settingsDialog_;

    AddressBar* addressBar_ = nullptr;  // edit + badge + star + suggestions
    QPushButton* backBtn_ = nullptr;
    QPushButton* forwardBtn_ = nullptr;
    QPushButton* reloadBtn_ = nullptr;
    QPushButton* stopBtn_ = nullptr;
    // Tab strip: a list of tabs + the stacked pages. In horizontal mode the
    // list is a bar above the pages; in vertical mode it is a list on the
    // left. One widget pair serves both, so there is no second tab widget
    // to keep in sync.
    QWidget* tabArea_ = nullptr;
    QWidget* tabStrip_ = nullptr;  // the slim rail container (layout host)
    // The strip's list, page stack and tab sync live in the controller.
    TabStripController* tabStripCtl_ = nullptr;
    QPushButton* newTabBtn_ = nullptr;
    QPushButton* bookmarkPackBtn_ = nullptr;
    QListWidget* bookmarkList_ = nullptr;
    QPushButton* bookmarkCloseBtn_ = nullptr;  // the small ^ fold-shut button
    // Top (Chrome-style) layout: a tab bar above the toolbar and a
    // bookmarks bar below it, used when vertical tabs are off. The
    // tab list and + button MOVE between the rail and the tab bar.
    QToolBar* topTabBar_ = nullptr;
    QToolBar* bookmarkBar_ = nullptr;
    QWidget* bookmarkBarBox_ = nullptr;
    QAction* topListAction_ = nullptr;
    QAction* topNewAction_ = nullptr;
    QVBoxLayout* railLayout_ = nullptr;
    bool bookmarksOpen_ = false;
    QPushButton* settingsBtn_ = nullptr;   // toolbar gear: opens the Settings tab
    QPushButton* downloadsBtn_ = nullptr;  // toolbar button: opens Downloads
    // Every button whose icon is a palette-coloured pixmap drawn
    // once at construction (nav + rail). A live theme switch
    // re-draws them all (round 13, finding T1).
    QList<QPair<QAbstractButton*, icons::Kind>> themedIcons_;
    QStringList appliedUserDomains_;
    QProgressBar* loadLine_ = nullptr;  // 2px load line over the page stack
    // Shield bookkeeping for the badge popup (the status bar that
    // used to show these is gone — the page gets the whole height).
    QMap<QString, int> blockedByHost_;
    qlonglong sessionBlocked_ = 0;
    qlonglong shieldRules_ = 0;
    int pendingSettingsPage_ = -1;  // page to show when the tab opens
    QWidget* scrim_ = nullptr;  // dims the window behind modal dialogs
    void showScrim();
    void hideScrim();
    QTimer* shieldStatsTimer_ = nullptr;  // debounces Shield-stats refreshes
    QTimer* railPoll_ = nullptr;     // watches the pointer vs the rail
    bool railExpanded_ = false;      // the rail's current hover state
    qint64 railLastInsideMs_ = 0;    // last poll with the pointer inside
    QAction* reopenTabAct_ = nullptr;        // File menu, enabled when a tab can reopen
    FindBar* findBar_ = nullptr;  // bottom find-in-page bar
    // Downloads: the panel owns the rows, the requests and the empty
    // state; the window hosts it in a popup dialog and navigates to
    // it when a download starts.
    DownloadsPanel* downloadsPanel_ = nullptr;
    QDialog* downloadsDialog_ = nullptr;
    SessionStore* session_ = nullptr;  // owns session save/restore (qt/sessionstore.*)
    bool storageReadWarned_ = false;  // same, for panel history/bookmark reads
    bool closing_ = false;      // set in closeEvent: stop saving while tabs are torn down
};
