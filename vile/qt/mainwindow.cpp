#include "mainwindow.h"

#include <QAction>
#include <QApplication>
#include <QButtonGroup>
#include <QCloseEvent>
#include <QCursor>
#include <QDesktopServices>
#include <QDir>
#include <QDockWidget>
#include <QEvent>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QGraphicsOpacityEffect>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QIcon>
#include <QKeyEvent>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QPainter>
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QDateTime>
#include <QDialog>

#include "cleardatadialog.h"
#include <QMouseEvent>
#include <QPointer>
#include <QPixmap>
#include <QProgressBar>
#include <QPropertyAnimation>
#include <QPushButton>
#include <QStyle>
#include <QStackedWidget>
#include <QStandardPaths>
#include <QStatusBar>
#include <QTabBar>
#include <QTabWidget>
#include <QTextEdit>
#include <QTime>
#include <QTimer>
#include <QToolBar>
#include <QUrl>
#include <QToolButton>
#include <QVBoxLayout>
#include <QWebEngineDownloadRequest>
#include <QWebEngineFindTextResult>
#include <QWebEnginePage>
#include <QWebEngineView>

#include "blocklist.h"
#include "sessionstore.h"
#include "assistantpanel.h"
#include "downloadspanel.h"
#include "bookmarkspanel.h"
#include "historypanel.h"
#include "privacypanel.h"
#include "faviconstore.h"
#include "ntppage.h"
#include "tabstripcontroller.h"
#include "icons.h"
#include "settingsdialog.h"
#include "bangcolors.h"
#include "theme.h"
#include "uisettings.h"
#include "vile/search_engines.hpp"
#include "vile/url.hpp"

using namespace vile;

namespace {
// The host a search engine's template lives on, for the address
// bar's "Search for ..." suggestion row (it wears the engine's
// favicon). ONE derivation for both call sites — the constructor
// and applySettings (round 16: the port had it twice, the drift
// genus this codebase keeps stamping out).
QString searchEngineHost(const SearchEngine& e) {
    return QUrl(QString::fromStdString(e.url_template)
                    .replace(QStringLiteral("{q}"), QStringLiteral("x")))
        .host();
}
}  // namespace

MainWindow::MainWindow(Database& db, PrivacySettings settings,
                       const std::vector<LocalAiProvider>& detected, const QString& dataDir,
                       QWidget* parent)
    : QMainWindow(parent),
      db_(db),
      settingsStore_(db),
      history_(db),
      bookmarks_(db),
      settings_(settings),
      detected_(detected),
      dataDir_(dataDir) {
    setWindowTitle(tr("VILE — private browser"));
    resize(1280, 800);

    // ---- backend wiring (INTEGRATION.md §2 start-up order) ----
    // The Shield is published as an immutable snapshot (see
    // ShieldAccess): the IO thread checks requests against it lock-free.
    {
        auto shield = std::make_shared<Shield>(settings_);
        blocklist::load(*shield, dataDir_, &blocklistInfo_);
        applyUserDomains(*shield);
        shieldAccess_.shield.store(std::move(shield));
    }

    engine_ = std::make_unique<QtEngine>(dataDir_, &shieldAccess_, this);
    connect(&engine_->favicons(), &FaviconStore::faviconReady, this,
            [this](const QString&) {
                // A fresh site logo landed: the tab rail's rows pick
                // it up on the next sync.
                if (tabStripCtl_) tabStripCtl_->requestSync();
            });
    connect(&engine_->favicons(), &FaviconStore::cleared, this,
            [this] { if (tabStripCtl_) tabStripCtl_->requestSync(); });
    connect(&engine_->favicons(), &FaviconStore::faviconReady, this,
            [this](const QString&) { refreshBookmarkRail(); });
    connect(engine_.get(), &QtEngine::shieldDecision, this, &MainWindow::onShieldDecision,
            Qt::QueuedConnection);
    browser_ = std::make_unique<Browser>(*engine_, &history_);
    session_ = new SessionStore(settingsStore_, *browser_, this);
    connect(session_, &SessionStore::storageWarning, this, [this](const QString& msg) {
        QMessageBox::warning(this, tr("Storage problem"), msg);
    });
    browser_->set_private_mode(!settings_.save_history);
    // Guarded like applySettings: PrivacySettings::load validates the
    // stored id, but the ctor should not dereference on that promise.
    if (const SearchEngine* e = find_search_engine(settings_.search_engine_id))
        browser_->set_search_engine(*e);
    browser_->on_tabs_changed = [this] {
        // The controller coalesces bursts itself. (It is created a
        // little later in this constructor; tab changes only start
        // once tabs exist, which is after that.)
        if (tabStripCtl_) tabStripCtl_->requestSync();
    };

    buildMenus();
    // ---- toolbar: navigation + address bar ----
    auto* nav = new QToolBar(this);
    nav->setObjectName(QStringLiteral("navigationBar"));
    nav->setMovable(false);
    nav->setFloatable(false);
    addToolBar(nav);
    backBtn_ = new QPushButton;
    backBtn_->setIcon(icons::icon(icons::Kind::ChevronLeft));
    forwardBtn_ = new QPushButton;
    forwardBtn_->setIcon(icons::icon(icons::Kind::ChevronRight));
    reloadBtn_ = new QPushButton;
    reloadBtn_->setIcon(icons::icon(icons::Kind::Reload));
    stopBtn_ = new QPushButton;
    stopBtn_->setIcon(icons::icon(icons::Kind::Close));
    themedIcons_ += {{backBtn_, icons::Kind::ChevronLeft},
                     {forwardBtn_, icons::Kind::ChevronRight},
                     {reloadBtn_, icons::Kind::Reload},
                     {stopBtn_, icons::Kind::Close}};
    backBtn_->setToolTip(tr("Go back"));
    forwardBtn_->setToolTip(tr("Go forward"));
    reloadBtn_->setToolTip(tr("Reload page"));
    stopBtn_->setToolTip(tr("Stop loading"));
    for (auto* b : {backBtn_, forwardBtn_, reloadBtn_, stopBtn_}) {
        b->setObjectName(QStringLiteral("navButton"));
        b->setFixedSize(34, 34);
        b->setIconSize(QSize(18, 18));
        QAction* a = nav->addWidget(b);
        // Reload and Stop share one slot (see syncTabs); toolbar
        // visibility must go through the QAction, not the widget.
        if (b == reloadBtn_) reloadAction_ = a;
        if (b == stopBtn_) stopAction_ = a;
    }
    if (stopAction_) stopAction_->setVisible(false);
    addressBar_ = new AddressBar(this);
    addressBar_->setSearchEngineName(
        QString::fromStdString(browser_->search_engine().name));
    // Suggestion rows wear real site logos when the favicon store
    // has them (the user's design): the provider answers from the
    // store live, and the engine host lets the "Search for ..." row
    // wear the search engine's own mark.
    addressBar_->setSearchEngineHost(searchEngineHost(browser_->search_engine()));
    addressBar_->setIconProvider([this](const QString& host) {
        return engine_->favicons().has(host)
                   ? engine_->favicons().pixmap(host, 32)
                   : QPixmap();
    });
    addressBar_->setHistoryProvider([this](const QString& q) {
        // Guarded like the panels' reads: suggestions must never
        // throw out of a text-changed signal.
        std::vector<std::pair<QString, QString>> out;
        try {
            for (const auto& e : history_.search(q.toStdString(), 5)) {
                QString title = QString::fromStdString(e.title);
                if (title.isEmpty()) title = QString::fromStdString(e.url);
                out.emplace_back(title, QString::fromStdString(e.url));
            }
        } catch (const std::exception& e) {
            warnStorageReadOnce(e);
        }
        return out;
    });
    connect(addressBar_, &AddressBar::submitted, this, &MainWindow::onAddressReturn);
    connect(addressBar_, &AddressBar::bookmarkClicked, this, &MainWindow::toggleBookmark);
    connect(addressBar_, &AddressBar::shieldClicked, this, &MainWindow::showShieldPopup);
    // In the settings tab the blocked-sites editor writes straight
    // to UiSettings (no OK to catch it on the way out any more).
    connect(&uiSettings(), &UiSettings::changed, this, [this](const QString& key) {
        if (key == uisettings_keys::kUserDomains && settingsDialog_ &&
            uiSettings().userBlockedDomains() != appliedUserDomains_)
            recreateShield();
        if (key == uisettings_keys::kNtpTiles) refreshBookmarkRail();
        if (key == uisettings_keys::kVerticalTabs) applyTabLayout();
    });
    nav->addWidget(addressBar_);
    // Zoom indicator: appears next to the address bar only while the
    // current page is zoomed; clicking it resets to 100%. NOTE: visibility
    // must go through the QAction that QToolBar::addWidget returns — a
    // widget hidden before being added keeps an invisible action and the
    // toolbar never lays it out, no matter how often it is show()n later.
    zoomBtn_ = new QPushButton(this);
    zoomBtn_->setObjectName(QStringLiteral("zoomChip"));
    zoomBtn_->setToolTip(tr("Reset zoom (Ctrl+0)"));
    connect(zoomBtn_, &QPushButton::clicked, this, &MainWindow::zoomReset);
    zoomBtnAction_ = nav->addWidget(zoomBtn_);
    zoomBtnAction_->setVisible(false);
    downloadsBtn_ = new QPushButton;
    downloadsBtn_->setIcon(icons::icon(icons::Kind::Download));
    downloadsBtn_->setObjectName(QStringLiteral("navButton"));
    downloadsBtn_->setFixedSize(34, 34);
    downloadsBtn_->setIconSize(QSize(18, 18));
    downloadsBtn_->setToolTip(tr("Downloads"));
    themedIcons_ += {{downloadsBtn_, icons::Kind::Download}};
    nav->addWidget(downloadsBtn_);
    connect(downloadsBtn_, &QPushButton::clicked, this,
            &MainWindow::showDownloadsPanel);
    settingsBtn_ = new QPushButton;
    settingsBtn_->setIcon(icons::icon(icons::Kind::Sliders));
    settingsBtn_->setObjectName(QStringLiteral("navButton"));
    settingsBtn_->setFixedSize(34, 34);
    settingsBtn_->setIconSize(QSize(18, 18));
    settingsBtn_->setToolTip(tr("Settings"));
    themedIcons_.append({settingsBtn_, icons::Kind::Sliders});
    nav->addWidget(settingsBtn_);
    connect(settingsBtn_, &QPushButton::clicked, this, &MainWindow::openSettings);
    connect(backBtn_, &QPushButton::clicked, this, [this] {
        if (auto id = currentTabId()) browser_->back(id);
    });
    connect(forwardBtn_, &QPushButton::clicked, this, [this] {
        if (auto id = currentTabId()) browser_->forward(id);
    });
    connect(reloadBtn_, &QPushButton::clicked, this, [this] {
        if (auto id = currentTabId()) browser_->reload(id);
    });
    connect(stopBtn_, &QPushButton::clicked, this, [this] {
        if (auto id = currentTabId()) browser_->stop(id);
    });

    // ---- tab strip: a list of tabs + the stacked pages ----
    // One list serves both layouts (Helium-style vertical tabs): in
    // horizontal mode it is a bar above the pages, in vertical mode a list
    // on the left. QTabWidget can't do that — its vertical tabs rotate the
    // text 90 degrees.
    tabArea_ = new QWidget(this);
    tabStrip_ = new QWidget(tabArea_);
    // The tab strip + page stack belong to the TabStripController: it
    // creates both widgets (the list inside tabStrip_, the stack inside
    // tabArea_) and owns the whole tab sync, spinner and context menu.
    tabStripCtl_ = new TabStripController(*browser_, *engine_, tabStrip_, tabArea_, this);
    tabStripCtl_->setBlankPageHtmlProvider([this] { return newTabHtml(); });
    tabStripCtl_->setSettingsPageProvider([this] { return buildSettingsPage(); });
    connect(tabStripCtl_, &TabStripController::synced, this, &MainWindow::onTabStripSynced);
    connect(tabStripCtl_, &TabStripController::loadProgressChanged, this,
            [this](int p) {
                loadLine_->setVisible(p < 100);
                loadLine_->setValue(p);
            });
    connect(tabStripCtl_, &TabStripController::viewUrlChanged, this,
            [this](TabId id, const QUrl& u) { applyZoomForTab(id, u); });
    newTabBtn_ = new QPushButton(tabStrip_);
    newTabBtn_->setObjectName(QStringLiteral("navButton"));
    newTabBtn_->setIcon(icons::icon(icons::Kind::Plus));
    newTabBtn_->setIconSize(QSize(18, 18));
    newTabBtn_->setFixedSize(52, 44);
    newTabBtn_->setToolTip(tr("New tab"));
    themedIcons_.append({newTabBtn_, icons::Kind::Plus});
    connect(newTabBtn_, &QPushButton::clicked, this, [this] { browser_->open_tab(); });
    // Shield stats debounce (see onShieldDecision).
    shieldStatsTimer_ = new QTimer(this);
    shieldStatsTimer_->setSingleShot(true);
    shieldStatsTimer_->setInterval(250);
    connect(shieldStatsTimer_, &QTimer::timeout, this, &MainWindow::refreshShieldStats);
    // Find in page (Ctrl+F): a slim bar at the bottom of the tab area.
    findBar_ = new FindBar(tabArea_);
    connect(findBar_, &FindBar::findRequested, this,
            [this](const QString& text, bool backward) { runFind(text, backward); });
    connect(findBar_, &FindBar::closed, this, &MainWindow::onFindClosed);
    // ---- the tab rail: a slim column of site logos on the left ----
    // Brave's collapsed vertical tabs are the model: one logo per
    // tab stacked down the left edge, a + for a new tab at the
    // bottom, the Settings gear in the toolbar. No side panels, no
    // sidebar sections — the page gets everything else.
    tabStrip_->setObjectName(QStringLiteral("tabRail"));
    tabStrip_->setFixedWidth(64);
    auto* railLayout = new QVBoxLayout(tabStrip_);
    railLayout_ = railLayout;
    railLayout->setContentsMargins(6, 8, 6, 8);
    railLayout->setSpacing(6);
    tabStripCtl_->list()->setFlow(QListView::TopToBottom);
    tabStripCtl_->list()->setWrapping(false);
    tabStripCtl_->list()->setProperty("vertical", true);
    tabStripCtl_->setSlim(true);
    // The bookmarks package sits at the TOP of the rail, above
    // the tabs (bookmarks belong with the tabs, not on the new tab
    // page — the user's call): one tile of colour squares that
    // swaps the tab list for the bookmark rows when clicked.
    bookmarkPackBtn_ = new QPushButton(tabStrip_);
    bookmarkPackBtn_->setObjectName(QStringLiteral("navButton"));
    bookmarkPackBtn_->setFixedSize(52, 44);
    bookmarkPackBtn_->setIconSize(QSize(40, 40));
    connect(bookmarkPackBtn_, &QPushButton::clicked, this,
            [this] { setBookmarksOpen(!bookmarksOpen_); });
    railLayout->addWidget(bookmarkPackBtn_);
    bookmarkList_ = new QListWidget(tabStrip_);
    bookmarkList_->setObjectName(QStringLiteral("bookmarkList"));
    bookmarkList_->setProperty("vertical", true);
    bookmarkList_->setFlow(QListView::TopToBottom);
    bookmarkList_->setWrapping(false);
    bookmarkList_->hide();
    railLayout->addWidget(bookmarkList_, 1);
    railLayout->setAlignment(bookmarkList_, Qt::AlignTop);
    connect(bookmarkList_, &QListWidget::itemClicked, this,
            [this](QListWidgetItem* item) {
                const QString url = item->data(Qt::UserRole).toString();
                setBookmarksOpen(false);
                if (!url.isEmpty()) browser_->open_tab(url.toStdString());
            });
    refreshBookmarkRail();
    railLayout->addWidget(tabStripCtl_->list(), 1);
    railLayout->addWidget(newTabBtn_);
    // The fold-shut button: a small ^ under the open bookmarks
    // (hidden unless the package is open — inserted between the
    // bookmark list and the tab list).
    bookmarkCloseBtn_ = new QPushButton(tabStrip_);
    bookmarkCloseBtn_->setObjectName(QStringLiteral("navButton"));
    bookmarkCloseBtn_->setFixedSize(52, 32);
    bookmarkCloseBtn_->setToolTip(tr("Close bookmarks"));
    connect(bookmarkCloseBtn_, &QPushButton::clicked, this,
            [this] { setBookmarksOpen(false); });
    bookmarkCloseBtn_->hide();
    railLayout->insertWidget(2, bookmarkCloseBtn_);
    // Pin the list to the top of its (stretch) slot: capped at its
    // content height in expanded mode, it would otherwise centre
    // itself in the slot the stretch factor reserves for it.
    railLayout->setAlignment(tabStripCtl_->list(), Qt::AlignTop);
    // Hovering the rail expands it (tab titles appear); it collapses
    // again a beat after the pointer leaves. A slow poll drives it:
    // simpler and more reliable than chasing Enter/Leave events
    // across every child widget of the rail.
    railPoll_ = new QTimer(this);
    railPoll_->setInterval(120);
    connect(railPoll_, &QTimer::timeout, this, [this] {
        if (!uiSettings().railHoverExpand()) {
            if (railExpanded_) setRailExpanded(false);
            return;
        }
        const bool inside = tabStrip_->rect().contains(
            tabStrip_->mapFromGlobal(QCursor::pos()));
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        if (inside) {
            railLastInsideMs_ = now;
            // While the bookmarks package is open the rail stays
            // slim: the tiles line up as they are — no expansion,
            // no names, no extra space.
            if (!railExpanded_ && !bookmarksOpen_) setRailExpanded(true);
        } else if (railExpanded_ &&
                   now - railLastInsideMs_ >= uiSettings().railCollapseDelayMs()) {
            setRailExpanded(false);
        }
    });
    railPoll_->start();
    auto* areaLayout = new QHBoxLayout(tabArea_);
    areaLayout->setContentsMargins(0, 0, 0, 0);
    areaLayout->setSpacing(0);
    areaLayout->addWidget(tabStrip_);
    loadLine_ = new QProgressBar(tabArea_);
    loadLine_->setObjectName(QStringLiteral("loadLine"));
    loadLine_->setFixedHeight(2);
    loadLine_->setTextVisible(false);
    loadLine_->setRange(0, 100);
    loadLine_->setVisible(false);
    auto* stackCol = new QVBoxLayout;
    stackCol->setContentsMargins(0, 0, 0, 0);
    stackCol->setSpacing(0);
    stackCol->addWidget(loadLine_);
    stackCol->addWidget(tabStripCtl_->stack(), 1);
    areaLayout->addLayout(stackCol, 1);
    areaLayout->addWidget(findBar_);
    setCentralWidget(tabArea_);

    buildDownloadsDialog();
    // No status bar: it sandwiched every page between dark strips
    // and made the browser feel like a frame around a square. The
    // Shield line moved into the address-bar shield popup, and the
    // load progress is a 2px line over the page stack (loadLine_).
    statusBar()->hide();

    // ---- the top (Chrome-style) bars, hidden unless vertical
    // tabs are off: tab bar ABOVE the navigation toolbar, bookmarks
    // bar below it. The tab list and + button move between the rail
    // and the tab bar in applyTabLayout().
    topTabBar_ = new QToolBar(this);
    topTabBar_->setObjectName(QStringLiteral("tabBar"));
    topTabBar_->setMovable(false);
    topTabBar_->setFloatable(false);
    topTabBar_->setAllowedAreas(Qt::TopToolBarArea);
    insertToolBar(nav, topTabBar_);
    // Own ROW: without a break the tab bar, navigation bar and
    // bookmarks bar all flow into one shared row and squeeze each
    // other off the window.
    insertToolBarBreak(nav);
    topTabBar_->hide();
    bookmarkBar_ = new QToolBar(this);
    bookmarkBar_->setObjectName(QStringLiteral("bookmarkBar"));
    bookmarkBar_->setMovable(false);
    bookmarkBar_->setFloatable(false);
    bookmarkBar_->setAllowedAreas(Qt::TopToolBarArea);
    addToolBar(bookmarkBar_);
    insertToolBarBreak(bookmarkBar_);
    bookmarkBarBox_ = new QWidget(bookmarkBar_);
    auto* bookmarkBarLay = new QHBoxLayout(bookmarkBarBox_);
    bookmarkBarLay->setContentsMargins(0, 0, 0, 0);
    bookmarkBarLay->setSpacing(2);
    bookmarkBar_->addWidget(bookmarkBarBox_);
    bookmarkBar_->hide();
    applyTabLayout();

    refreshShieldStats();
    if (downloadsPanel_) downloadsPanel_->refreshEmptyNote();
    // No explicit first tab here: the strip's zero-tab guard opens
    // one on its first sync, and restoreSession() below reuses that
    // blank tab for the first saved URL. (Opening one here as well
    // raced the guard and started the app with TWO blank tabs.)
    restoreSession();
    if (browser_->tabs().empty()) browser_->open_tab();
    // Save the session on every quit path, including app.quit() (which does
    // not fire closeEvent). closeEvent saves first and sets closing_, so
    // this is skipped when the window already closed cleanly.
    connect(QApplication::instance(), &QCoreApplication::aboutToQuit, this,
            [this] {
                if (!closing_) saveSession();
            });
}

void MainWindow::buildMenus() {
    // ---- menus ----
    auto* fileMenu = menuBar()->addMenu(tr("&File"));
    fileMenu->addAction(tr("New tab"), QKeySequence::AddTab, [this] { browser_->open_tab(); });
    fileMenu->addAction(tr("Close tab"), QKeySequence::Close, [this] {
        if (auto id = currentTabId()) browser_->close_tab(id);
    });
    auto* bookmarkAct = fileMenu->addAction(tr("Bookmark this page"));
    bookmarkAct->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_D));
    bookmarkAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(bookmarkAct, &QAction::triggered, this, &MainWindow::toggleBookmark);
    reopenTabAct_ = fileMenu->addAction(tr("Reopen closed tab"));
    reopenTabAct_->setShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_T));
    reopenTabAct_->setShortcutContext(Qt::ApplicationShortcut);
    reopenTabAct_->setEnabled(false);
    connect(reopenTabAct_, &QAction::triggered, this, &MainWindow::reopenClosedTab);
    fileMenu->addSeparator();
    fileMenu->addAction(tr("Settings…"), QKeySequence::Preferences, this,
                        &MainWindow::openSettings);
    fileMenu->addSeparator();
    fileMenu->addAction(tr("Quit"), QKeySequence::Quit, this, &QWidget::close);
    auto* viewMenu = menuBar()->addMenu(tr("&View"));
    // Ctrl+T / Ctrl+W already live on the File menu; these complete the set.
    // ApplicationShortcut so they fire even when a dock or the page has
    // focus (and so the scripted demo can drive them without a window
    // manager making the window active).
    auto* focusBarAct = viewMenu->addAction(tr("Focus address bar"));
    focusBarAct->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_L));
    focusBarAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(focusBarAct, &QAction::triggered, this, [this] {
        addressBar_->focusBar();
    });
    auto* reloadAct = viewMenu->addAction(tr("Reload"));
    reloadAct->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_R));
    reloadAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(reloadAct, &QAction::triggered, this, [this] {
        if (auto id = currentTabId()) browser_->reload(id);
    });
    auto* nextTabAct = viewMenu->addAction(tr("Next tab"));
    nextTabAct->setShortcut(QKeySequence::NextChild);
    nextTabAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(nextTabAct, &QAction::triggered, this, [this] { cycleTab(1); });
    auto* prevTabAct = viewMenu->addAction(tr("Previous tab"));
    prevTabAct->setShortcut(QKeySequence::PreviousChild);
    prevTabAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(prevTabAct, &QAction::triggered, this, [this] { cycleTab(-1); });
    auto* findAct = viewMenu->addAction(tr("Find in page"));
    findAct->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_F));
    findAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(findAct, &QAction::triggered, this,
            [this] { if (findBar_) findBar_->showBar(); });
    viewMenu->addSeparator();
    auto* zoomInAct = viewMenu->addAction(tr("Zoom in"));
    zoomInAct->setShortcut(QKeySequence::ZoomIn);
    zoomInAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(zoomInAct, &QAction::triggered, this, &MainWindow::zoomIn);
    auto* zoomOutAct = viewMenu->addAction(tr("Zoom out"));
    zoomOutAct->setShortcut(QKeySequence::ZoomOut);
    zoomOutAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(zoomOutAct, &QAction::triggered, this, &MainWindow::zoomOut);
    auto* zoomResetAct = viewMenu->addAction(tr("Reset zoom"));
    zoomResetAct->setShortcut(QKeySequence(Qt::CTRL | Qt::Key_0));
    zoomResetAct->setShortcutContext(Qt::ApplicationShortcut);
    connect(zoomResetAct, &QAction::triggered, this, &MainWindow::zoomReset);
    auto* helpMenu = menuBar()->addMenu(tr("&Help"));
    helpMenu->addAction(tr("About VILE"), [this] {
        QMessageBox::about(
            this, tr("About VILE"),
            tr("VILE 0.1.0 — a private browser.\n\n"
               "Tabs, Shield tracker blocking, SQLite history and a read-only "
               "on-device AI page assistant. The AI only talks to 127.0.0.1 and "
               "never clicks, navigates or runs anything."));
    });

}

void MainWindow::buildDownloadsDialog() {
    // The Downloads panel is unchanged — rows, destination policy,
    // pause/resume — but with the side dock gone it lives in its own
    // popup: it appears when a download starts and from the toolbar's
    // Downloads button.
    downloadsPanel_ = new DownloadsPanel;
    downloadsPanel_->setModalHooks([this] { showScrim(); },
                                   [this] { hideScrim(); });
    connect(engine_.get(), &QtEngine::downloadRequested, downloadsPanel_,
            &DownloadsPanel::addDownload);
    connect(downloadsPanel_, &DownloadsPanel::downloadStarted, this,
            &MainWindow::showDownloadsPanel);
    connect(downloadsPanel_, &DownloadsPanel::downloadDiverted, this,
            [this](const QString& name) {
                statusBar()->showMessage(
                    tr("A save dialog was already open, so %1 went to your "
                       "downloads folder instead.")
                        .arg(name),
                    8000);
            });
    // UiSettings::changed has a real consumer: when the downloads
    // folder changes (Settings writes it live), the panel's
    // empty-state line names the new folder immediately.
    connect(&uiSettings(), &UiSettings::changed, downloadsPanel_,
            [panel = downloadsPanel_](const QString& key) {
                if (key == uisettings_keys::kDownloadsFolder)
                    panel->refreshEmptyNote();
            });
    downloadsDialog_ = new QDialog(this);
    downloadsDialog_->setWindowTitle(tr("Downloads"));
    downloadsDialog_->resize(400, 480);
    auto* lay = new QVBoxLayout(downloadsDialog_);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->addWidget(downloadsPanel_);
}

MainWindow::~MainWindow() = default;








void MainWindow::onAddressReturn() {
    addressBar_->hideSuggestions();
    QString text = addressBar_->text().trimmed();
    if (text.isEmpty()) return;
    // The settings page is a tab, not a loadable URL: asking for it
    // by address opens (or focuses) the tab, like vile://settings
    // in the bar suggests.
    const QString lowered = text.toLower();
    if (lowered == QStringLiteral("vile://settings") ||
        lowered == QStringLiteral("about:settings")) {
        openSettings();
        return;
    }
    if (TabId id = currentTabId()) {
        if (!browser_->navigate(id, text.toStdString())) {
            statusBar()->showMessage(tr("That address was rejected (unsafe scheme)."), 4000);
        }
    } else {
        browser_->open_tab(text.toStdString());
    }
}

// (No MainWindow::eventFilter: tab-title re-elision lives in
// TabStripController::eventFilter, which installs itself on the
// title labels. A duplicate implementation sat here unused until
// round 12's architecture review removed it.)








void MainWindow::guardStorage(const QString& what, const std::function<void()>& fn) {
    try {
        fn();
    } catch (const std::exception& e) {
        QMessageBox::warning(
            this, tr("Storage problem"),
            tr("%1 failed: %2\n\nThe rest of your data is untouched.")
                .arg(what, QString::fromUtf8(e.what())));
    }
}



void MainWindow::saveSession() {
    // The work lives in SessionStore (qt/sessionstore.*): guarded,
    // transactional, history-gated. This forwarder stays because sync
    // paths, closeEvent, aboutToQuit and the UI tests call it here.
    if (session_) session_->save(settings_.save_history);
}

void MainWindow::restoreSession() {
    // Guarded internally for the same reason as saveSession: this runs
    // from the constructor, where a storage exception would terminate
    // the process before the window ever appears. On failure the browser
    // simply starts with a fresh tab.
    try {
        restoreSessionImpl();
    } catch (const std::exception& e) {
        qWarning("VILE: session restore failed (%s); starting fresh", e.what());
    }
}

void MainWindow::restoreSessionImpl() {
    int activeIdx = 0;
    const std::vector<std::string> urls =
        session_->savedTabs(settings_.save_history, uiSettings().restoreSession(),
                            &activeIdx);
    bool first = true;
    for (const std::string& url : urls) {
        if (first && browser_->tabs().size() == 1 &&
            browser_->tabs().front().url == "about:blank") {
            // Reuse the blank tab the window just opened.
            if (!url.empty() && url != "about:blank")
                browser_->navigate(browser_->tabs().front().id, url);
        } else {
            browser_->open_tab(url.empty() ? "about:blank" : url);
        }
        first = false;
    }
    const auto& tabs = browser_->tabs();
    if (activeIdx >= 0 && activeIdx < static_cast<int>(tabs.size()))
        browser_->activate(tabs[activeIdx].id);
}


// The chrome that follows a tab sync — the TabStripController owns the
// strip itself now; what remains here is everything that is NOT the
// strip: address bar, title, nav buttons, the Stop/Reload swap, the
// live panels, the session save.
void MainWindow::setLocalAiProviders(std::vector<vile::LocalAiProvider> providers) {
    // The Assistant panel is gone with the side dock; the detected
    // providers still feed the Settings dialog's Local AI page.
    detected_ = std::move(providers);
}

void MainWindow::onTabStripSynced(bool anyLoading) {
    // In the top layout the tab list is sized to its content (so
    // the + button hugs the last tab): re-ask its width whenever
    // the tab set changes.
    if (!uiSettings().verticalTabs()) tabStripCtl_->list()->updateGeometry();
    // The per-tab zoom-host map must not grow for the window's whole
    // life: drop entries for tabs that no longer exist.
    if (browser_ && zoomHostApplied_.size() > 64) {
        QHash<vile::TabId, QString> live;
        for (const vile::Tab& t : browser_->tabs())
            if (zoomHostApplied_.contains(t.id)) live.insert(t.id, zoomHostApplied_.value(t.id));
        zoomHostApplied_ = live;
    }
    if (const Tab* t = browser_->find(currentTabId())) {
        {
            // A settings tab shows its friendly URL, not the
            // internal one Chromium rewrote it to.
            const QString urlText =
                tabStripCtl_->isSettingsTab(t->id)
                    ? QStringLiteral("vile://settings")
                    : QString::fromStdString(t->url);
            addressBar_->setDisplayText(urlText == QStringLiteral("about:blank")
                                            ? QString()
                                            : urlText);
        }
        backBtn_->setEnabled(browser_->can_go_back(t->id));
        forwardBtn_->setEnabled(browser_->can_go_forward(t->id));
        QString title = QString::fromStdString(t->title);
        setWindowTitle(title.isEmpty() ? tr("VILE — private browser")
                                       : title + QStringLiteral(" — VILE"));
    }
    // Reload and Stop share one toolbar slot: Stop only while a page loads.
    if (stopAction_) stopAction_->setVisible(anyLoading);
    if (reloadAction_) reloadAction_->setVisible(!anyLoading);
    // The address-bar star and the zoom chip follow the current tab.
    refreshBookmarkStar();
    refreshZoomButton();
    // Keep the saved session current (skipped while closing, and while a
    // tab is mid-restore — saveSession defers then).
    if (!closing_) saveSession();
    if (reopenTabAct_) reopenTabAct_->setEnabled(tabStripCtl_ && tabStripCtl_->hasClosedTabs());
}

TabId MainWindow::currentTabId() const {
    return tabStripCtl_ ? tabStripCtl_->currentTabId() : 0;
}

void MainWindow::cycleTab(int direction) {
    if (tabStripCtl_) tabStripCtl_->cycleTab(direction);
}

void MainWindow::reopenClosedTab() {
    if (tabStripCtl_) tabStripCtl_->reopenClosedTab();
}

void MainWindow::syncTabs() {
    if (tabStripCtl_) tabStripCtl_->syncNow();
}

void MainWindow::runFind(const QString& q, bool backward) {
    const TabId id = currentTabId();
    if (q.isEmpty() || !id) {
        if (findBar_) findBar_->clearResult();
        return;
    }
    // Through the core/engine port — the window never touches the
    // widget for page operations anymore.
    browser_->find_text(id, q.toStdString(), backward,
                        [this](int active, int total) {
                            if (findBar_) findBar_->setResult(active, total);
                        });
}

void MainWindow::onFindClosed() {
    if (TabId id = currentTabId()) {
        browser_->find_text(id, "", false, nullptr);  // clear the find state
        tabStripCtl_->focusCurrentPage();
    }
}




void MainWindow::showDownloadsPanel() {
    if (!downloadsDialog_) return;
    downloadsDialog_->show();
    downloadsDialog_->raise();
    downloadsDialog_->activateWindow();
}
































// The standard zoom ladder, as factors (1.0 = 100%).
static const double kZoomLevels[] = {0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0,
                                     1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0};

void MainWindow::zoomIn() {
    if (const TabId id = currentTabId()) {
        const double cur = browser_->zoom(id);
        for (double level : kZoomLevels)
            if (level > cur + 0.001) {
                setZoom(level);
                return;
            }
    }
}

void MainWindow::zoomOut() {
    if (currentTabId()) {
        const double cur = browser_->zoom(currentTabId());
        double prev = kZoomLevels[0];
        for (double level : kZoomLevels) {
            if (level >= cur - 0.001) break;
            prev = level;
        }
        setZoom(prev);
    }
}

void MainWindow::zoomReset() { setZoom(1.0); }

void MainWindow::setZoom(double factor) {
    const TabId id = currentTabId();
    if (!id) return;
    browser_->set_zoom(id, factor);  // the engine owns the factor now
    // Remember per site (host). 100% is the default, so it clears the entry.
    if (const vile::Tab* tab = browser_->find(id)) {
        const QString host = QUrl(QString::fromStdString(tab->url)).host();
        if (!host.isEmpty()) uiSettings().setZoomForHost(host, factor);
    }
    refreshZoomButton();
}

void MainWindow::applyZoomForTab(TabId id, const QUrl& url) {
    const QString host = url.host();
    if (zoomHostApplied_.value(id) == host) return;
    zoomHostApplied_[id] = host;
    if (host.isEmpty()) return;
    browser_->set_zoom(id, uiSettings().zoomForHost(host));
    if (id == currentTabId()) refreshZoomButton();
}

void MainWindow::refreshZoomButton() {
    if (!zoomBtn_ || !zoomBtnAction_) return;
    const double f = browser_->zoom(currentTabId());
    if (qAbs(f - 1.0) < 0.01) {
        zoomBtnAction_->setVisible(false);
        return;
    }
    zoomBtn_->setText(QStringLiteral("%1%").arg(qRound(f * 100)));
    zoomBtnAction_->setVisible(true);
}

void MainWindow::warnStorageReadOnce(const std::exception& e) {
    // Panel reads run on the tab-sync path, where a storage failure
    // must neither terminate the process nor spam a dialog per sync:
    // warn exactly once, then let the panels show empty.
    if (storageReadWarned_) return;
    storageReadWarned_ = true;
    QMessageBox::warning(
        this, tr("Storage problem"),
        tr("Reading your saved pages failed: %1\n\nHistory and bookmarks "
           "will show empty until the database is readable again.")
            .arg(QString::fromUtf8(e.what())));
}

void MainWindow::refreshHistory() {
    // The History panel went with the side dock. History still
    // records per the save-history setting and feeds the address-bar
    // suggestions; there is no list left to rebuild.
}

void MainWindow::refreshBookmarks() {
    refreshBookmarkBar();
    // Bookmarks live in the tab rail's package now (and feed the
    // address-bar suggestions): rebuild the package + its rows.
    refreshBookmarkRail();
}

namespace {
// The bookmark colours: each site keeps one (hashed from its
// host), the palette the package squares are drawn from.
const char* kBookmarkColors[] = {"#e5484d", "#f76b15", "#d9a441", "#46a758",
                                 "#12a594", "#3e8fdd", "#6e56cf", "#e93d82"};
QString bookmarkColor(const QString& host, QSet<QString>* used) {
    size_t bucket = qHash(host) % 8;
    if (used) {
        // Within one list no two sites share a colour: the package
        // must read as different things inside, not pairs of twins.
        for (int tries = 0; tries < 8; ++tries) {
            if (!used->contains(kBookmarkColors[bucket])) break;
            bucket = (bucket + 1) % 8;
        }
        used->insert(kBookmarkColors[bucket]);
    }
    return QString::fromLatin1(kBookmarkColors[bucket]);
}
QString bookmarkLetter(const QString& host) {
    // The site's initial — never the "W" of a www. prefix.
    const QString h = host.startsWith(QStringLiteral("www.")) ? host.mid(4) : host;
    return h.isEmpty() ? QStringLiteral("?") : h.left(1).toUpper();
}
// A rounded square in the site's colour with its letter: the
// no-logo face of a bookmark row.
QPixmap bookmarkLetterPixmap(const QString& host, const QString& color, int size) {
    QPixmap pm(size, size);
    pm.fill(Qt::transparent);
    QPainter painter(&pm);
    painter.setRenderHint(QPainter::Antialiasing);
    painter.setBrush(QColor(color));
    painter.setPen(Qt::NoPen);
    painter.drawRoundedRect(0, 0, size, size, size * 0.24, size * 0.24);
    painter.setPen(Qt::white);
    QFont f = painter.font();
    f.setPixelSize(static_cast<int>(size * 0.52));
    f.setBold(true);
    painter.setFont(f);
    painter.drawText(pm.rect(), Qt::AlignCenter, bookmarkLetter(host));
    return pm;
}
// A small chevron-up: the fold-the-bookmarks-shut button's face.
QPixmap chevronUpPixmap(const QColor& color, int size = 16) {
    QPixmap pm(size, size);
    pm.fill(Qt::transparent);
    QPainter painter(&pm);
    painter.setRenderHint(QPainter::Antialiasing);
    painter.setPen(QPen(color, 2, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
    const qreal m = size * 0.22, mid = size / 2.0;
    const qreal top = size * 0.34, bot = size * 0.66;
    painter.drawLine(QPointF(m, bot), QPointF(mid, top));
    painter.drawLine(QPointF(mid, top), QPointF(size - m, bot));
    return pm;
}
}  // namespace

void MainWindow::setBookmarksOpen(bool open) {
    if (bookmarksOpen_ == open || !bookmarkList_) return;
    bookmarksOpen_ = open;
    if (open && railExpanded_) setRailExpanded(false);  // stays slim
    tabStripCtl_->list()->setVisible(!open);
    bookmarkList_->setVisible(open);
    if (bookmarkCloseBtn_) bookmarkCloseBtn_->setVisible(open);
    // The package tile itself goes away while it's open — the
    // lined-up tiles take its place — and returns when it closes.
    bookmarkPackBtn_->setVisible(!open && uiSettings().ntpShowTiles() &&
                                 !bookmarks_.list().empty());
    if (open) refreshBookmarkRail();  // freshest titles and logos
}

void MainWindow::refreshBookmarkRail() {
    if (!bookmarkPackBtn_ || !bookmarkList_) return;
    std::vector<vile::Bookmark> list;
    try {
        list = bookmarks_.list();
    } catch (const std::exception& e) {
        warnStorageReadOnce(e);
    }
    const bool show = uiSettings().ntpShowTiles() && !list.empty();
    bookmarkPackBtn_->setVisible(show && !bookmarksOpen_);
    if (bookmarkCloseBtn_) {
        bookmarkCloseBtn_->setVisible(show && bookmarksOpen_);
        bookmarkCloseBtn_->setIcon(
            QIcon(chevronUpPixmap(QColor(paletteById(uiSettings().theme()).muted))));
    }
    if (!show && bookmarksOpen_) setBookmarksOpen(false);
    bookmarkList_->setVisible(show && bookmarksOpen_);
    if (!show) return;
    // The package face: the first four bookmarks' own LOGOS in a
    // 2x2, like a phone folder's app icons; a site whose logo was
    // never captured keeps its colour square with its letter.
    {
        struct Face {
            QString host, color;
            QPixmap logo;
        };
        QSet<QString> used;
        QVector<Face> faces;
        for (const auto& b : list) {
            const QString host = QUrl(QString::fromStdString(b.url)).host();
            faces.append({host, bookmarkColor(host, &used),
                          engine_->faviconPixmap(host, 40)});
            if (faces.size() == 4) break;
        }
        // The cells: 2x2 at four; fewer fill the box between them.
        QVector<QRect> cells;
        const int n = faces.size();
        if (n == 1) {
            cells = {QRect(4, 4, 32, 32)};
        } else if (n == 2) {
            cells = {QRect(4, 4, 14, 32), QRect(22, 4, 14, 32)};
        } else if (n == 3) {
            cells = {QRect(4, 4, 14, 32), QRect(22, 4, 14, 14),
                     QRect(22, 22, 14, 14)};
        } else if (n >= 4) {
            cells = {QRect(4, 4, 14, 14), QRect(22, 4, 14, 14),
                     QRect(4, 22, 14, 14), QRect(22, 22, 14, 14)};
        }
        QPixmap pm(40, 40);
        pm.fill(Qt::transparent);
        QPainter painter(&pm);
        painter.setRenderHint(QPainter::Antialiasing);
        for (int i = 0; i < n; ++i) {
            const QRect cell = cells[i];
            const Face& f = faces[i];
            if (!f.logo.isNull()) {
                const QPixmap scaled =
                    f.logo.scaled(cell.size(), Qt::KeepAspectRatio,
                                  Qt::SmoothTransformation);
                painter.drawPixmap(cell.x() + (cell.width() - scaled.width()) / 2,
                                   cell.y() + (cell.height() - scaled.height()) / 2,
                                   scaled);
            } else {
                painter.setBrush(QColor(f.color));
                painter.setPen(Qt::NoPen);
                painter.drawRoundedRect(cell, 4, 4);
                painter.setPen(Qt::white);
                QFont font = painter.font();
                font.setPixelSize(qMax(8, cell.height() / 2));
                font.setBold(true);
                painter.setFont(font);
                painter.drawText(cell, Qt::AlignCenter, bookmarkLetter(f.host));
            }
        }
        bookmarkPackBtn_->setIcon(QIcon(pm));
    }
    bookmarkPackBtn_->setToolTip(tr("Bookmarks (%1)").arg(list.size()));
    // The open state: one row per bookmark, built like the tab
    // rows (logo centred in the slim rail, name beside it when
    // the rail is expanded).
    bookmarkList_->clear();
    QSet<QString> used;
    for (const auto& b : list) {
        const QUrl url(QString::fromStdString(b.url));
        const QString host = url.host();
        const QString name =
            b.title.empty() ? host : QString::fromStdString(b.title);
        const QString color = bookmarkColor(host, &used);
        auto* item = new QListWidgetItem(bookmarkList_);
        item->setData(Qt::UserRole, QString::fromStdString(b.url));
        item->setSizeHint(QSize(52, 44));
        item->setToolTip(name);
        auto* row = new QWidget(bookmarkList_);
        auto* lay = new QHBoxLayout(row);
        lay->setSpacing(4);
        lay->setContentsMargins(2, 4, 2, 4);
        auto* icon = new QLabel(row);
        icon->setObjectName(QStringLiteral("tabIcon"));
        icon->setFixedSize(24, 24);
        icon->setAlignment(Qt::AlignCenter);
        const QPixmap stored = engine_->faviconPixmap(host, 40);
        icon->setPixmap(
            !stored.isNull()
                ? stored.scaled(20, 20, Qt::KeepAspectRatio, Qt::SmoothTransformation)
                : bookmarkLetterPixmap(host, color, 24));
        lay->insertStretch(0);
        lay->addWidget(icon);
        lay->addStretch(0);
        bookmarkList_->setItemWidget(item, row);
    }
}

// Switch the tab UI between the vertical rail and the top
// (Chrome-style) layout. The tab list and the + button MOVE
// between the two homes; the controller restyles the items for
// each orientation. Called at startup and whenever the setting
// flips (the Settings tab writes it live).
void MainWindow::applyTabLayout() {
    if (!topTabBar_ || !bookmarkBar_) return;
    const bool vertical = uiSettings().verticalTabs();
    auto* list = tabStripCtl_->list();
    if (!vertical && bookmarksOpen_) setBookmarksOpen(false);
    tabStrip_->setVisible(vertical);
    topTabBar_->setVisible(!vertical);
    if (vertical) {
        if (topListAction_) {
            topTabBar_->removeAction(topListAction_);
            delete topListAction_;
            topListAction_ = nullptr;
        }
        if (topNewAction_) {
            topTabBar_->removeAction(topNewAction_);
            delete topNewAction_;
            topNewAction_ = nullptr;
        }
        railLayout_->insertWidget(3, list);
        railLayout_->setAlignment(list, Qt::AlignTop);
        railLayout_->addWidget(newTabBtn_);
        list->setFlow(QListView::TopToBottom);
        list->setProperty("vertical", true);
        newTabBtn_->setFixedSize(52, 44);
        tabStripCtl_->setVertical(true);
        tabStripCtl_->setSlim(!railExpanded_);
    } else {
        // Preferred, not Expanding: an expanding list fills the
        // whole bar and exiles the + button to the far right edge.
        // At its content width the + sits right after the last
        // tab, like Chrome; onTabStripSynced re-asks the width as
        // tabs come and go.
        list->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Fixed);
        topListAction_ = topTabBar_->addWidget(list);
        newTabBtn_->setFixedSize(40, 40);
        topNewAction_ = topTabBar_->addWidget(newTabBtn_);
        list->setFlow(QListView::LeftToRight);
        list->setProperty("vertical", false);
        tabStripCtl_->setSlim(false);
        tabStripCtl_->setVertical(false);
    }
    list->style()->unpolish(list);
    list->style()->polish(list);
    list->update();
    refreshBookmarkBar();
}

// The Chrome-style bookmarks bar: one small chip per bookmark
// (logo + name), under the address bar. Clicking a chip navigates
// the CURRENT tab, the way Chrome's bar does. Only exists in the
// top layout, and follows the same show-bookmarks setting as the
// rail package.
void MainWindow::refreshBookmarkBar() {
    if (!bookmarkBar_ || !bookmarkBarBox_) return;
    std::vector<vile::Bookmark> list;
    try {
        list = bookmarks_.list();
    } catch (const std::exception& e) {
        warnStorageReadOnce(e);
    }
    const bool show = !uiSettings().verticalTabs() &&
                      uiSettings().ntpShowTiles() && !list.empty();
    bookmarkBar_->setVisible(show);
    auto* lay = qobject_cast<QHBoxLayout*>(bookmarkBarBox_->layout());
    if (!lay) return;
    while (QLayoutItem* it = lay->takeAt(0)) {
        delete it->widget();
        delete it;
    }
    QSet<QString> usedColors;
    for (const auto& b : list) {
        const QUrl url(QString::fromStdString(b.url));
        const QString host = url.host();
        auto* chip = new QPushButton(bookmarkBarBox_);
        chip->setObjectName(QStringLiteral("bookmarkChip"));
        const QPixmap logo = engine_->faviconPixmap(host, 16);
        if (!logo.isNull())
            chip->setIcon(QIcon(logo));
        else
            chip->setIcon(QIcon(bookmarkLetterPixmap(
                host, bookmarkColor(host, &usedColors), 16)));
        chip->setIconSize(QSize(16, 16));
        chip->setText(b.title.empty() ? host
                                      : QString::fromStdString(b.title));
        chip->setToolTip(url.toString());
        const std::string target = b.url;
        connect(chip, &QPushButton::clicked, this, [this, target] {
            const TabId id = tabStripCtl_->currentTabId();
            if (id)
                browser_->navigate(id, target);
            else
                browser_->open_tab(target);
        });
        lay->addWidget(chip);
    }
    lay->addStretch(1);
}

void MainWindow::refreshBookmarkStar() {
    if (!addressBar_) return;
    QString url;
    if (const Tab* t = browser_ ? browser_->find(currentTabId()) : nullptr)
        url = QString::fromStdString(t->url);
    const bool blank = url.isEmpty() || url == QStringLiteral("about:blank");
    const bool marked = !blank && bookmarks_.contains(url.toStdString());
    addressBar_->setBookmarked(marked, !blank);
}

void MainWindow::toggleBookmark() {
    const Tab* t = browser_ ? browser_->find(currentTabId()) : nullptr;
    if (!t || t->url.empty() || t->url == "about:blank") return;
    guardStorage(tr("Saving the bookmark"), [this, t] {
        if (bookmarks_.contains(t->url)) {
            for (const auto& b : bookmarks_.list())
                if (b.url == t->url) bookmarks_.remove(b.id);
        } else {
            bookmarks_.add(t->url, t->title);
        }
    });
    refreshBookmarks();
    refreshBookmarkStar();
}





void MainWindow::applyTheme(const QString& themeId) {
    uiSettings().setTheme(themeId);
    const Accent accent = accentById(uiSettings().accent());
    qApp->setStyleSheet(appStyleSheet(accent, paletteById(themeId)));
    if (tabStripCtl_) tabStripCtl_->setSpinnerColor(QColor(accent.focus));
    // The stylesheet restyles surfaces, but icons are PIXMAPS drawn
    // once with the palette active at draw time — round 13's
    // architect (finding T1): a live switch left nav/rail icons and
    // sidebar tiles in the outgoing theme until restart, while the
    // dialog claims changes apply immediately. Re-draw them all.
    for (const auto& [btn, kind] : themedIcons_)
        btn->setIcon(icons::icon(kind));
    refreshBookmarkStar();  // the star resolves the palette per call
    if (findBar_) findBar_->refreshIcons();
    // Web-content scrollbars are an injected style built from the
    // palette (qt_engine.cpp): rebuild it. Pages pick the new
    // colours up at their next load — document creation is when
    // scripts land — an open new-tab page follows at its next load.
    if (engine_) engine_->refreshScrollbarStyle();
    // Panel entry rows also bake palette colours (the letter tiles)
    // when built: rebuild the two list panels now, and re-draw any
    // download rows. (Round 14's architect: rows of the panel
    // VISIBLE at the switch were the gap in the first version of
    // this fix — they no longer wait for the next show.)
    refreshHistory();
    refreshBookmarks();
    if (downloadsPanel_) downloadsPanel_->refreshIcons();
    // Tab rows too: the Globe fallback pixmap is drawn at row build
    // (round 15: it was the last chrome surface still waiting for
    // the next routine sync to pick up the new palette).
    syncTabs();
}

QString MainWindow::newTabHtml() {
    // The page itself is NtpPage's job now; the window only assembles
    // what the builder may not reach: the search engine, the accent
    // and section toggles, the blocked count (read under the log
    // lock) and the saved bookmarks.
    NtpPage::Inputs in;
    in.searchTemplate = QString::fromStdString(browser_->search_engine().url_template);
    in.accent = accentById(uiSettings().accent());
    in.showClock = uiSettings().ntpShowClock();
    in.showTiles = uiSettings().ntpShowTiles();
    in.showStats = uiSettings().ntpShowStats();
    {
        std::lock_guard<std::mutex> lock(shieldAccess_.logMutex);
        in.blocked = shieldAccess_.blockLog.total();
    }
    in.blockTrackers = settings_.block_trackers;
    in.palette = paletteById(uiSettings().theme());
    return NtpPage::html(in);
}

void MainWindow::onShieldDecision(const QString&, const QString&,
                                  const QString& pageHost) {
    // The badge popup reports per-site counts, so keep them as the
    // decisions land (a map bump — cheap even in a burst).
    if (!pageHost.isEmpty()) blockedByHost_[pageHost]++;
    // A tracker-heavy page can produce hundreds of decisions a second;
    // rebuilding the stats UI for each one would spend the UI thread on
    // bookkeeping. Debounce: one refresh per burst.
    if (shieldStatsTimer_) shieldStatsTimer_->start();
}

void MainWindow::refreshShieldStats() {
    size_t total = 0, rules = 0;
    std::vector<BlockEvent> recent;
    if (auto shield = shieldAccess_.shield.load()) rules = shield->rule_count();
    {
        std::lock_guard<std::mutex> lock(shieldAccess_.logMutex);
        total = shieldAccess_.blockLog.total();
        recent = shieldAccess_.blockLog.recent();
    }
    // The numbers live in members now: the address-bar badge shows
    // the state, and its popup (showShieldPopup) shows the counts.
    sessionBlocked_ = static_cast<qlonglong>(total);
    shieldRules_ = static_cast<qlonglong>(rules);
    addressBar_->setShieldState(settings_.block_trackers, static_cast<int>(total));
    (void)recent;
}




void MainWindow::showScrim() {
    // A modal dialog over an undimmed window leaves three surfaces
    // at full brightness and no way to tell which is live (the
    // clear-data-over-settings stack was the worst frame in the
    // design review). The scrim is a plain child widget: it covers
    // the window's content, and the dialog — a separate top-level —
    // floats above it unaffected.
    if (!scrim_) {
        scrim_ = new QWidget(this);
        scrim_->setStyleSheet(QStringLiteral("background: rgba(0, 0, 0, 110);"));
        scrim_->hide();
    }
    scrim_->setGeometry(rect());
    scrim_->raise();
    scrim_->show();
}

void MainWindow::hideScrim() {
    if (scrim_) scrim_->hide();
}

void MainWindow::openSettings() {
    // Settings is a tab (about:settings), not a dialog: one instance
    // at a time, and asking for it again focuses the open one — the
    // way Chrome treats its settings page.
    if (!browser_) return;
    for (const auto& t : browser_->tabs())
        if (t.url == "about:settings" || tabStripCtl_->isSettingsTab(t.id)) {
            browser_->activate(t.id);
            return;
        }
    browser_->open_tab("about:settings");
}

void MainWindow::openSettingsAt(int page) {
    pendingSettingsPage_ = page;
    openSettings();
    // If the tab already existed, openSettings() focused it and the
    // live dialog can jump now; if it was just opened, the pending
    // page is consumed by buildSettingsPage instead.
    if (settingsDialog_) {
        settingsDialog_->setCurrentPage(page);
        pendingSettingsPage_ = -1;
    }
}

void MainWindow::showShieldPopup() {
    // Never show stale totals: the debounced refresh may not have
    // run since the last burst of blocks.
    refreshShieldStats();
    QString host;
    if (const TabId id = currentTabId()) {
        for (const auto& t : browser_->tabs())
            if (t.id == id) host = QUrl(QString::fromStdString(t.url)).host();
    }
    QMenu menu(this);
    auto info = [&menu](const QString& text) {
        QAction* a = menu.addAction(text);
        a->setEnabled(false);
    };
    QAction* blockAct = nullptr;
    if (!settings_.block_trackers) {
        info(tr("Shield is off — nothing is being blocked"));
    } else if (!host.isEmpty()) {
        info(tr("Shield blocked %1 requests on %2")
                 .arg(blockedByHost_.value(host))
                 .arg(host));
        info(tr("%1 blocked this session · %2 rules active")
                 .arg(sessionBlocked_)
                 .arg(shieldRules_));
        const bool already =
            uiSettings().userBlockedDomains().contains(host);
        blockAct = menu.addAction(tr("Block %1 always").arg(host));
        blockAct->setEnabled(!already);
        if (already) blockAct->setText(tr("%1 is in your blocked list").arg(host));
    } else {
        info(tr("Shield is on · %1 blocked this session · %2 rules")
                 .arg(sessionBlocked_)
                 .arg(shieldRules_));
    }
    menu.addSeparator();
    QAction* settingsAct = menu.addAction(tr("Privacy & Shield settings"));
    QAction* chosen = menu.exec(QCursor::pos());
    if (chosen && chosen == settingsAct) {
        openSettingsAt(1);  // the Privacy & Shield page
    } else if (chosen && blockAct && chosen == blockAct) {
        QStringList domains = uiSettings().userBlockedDomains();
        domains += host;
        uiSettings().setUserBlockedDomains(domains);
        if (uiSettings().userBlockedDomains() != appliedUserDomains_)
            recreateShield();
        if (const TabId id = currentTabId()) browser_->reload(id);
    }
}

QWidget* MainWindow::buildSettingsPage() {
    auto* host = new QWidget;
    // One centred column for the search bar and the settings body:
    // full-width rows made the descriptions run the whole window
    // and the page read as a stretched dialog, not a settings page.
    auto* col = new QWidget(host);
    col->setMaximumWidth(920);
    auto* lay = new QVBoxLayout(col);
    lay->setContentsMargins(0, 10, 0, 10);
    lay->setSpacing(8);
    auto* outer = new QHBoxLayout(host);
    outer->setContentsMargins(12, 0, 12, 0);
    outer->addStretch(1);
    outer->addWidget(col, 3);
    outer->addStretch(1);
    auto* searchRow = new QHBoxLayout;
    auto* search = new QLineEdit(col);
    search->setPlaceholderText(tr("Search settings"));
    search->setClearButtonEnabled(true);
    searchRow->addWidget(search, 1);
    auto* note = new QLabel(col);
    searchRow->addWidget(note);
    lay->addLayout(searchRow);
    auto* dlg = new SettingsDialog(settings_, detected_, blocklistInfo_, col);
    dlg->setWindowFlags(Qt::Widget);
    dlg->setEmbedded(true);  // a page, not a dialog: changes apply live
    settingsDialog_ = dlg;
    connect(dlg, &SettingsDialog::privacySettingsChanged, this,
            &MainWindow::applySettings);
    connect(dlg, &SettingsDialog::requestBlocklistUpdate, this,
            &MainWindow::onBlocklistUpdateRequested);
    connect(dlg, &SettingsDialog::requestClearData, this,
            &MainWindow::onClearDataRequested);
    connect(dlg, &SettingsDialog::themeChanged, this, &MainWindow::applyTheme);
    connect(search, &QLineEdit::textChanged, this,
            [dlg, note](const QString& text) {
                const int n = dlg->highlightSearch(text);
                note->setText(text.trimmed().isEmpty()
                                  ? QString()
                                  : n ? tr("%1 matching settings").arg(n)
                                      : tr("No settings match"));
            });
    connect(dlg, &QDialog::finished, this, [this, dlg](int result) {
        // OK applies the staged privacy settings, exactly as the old
        // modal did; Cancel has already restored the live channels
        // inside the dialog's reject(). Either way the tab closes.
        if (result == QDialog::Accepted) applySettings(dlg->settings());
        if (uiSettings().userBlockedDomains() != appliedUserDomains_)
            recreateShield();
        settingsDialog_ = nullptr;
        for (const auto& t : browser_->tabs())
            if (t.url == "about:settings" || tabStripCtl_->isSettingsTab(t.id)) {
                browser_->close_tab(t.id);
                break;
            }
    });
    lay->addWidget(dlg, 1);
    if (pendingSettingsPage_ >= 0) {
        dlg->setCurrentPage(pendingSettingsPage_);
        pendingSettingsPage_ = -1;
    }
    return host;
}

void MainWindow::setRailExpanded(bool expanded) {
    if (railExpanded_ == expanded) return;
    railExpanded_ = expanded;
    tabStripCtl_->setSlim(!expanded);
    const int target = expanded ? 232 : 64;
    auto* anim = new QPropertyAnimation(tabStrip_, "maximumWidth", this);
    anim->setDuration(160);
    anim->setEasingCurve(QEasingCurve::OutCubic);
    anim->setStartValue(tabStrip_->width());
    anim->setEndValue(target);
    connect(anim, &QPropertyAnimation::valueChanged, this,
            [this](const QVariant& v) { tabStrip_->setMinimumWidth(v.toInt()); });
    connect(anim, &QPropertyAnimation::finished, this, [this, target] {
        tabStrip_->setMinimumWidth(target);
        tabStrip_->setMaximumWidth(target);
    });
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

void MainWindow::applySettings(const PrivacySettings& s) {
    settings_ = s;
    guardStorage(tr("Saving settings"),
                 [this] { settings_.save(settingsStore_); });
    // Copy-on-write: the Shield is immutable once published, so new
    // settings mean a new snapshot carrying the same rules.
    if (auto current = shieldAccess_.shield.load()) {
        auto next = std::make_shared<Shield>(*current);
        next->set_settings(settings_);
        shieldAccess_.shield.store(std::move(next));
    }
    browser_->set_private_mode(!settings_.save_history);
    if (const SearchEngine* e = find_search_engine(settings_.search_engine_id)) {
        browser_->set_search_engine(*e);
        addressBar_->setSearchEngineName(QString::fromStdString(e->name));
        addressBar_->setSearchEngineHost(searchEngineHost(*e));
    }
    refreshShieldStats();
}

void MainWindow::onBlocklistUpdateRequested() {
    blocklist::updateFromNetwork(
        dataDir_, [this](bool ok, const QString& message) { onBlocklistUpdated(ok, message); });
}

void MainWindow::onBlocklistUpdated(bool ok, const QString& message) {
    if (ok) {
        recreateShield();
        QMessageBox::information(this, tr("Blocklist updated"),
                                 tr("%1 The Shield now uses the maintained list.").arg(message));
    } else {
        QMessageBox::warning(this, tr("Blocklist update failed"), message);
    }
}

void MainWindow::recreateShield() {
    // Build the replacement — settings plus a ~78k-rule file parse —
    // entirely off to the side, then publish it with one atomic store:
    // IO-thread readers see the old Shield or the new one, never a
    // half-built one, and never wait on a lock while it is built.
    auto fresh = std::make_shared<Shield>(settings_);
    QString info;
    blocklist::load(*fresh, dataDir_, &info);
    applyUserDomains(*fresh);
    shieldAccess_.shield.store(std::move(fresh));
    blocklistInfo_ = info;
    if (settingsDialog_) settingsDialog_->refreshBlocklistInfo(blocklistInfo_);
    refreshShieldStats();
}

void MainWindow::applyUserDomains(Shield& shield) {
    appliedUserDomains_ = uiSettings().userBlockedDomains();
    for (const QString& d : appliedUserDomains_)
        shield.add_blocked_domain(d.toStdString());
}

void MainWindow::onClearDataRequested() {
    ClearDataDialog dlg(this);
    // The Settings dialog is already up (and already scrimmed) when
    // this runs — the clear-data dialog stacks over the same scrim.
    if (dlg.exec() != QDialog::Accepted) return;
    if (dlg.clearHistory()) {
        const int hours = dlg.historyRangeHours();
        guardStorage(tr("Clearing history"), [this, hours] {
            if (hours <= 0)
                history_.clear();
            else
                history_.clear_since(QDateTime::currentSecsSinceEpoch() -
                                     static_cast<qint64>(hours) * 3600);
        });
        refreshHistory();
        // A FULL history clear is a fresh start: the stored site
        // logos are a per-host record of the same browsing, so they
        // go too. A ranged clear leaves them — logos carry no
        // timestamps, so there is no honest way to range-delete
        // them; the site-data checkbox clears them on its own.
        if (hours <= 0) engine_->favicons().clear();
    }
    if (dlg.clearSiteData()) engine_->clear_site_data();
}

void MainWindow::closeEvent(QCloseEvent* event) {
    // Save the session first: close_session tears the tabs down, and the
    // save must see them before they are gone. (saveSession guards its
    // own storage writes — a failure there can't trap the user in a
    // window that won't close.)
    saveSession();
    closing_ = true;
    if (tabStripCtl_) tabStripCtl_->setClosing(true);
    browser_->close_session(settings_.clear_on_exit, !settings_.save_history);
    event->accept();
}
