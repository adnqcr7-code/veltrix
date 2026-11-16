#pragma once
// TabStripController: owns the tab strip (the list that serves both
// the horizontal bar and the vertical sidebar), the page stack, and
// the whole sync between vile::Browser's tab model and those widgets
// — extracted from MainWindow, where syncTabs alone was ~290 lines of
// the window's 2,500. The window keeps the chrome AROUND the tabs
// (address bar, title, nav buttons) and hears about completed syncs
// through the synced() signal; the new-tab page's HTML comes from a
// provider the window sets, so the controller never learns how the
// page is composed.
//
// Tab items are indexed in a hash (tab id -> item), so a sync is a
// linear diff, not the O(n^2) scan the window used to run; the same
// index serves the spinner's per-tick lookups.
#include <QColor>
#include <QUrl>
#include <QHash>
#include <QList>
#include <QObject>
#include <QSet>
#include <QString>
#include <functional>
#include <vector>

#include "vile/browser.hpp"
#include "tabviewsource.h"

class QLabel;
class QListWidget;
class QPushButton;
class QWebEngineView;
class QListWidgetItem;
class QStackedWidget;
class QTimer;
class QWidget;
class TabViewSource;

class TabStripController : public QObject {
    Q_OBJECT
public:
    TabStripController(vile::Browser& browser, TabViewSource& engine, QWidget* listParent,
                       QWidget* stackParent, QObject* parent = nullptr);

    QListWidget* list() const { return tabList_; }
    QStackedWidget* stack() const { return tabStack_; }

    // Coalesced sync: tab events arrive in bursts (one page load fires
    // several), and a sync re-reads all state anyway — queue at most
    // one. syncNow() runs the diff immediately.
    void requestSync();
    void syncNow();

    void setVertical(bool vertical);
    // Slim rail mode: the strip renders as a narrow column of site
    // logos only — no titles, no close buttons — the way Brave's
    // collapsed vertical tabs look. The window's tab rail uses this;
    // the classic list (titles + close) remains the default.
    void setSlim(bool slim);
    void setSpinnerColor(const QColor& color);
    void setClosing(bool on) { closing_ = on; }
    // Keyboard focus back to the current page (the find bar's close
    // path) — the stack lives here, so the focus call does too.
    void focusCurrentPage();
    void setBlankPageHtmlProvider(std::function<QString()> provider) {
        blankPageHtml_ = std::move(provider);
    }
    // The settings tab (about:settings) hosts a widget, not a web
    // page: the window provides it. A tab with that URL gets the
    // provider's widget as its page; the engine's view for the tab
    // exists but is never shown.
    void setSettingsPageProvider(std::function<QWidget*()> provider) {
        settingsPage_ = std::move(provider);
    }
    // Chromium rewrites the settings view's URL (about:settings
    // becomes an internal blocked-page URL), so the tab's URL is
    // not a stable identity — the strip remembers which tab ids
    // got the settings page instead.
    bool isSettingsTab(vile::TabId id) const { return settingsTabs_.contains(id); }

    // The tab whose page the stack shows (0 when there is none).
    vile::TabId currentTabId() const;
    QListWidgetItem* itemForTab(vile::TabId id) const;
    bool hasClosedTabs() const { return !closedTabs_.empty(); }
    void cycleTab(int direction);
    void reopenClosedTab();

    bool eventFilter(QObject* watched, QEvent* event) override;

signals:
    // A sync completed. anyLoading drives the window's Stop/Reload
    // swap; the rest of the chrome follows the active tab from here.
    void synced(bool anyLoading);
    // Per-view events the window still owns a piece of: the top
    // progress bar (loadProgressChanged) and per-site zoom
    // (viewUrlChanged). The controller keeps the tab-icon and NTP
    // bookkeeping for the same events itself.
    void loadProgressChanged(int progress);
    void viewUrlChanged(vile::TabId id, const QUrl& url);

private:
    // The widgets composing one tab item, resolved once and cached on
    // the item widget itself (see tabWidgets in the implementation).
    struct TabWidgets {
        QWidget* widget = nullptr;
        QLabel* icon = nullptr;
        QLabel* dot = nullptr;
        QLabel* title = nullptr;
        QPushButton* close = nullptr;
    };
    TabWidgets tabWidgets(QWidget* w);
    QColor spinnerColor();
    // syncNow's phases, in call order. One QSet of open tab ids is
    // built by syncNow and shared by the phases that need membership
    // tests (they used to rescan the tab list per candidate).
    void noteClosedTabs(const QSet<vile::TabId>& open);
    void prunePages(const QSet<vile::TabId>& open);
    void rebuildItemsIfDiverged(const std::vector<vile::Tab>& tabs);
    void createPageFor(const vile::Tab& t);
    void ensureItemWidget(const vile::Tab& t);
    void refreshItem(const vile::Tab& t);
    void refreshSpinnerIcons();
    void updateTabClose(QListWidgetItem* item, bool hovered);
    void setTabIconFallback(QLabel* icon, const QString& host);
    void onTabListCurrentChanged(int row);
    void onTabCloseClicked();

    vile::Browser& browser_;
    TabViewSource& engine_;
    QListWidget* tabList_ = nullptr;
    QStackedWidget* tabStack_ = nullptr;
    QHash<vile::TabId, QListWidgetItem*> itemIndex_;
    QHash<vile::TabId, QWidget*> pages_;
    QSet<vile::TabId> ntpPending_;
    std::vector<vile::Tab> lastTabs_;
    struct ClosedTab {
        std::string url;
        int index;
    };
    std::vector<ClosedTab> closedTabs_;  // back() is the most recently closed
    QListWidgetItem* hoveredTabItem_ = nullptr;
    QTimer* spinnerTimer_ = nullptr;
    int spinnerAngle_ = 0;
    QColor spinnerColorCache_;
    bool vertical_ = true;
    bool slim_ = false;
    bool closing_ = false;  // set at window close: no zero-tab guarantee, no diffing
    bool syncingTabs_ = false;
    bool syncQueued_ = false;
    std::function<QString()> blankPageHtml_;
    std::function<QWidget*()> settingsPage_;
    QSet<vile::TabId> settingsTabs_;
};
