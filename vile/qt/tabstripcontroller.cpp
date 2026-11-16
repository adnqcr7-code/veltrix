#include "tabstripcontroller.h"

#include <QAction>
#include <QEasingCurve>
#include <QGraphicsOpacityEffect>
#include <QHBoxLayout>
#include <QLabel>
#include <QPropertyAnimation>
#include <QPushButton>
#include <QVBoxLayout>
#include <QListWidget>
#include <QMenu>
#include <QMetaObject>
#include <QMouseEvent>
#include <QStackedWidget>
#include <QTimer>
#include <QWebEngineView>

#include "icons.h"
#include "qt_engine.h"
#include "theme.h"
#include "uisettings.h"

using vile::Tab;
using vile::TabId;

TabStripController::TabStripController(vile::Browser& browser, TabViewSource& engine,
                                       QWidget* listParent, QWidget* stackParent,
                                       QObject* parent)
    : QObject(parent), browser_(browser), engine_(engine) {
    // One list serves both layouts (Helium-style vertical tabs): in
    // horizontal mode it is a bar above the pages, in vertical mode a
    // list on the left. QTabWidget can't do that — its vertical tabs
    // rotate the text 90 degrees.
    tabList_ = new QListWidget(listParent);
    tabList_->setObjectName(QStringLiteral("tabList"));
    tabList_->setSelectionMode(QAbstractItemView::SingleSelection);
    tabList_->setDragDropMode(QAbstractItemView::InternalMove);
    // NOT uniform item sizes: a pinned tab's item is narrower than a
    // normal one (46 vs 160), and uniform sizes silently override
    // every per-item sizeHint with one shared size — the pinned
    // collapse never actually rendered while this was on.
    tabList_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    // The vertical bar must never render either: in the horizontal
    // strip (a fixed short height) a native scrollbar sliver pokes out at the
    // strip's right edge and reads as a rendering bug. Tab strips
    // scroll by wheel and selection, not by bar.
    tabList_->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    tabStack_ = new QStackedWidget(stackParent);
    connect(tabList_, &QListWidget::currentRowChanged, this,
            &TabStripController::onTabListCurrentChanged);
    // The tab's close button shows only while its tab is hovered or
    // active (browser-style): a quieter list, same control when needed.
    tabList_->setMouseTracking(true);
    tabList_->viewport()->setMouseTracking(true);
    tabList_->viewport()->installEventFilter(this);
    connect(tabList_, &QListWidget::itemEntered, this,
            [this](QListWidgetItem* item) {
                if (hoveredTabItem_ && hoveredTabItem_ != item)
                    updateTabClose(hoveredTabItem_, false);
                hoveredTabItem_ = item;
                updateTabClose(item, true);
            });
    // Dragging a tab in the strip: the view moves the item itself, so
    // forward the move to the Browser to keep its order the source of
    // truth (move_tab clamps a drop out of the pinned region, and the
    // next sync rebuilds the strip if the clamp changed anything).
    connect(tabList_->model(), &QAbstractItemModel::rowsMoved, this,
            [this](const QModelIndex&, int start, int, const QModelIndex&, int row) {
                if (syncingTabs_) return;
                const int landed = row > start ? row - 1 : row;
                if (landed < 0 || landed >= tabList_->count()) return;
                if (QListWidgetItem* item = tabList_->item(landed))
                    browser_.move_tab(
                        static_cast<vile::TabId>(item->data(Qt::UserRole).toULongLong()),
                        landed);
            });
    // Right-click a tab: pin/unpin, close, close others.
    tabList_->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(tabList_, &QListWidget::customContextMenuRequested, this,
            [this](const QPoint& pos) {
                QListWidgetItem* item = tabList_->itemAt(pos);
                if (!item) return;
                const auto id =
                    static_cast<vile::TabId>(item->data(Qt::UserRole).toULongLong());
                const vile::Tab* t = browser_.find(id);
                if (!t) return;
                QMenu menu(tabList_);
                QAction* pinAct =
                    menu.addAction(t->pinned ? tr("Unpin tab") : tr("Pin tab"));
                const bool wasPinned = t->pinned;
                connect(pinAct, &QAction::triggered, this,
                        [this, id, wasPinned] { browser_.set_pinned(id, !wasPinned); });
                QAction* dupAct = menu.addAction(tr("Duplicate tab"));
                connect(dupAct, &QAction::triggered, this,
                        [this, id] { browser_.duplicate_tab(id); });
                menu.addSeparator();
                QAction* closeAct = menu.addAction(tr("Close tab"));
                connect(closeAct, &QAction::triggered, this,
                        [this, id] { browser_.close_tab(id); });
                QAction* closeOthersAct = menu.addAction(tr("Close other tabs"));
                connect(closeOthersAct, &QAction::triggered, this, [this, id] {
                    std::vector<vile::TabId> others;
                    for (const auto& x : browser_.tabs())
                        if (x.id != id) others.push_back(x.id);
                    for (vile::TabId other : others) browser_.close_tab(other);
                });
                menu.exec(tabList_->viewport()->mapToGlobal(pos));
            });
    // Loading spinner: one timer advances the arc; sync starts it when
    // any tab is loading and stops it when none is.
    spinnerTimer_ = new QTimer(this);
    spinnerTimer_->setInterval(100);
    connect(spinnerTimer_, &QTimer::timeout, this, [this] {
        spinnerAngle_ = (spinnerAngle_ + 36) % 360;
        refreshSpinnerIcons();
    });
}

void TabStripController::requestSync() {
    // Coalesce: one page load fires the tabs-changed callback per
    // URL/title/loading event, and a sync re-reads all state anyway —
    // queue at most one.
    if (syncQueued_) return;
    syncQueued_ = true;
    QMetaObject::invokeMethod(this, [this] {
        syncQueued_ = false;
        syncNow();
    }, Qt::QueuedConnection);
}

void TabStripController::setVertical(bool vertical) {
    vertical_ = vertical;
    // The controller owns the list's height in BOTH modes (round 12's
    // architecture review: the horizontal half used to live in the
    // window's applyTabLayout, so the controller's correctness
    // depended on its caller remembering to clear what it set).
    // Vertical: hug the content, capped. Horizontal: the fixed bar
    // height. Each direction fully releases the other's constraints,
    // and no sync may run before the next paint — it must hold from
    // this call alone.
    if (vertical) {
        const int content = tabList_->count() * 40 + 10;
        tabList_->setMinimumHeight(0);
        tabList_->setMaximumHeight(qMin(content, 480));
    } else {
        tabList_->setMinimumHeight(44);
        tabList_->setMaximumHeight(44);
    }
    // Mode-dependent rendering (size hints, the pinned title's
    // visibility) is evaluated in refreshItem, which otherwise runs
    // only on tab changes — and switching layout is not one. Without
    // this pass the strip keeps the OLD mode's rendering until some
    // unrelated tab event syncs: exactly how the vertical pinned
    // title shipped hidden in v32 despite the visibility rule being
    // correct (a standalone probe that synced after switching saw
    // it right; the window, which doesn't sync, didn't).
    for (const vile::Tab& t : browser_.tabs()) refreshItem(t);
}

void TabStripController::setSlim(bool slim) {
    if (slim_ == slim) return;
    slim_ = slim;
    // Row GEOMETRY differs between the modes (icon size, centring
    // stretches), and item widgets are built once — so a live switch
    // (the rail expanding on hover) rebuilds the rows from the tab
    // model, the same clear-and-resync the order-divergence path
    // uses. The pages are not touched.
    if (slim) {
        // The classic mode caps the list at its content height (see
        // syncNow); that cap must not leak into the rail, whose list
        // fills the whole column.
        tabList_->setMinimumHeight(0);
        tabList_->setMaximumHeight(QWIDGETSIZE_MAX);
    }
    hoveredTabItem_ = nullptr;
    tabList_->clear();
    itemIndex_.clear();
    syncNow();
}

void TabStripController::setSpinnerColor(const QColor& color) {
    spinnerColorCache_ = color;
}

bool TabStripController::eventFilter(QObject* watched, QEvent* event) {
    // Tab-title labels re-elide themselves against their REAL width
    // whenever it changes (see the title refresh in syncNow): the
    // active item's label is narrower than the inactive ones' because
    // its close button and dot are visible, and only the laid-out
    // geometry knows by how much.
    if (event->type() == QEvent::Resize) {
        if (auto* label = qobject_cast<QLabel*>(watched)) {
            const QString full = label->property("fullTitle").toString();
            if (!full.isEmpty() && label->width() > 0) {
                const QString elided = label->fontMetrics().elidedText(
                    full, Qt::ElideRight, label->width());
                if (label->text() != elided) label->setText(elided);
            }
        }
    }
    if (watched == tabList_->viewport() && event->type() == QEvent::Leave) {
        // The mouse left the tab list: no tab is hovered any more, so
        // only the active tab keeps its close button.
        if (hoveredTabItem_) {
            updateTabClose(hoveredTabItem_, false);
            hoveredTabItem_ = nullptr;
        }
        return false;
    }
    if (watched == tabList_->viewport() && event->type() == QEvent::MouseButtonPress) {
        // Middle-click a tab closes it (the standard tab-strip gesture).
        auto* mouse = static_cast<QMouseEvent*>(event);
        if (mouse->button() == Qt::MiddleButton) {
            if (QListWidgetItem* item = tabList_->itemAt(mouse->pos())) {
                browser_.close_tab(
                    static_cast<vile::TabId>(item->data(Qt::UserRole).toULongLong()));
                return true;
            }
        }
        return false;
    }
    return QObject::eventFilter(watched, event);
}

void TabStripController::focusCurrentPage() {
    if (QWidget* w = tabStack_->currentWidget()) w->setFocus();
}

void TabStripController::syncNow() {
    syncQueued_ = false;
    syncingTabs_ = true;
    // RAII reset: the zero-tab path below returns early, and a
    // hand-reset flag leaked `true` there — rescued only by the
    // follow-up notify from open_tab(). The guard makes every exit
    // path reset it, including future early returns.
    struct SyncGuard {
        bool& flag;
        ~SyncGuard() { flag = false; }
    } guard{syncingTabs_};
    const auto& tabs = browser_.tabs();
    // One membership set for the whole sync: closed-tab detection and
    // page pruning used to rescan the tab list per candidate (O(n^2)).
    QSet<vile::TabId> open;
    open.reserve(static_cast<int>(tabs.size()));
    for (const auto& t : tabs) open.insert(t.id);
    noteClosedTabs(open);
    lastTabs_ = tabs;
    prunePages(open);
    // Whatever closed the last tab (close button, Ctrl+W, middle-click,
    // context menu), the window never sits with zero tabs. Not while
    // quitting: close_session empties the list on purpose.
    if (tabs.empty() && !closing_) {
        browser_.open_tab();
        return;  // the notify from open_tab re-runs syncTabs for the new tab
    }
    rebuildItemsIfDiverged(tabs);
    for (const auto& t : tabs) {
        if (!pages_.contains(t.id)) createPageFor(t);
        ensureItemWidget(t);
        refreshItem(t);
    }
    if (auto active = browser_.active_tab()) {
        if (QWidget* page = pages_.value(*active, nullptr)) {
            int idx = tabStack_->indexOf(page);
            if (idx >= 0 && tabStack_->currentIndex() != idx) tabStack_->setCurrentIndex(idx);
        }
        if (QListWidgetItem* item = itemForTab(*active)) {
            int row = tabList_->row(item);
            if (row >= 0 && tabList_->currentRow() != row) tabList_->setCurrentRow(row);
        }
    }
    // Spinner timer follows the loading state.
    bool anyLoading = false;
    for (const auto& t : browser_.tabs()) anyLoading |= t.loading;
    if (spinnerTimer_) {
        if (anyLoading && !spinnerTimer_->isActive()) spinnerTimer_->start();
        if (!anyLoading && spinnerTimer_->isActive()) spinnerTimer_->stop();
    }
    // In the sidebar the list hugs its rows (capped, so a long tab list
    // still scrolls): the "+ New tab" button sits directly under the
    // last tab instead of at the bottom of an empty column.
    if (vertical_ && !slim_) {
        const int content = tabList_->count() * 40 + 10;
        tabList_->setMaximumHeight(qMin(content, 480));
    }
    emit synced(anyLoading);  // the guard resets syncingTabs_ on exit
}

void TabStripController::noteClosedTabs(const QSet<vile::TabId>& open) {
    // Tabs that disappeared since the last sync are recently closed:
    // keep them for Ctrl+Shift+T. Not while quitting — close_session
    // closes everything and the stack dies with the process anyway.
    if (closing_) return;
    for (int i = 0; i < static_cast<int>(lastTabs_.size()); ++i) {
        const vile::Tab& old = lastTabs_[i];
        if (open.contains(old.id)) continue;
        if (!old.url.empty() && old.url != "about:blank") {
            closedTabs_.push_back({old.url, i});
            if (closedTabs_.size() > 10) closedTabs_.erase(closedTabs_.begin());
        }
    }
}

void TabStripController::prunePages(const QSet<vile::TabId>& open) {
    // Remove pages and list items for closed tabs.
    for (auto it = pages_.begin(); it != pages_.end();) {
        const vile::TabId id = it.key();
        if (open.contains(id)) {
            ++it;
            continue;
        }
        QWidget* page = it.value();
        settingsTabs_.remove(id);
        tabStack_->removeWidget(page);
        delete page;
        if (QListWidgetItem* item = itemForTab(id)) {
            if (item == hoveredTabItem_) hoveredTabItem_ = nullptr;
            itemIndex_.remove(id);
            delete tabList_->takeItem(tabList_->row(item));
        }
        ntpPending_.remove(id);
        it = pages_.erase(it);
    }
}

void TabStripController::rebuildItemsIfDiverged(const std::vector<vile::Tab>& tabs) {
    // If the list's order no longer matches the Browser's (pinning
    // moved a tab, or one was inserted mid-list), rebuild the items
    // from scratch: QListWidget owns the item widgets, so shuffling
    // items with takeItem leaves the view holding deleted widgets (a
    // crash in the next layout pass). Clearing is safe — the creation
    // pass below rebuilds every missing item in order.
    bool orderOk = tabList_->count() == static_cast<int>(tabs.size());
    for (int i = 0; orderOk && i < tabList_->count(); ++i) {
        const auto id =
            static_cast<TabId>(tabList_->item(i)->data(Qt::UserRole).toULongLong());
        if (id != tabs[static_cast<size_t>(i)].id) orderOk = false;
    }
    if (!orderOk) {
        hoveredTabItem_ = nullptr;
        tabList_->clear();
        itemIndex_.clear();
    }
}

void TabStripController::createPageFor(const vile::Tab& t) {
    if (t.url == "about:settings" && settingsPage_) {
        // The settings tab: a widget page, not a web view. The
        // engine still created a view for this tab id (the Browser
        // asked it to); it simply never enters the stack.
        QWidget* page = settingsPage_();
        page->setProperty("tabId", QVariant::fromValue<quint64>(t.id));
        settingsTabs_.insert(t.id);
        pages_[t.id] = page;
        tabStack_->addWidget(page);
        return;
    }
    QWidget* page = new QWidget;
    page->setProperty("tabId", QVariant::fromValue<quint64>(t.id));
    auto* lay = new QVBoxLayout(page);
    lay->setContentsMargins(0, 0, 0, 0);
    QWebEngineView* view = engine_.viewForTab(t.id);
    if (view) {
        lay->addWidget(view);
        connect(view, &QWebEngineView::loadProgress, this,
                [this](int p) { emit loadProgressChanged(p); });
        connect(view, &QWebEngineView::loadFinished, this,
                [this, view, id = t.id](bool) {
                    emit loadProgressChanged(100);
                    // A blank tab shows the local new-tab page. setHtml
                    // content is lost on reload, so re-inject it — but
                    // the setHtml load itself also finishes here, and
                    // must not re-trigger (ntpPending_ guards that).
                    if (view->url().toString() != QStringLiteral("about:blank"))
                        return;
                    if (ntpPending_.remove(id)) return;
                    ntpPending_.insert(id);
                    view->setHtml(blankPageHtml_ ? blankPageHtml_() : QString(), QUrl(QStringLiteral("about:blank")));
                });
            connect(view, &QWebEngineView::urlChanged, this,
                [this, view, id = t.id](const QUrl& u) {
                    emit viewUrlChanged(id, u);
                    if (u.toString() != QStringLiteral("about:blank"))
                        ntpPending_.remove(id);
                    if (QListWidgetItem* current = itemForTab(id)) {
                        if (QWidget* widget = tabList_->itemWidget(current)) {
                            if (QLabel* icon = tabWidgets(widget).icon) {
                                // While the page loads the spinner
                                // owns the icon; don't clobber it.
                                if (const Tab* tab = browser_.find(id);
                                    tab && tab->loading)
                                    return;
                                icon->setProperty("hasFavicon", false);
                                setTabIconFallback(icon, u.host());
                            }
                        }
                    }
                });
    }
    pages_[t.id] = page;
    tabStack_->addWidget(page);
    if (view) {
        auto updateFavicon = [this, id = t.id](const QIcon& icon) {
            if (QListWidgetItem* current = itemForTab(id)) {
                if (QWidget* widget = tabList_->itemWidget(current)) {
                    if (QLabel* label = tabWidgets(widget).icon) {
                        if (!icon.isNull()) {
                            label->setPixmap(icon.pixmap(16, 16));
                            label->setText(QString());
                            label->setProperty("hasFavicon", true);
                        }
                    }
                }
            }
        };
        connect(view, &QWebEngineView::iconChanged, this, updateFavicon);
        updateFavicon(view->icon());
    }
    auto* effect = new QGraphicsOpacityEffect(page);
    effect->setOpacity(0.0);
    page->setGraphicsEffect(effect);
    auto* fade = new QPropertyAnimation(effect, "opacity", page);
    fade->setDuration(260);
    fade->setStartValue(0.0);
    fade->setEndValue(1.0);
    fade->setEasingCurve(QEasingCurve::OutCubic);
    // The fade is a 260 ms welcome, not a lifetime sentence: a
    // permanent graphics effect forces the WebEngine view through
    // offscreen rendering forever. Remove it when it completes
    // (setGraphicsEffect(nullptr) disposes of the effect itself).
    connect(fade, &QPropertyAnimation::finished, page,
            [page] { page->setGraphicsEffect(nullptr); });
    fade->start(QAbstractAnimation::DeleteWhenStopped);
}

void TabStripController::ensureItemWidget(const vile::Tab& t) {
    // Create the item if it's missing; (re)build its widget whenever
    // the item has none (a drag-move can leave an item widget-less).
    QListWidgetItem* existingItem = itemForTab(t.id);
    if (existingItem && tabList_->itemWidget(existingItem)) return;
    auto* item = existingItem ? existingItem : new QListWidgetItem(tabList_);
    item->setData(Qt::UserRole, QVariant::fromValue<quint64>(t.id));
    itemIndex_[t.id] = item;
    item->setSizeHint(QSize(160, 34));
    auto* itemWidget = new QWidget;
    itemWidget->setStyleSheet(QStringLiteral("background: transparent;"));
    auto* itemLay = new QHBoxLayout(itemWidget);
    if (slim_) {
        // Rail rows: the logo sits centred in the narrow column —
        // stretches on both sides (the trailing one is added below)
        // split the slack around it.
        itemLay->setContentsMargins(2, 4, 2, 4);
        itemLay->insertStretch(0);
    } else {
        itemLay->setContentsMargins(8, 2, 2, 2);
    }
    itemLay->setSpacing(4);
    auto* siteIcon = new QLabel(itemWidget);
    siteIcon->setObjectName(QStringLiteral("tabIcon"));
    siteIcon->setFixedSize(slim_ ? 24 : 18, slim_ ? 24 : 18);
    siteIcon->setAlignment(Qt::AlignCenter);
    siteIcon->setProperty("hasFavicon", false);
    const QUrl tabUrl(QString::fromStdString(t.url));
    const QString host = tabUrl.host();
    setTabIconFallback(siteIcon, host);
    itemLay->addWidget(siteIcon);
    // Small accent dot, visible only on the active tab (pill-tab style).
    auto* dot = new QLabel(tr("●"), itemWidget);
    dot->setObjectName(QStringLiteral("tabDot"));
    itemLay->addWidget(dot);
    auto* titleLabel = new QLabel(itemWidget);
    titleLabel->setObjectName(QStringLiteral("tabTitle"));
    itemLay->addWidget(titleLabel, 1);
    auto* closeBtn = new QPushButton(tr("×"), itemWidget);
    closeBtn->setObjectName(QStringLiteral("tabClose"));
    closeBtn->setFixedSize(20, 20);
    closeBtn->setToolTip(tr("Close tab"));
    closeBtn->setProperty("tabId", QVariant::fromValue<quint64>(t.id));
    connect(closeBtn, &QPushButton::clicked, this, &TabStripController::onTabCloseClicked);
    itemLay->addWidget(closeBtn);
    // Trailing spacer: for a pinned tab every other child is hidden,
    // and a lone fixed-size child does not reliably pack to the start
    // (it rendered dead-centre in its row). Factor ZERO is the point:
    // at factor 1 the spacer split the row's surplus evenly with the
    // title label (which also has stretch 1), halving every title's
    // room — the active tab's width premium included. The spacer may
    // only absorb what the title cannot use.
    itemLay->addStretch(0);
    tabList_->setItemWidget(item, itemWidget);
}

void TabStripController::refreshItem(const vile::Tab& t) {
    const bool isSettings =
        t.url == "about:settings" || settingsTabs_.contains(t.id);
    QString title = isSettings ? tr("Settings") : QString::fromStdString(t.title);
    // Never a raw URL as the tab's text: Chromium reports the URL as
    // the title until the page's real one arrives, so until then a
    // loading tab says "Loading…" and a finished one falls back to
    // its host, not the full address.
    if (!isSettings && (title.isEmpty() || title == QString::fromStdString(t.url))) {
        if (t.loading) {
            title = tr("Loading…");
        } else {
            const QString host = QUrl(QString::fromStdString(t.url)).host();
            title = host.isEmpty() ? tr("New Tab") : host;
        }
    }
    if (QListWidgetItem* item = itemForTab(t.id)) {
        if (QWidget* w = tabList_->itemWidget(item)) {
            const TabWidgets tw = tabWidgets(w);
            if (tw.title) {
                // Elision is self-correcting: the full title is
                // stored on the label, a first pass elides to the
                // current width (or a mode estimate before layout),
                // and an event filter (see eventFilter) re-elides on
                // every resize — the geometry the ACTIVE item ends
                // up with (close button + dot visible) is narrower
                // than any fixed budget guessed right for the
                // inactive ones, and two rounds of fixed budgets
                // clipped the active tab's text raw.
                tw.title->setProperty("fullTitle", title);
                if (!tw.title->property("elideFilter").toBool()) {
                    tw.title->installEventFilter(this);
                    tw.title->setProperty("elideFilter", true);
                }
                const int budget =
                    tw.title->width() > 24
                        ? tw.title->width()
                        : (vertical_ ? 145 : 84);
                tw.title->setText(
                    tw.title->fontMetrics().elidedText(title, Qt::ElideRight, budget));
                // Pinned tabs render compact (icon only) in the
                // horizontal strip. In the vertical list the row is
                // full-width, and a lone letter there read as a tab
                // whose title failed to load — so vertical pinned
                // rows keep their titles.
                tw.title->setVisible(!t.pinned || vertical_);
            }
            if (tw.icon) {
                if (isSettings) {
                    tw.icon->setPixmap(icons::pixmap(
                        icons::Kind::Sliders, QColor(activePalette().muted),
                        slim_ ? 20 : 16));
                    tw.icon->setText(QString());
                    tw.icon->setProperty("hasFavicon", true);
                    tw.icon->setProperty("showingSpinner", false);
                } else if (t.loading) {
                    // The spinner owns the icon while the page loads.
                    tw.icon->setPixmap(
                        icons::spinnerPixmap(spinnerAngle_, spinnerColor(), 16));
                    tw.icon->setText(QString());
                    tw.icon->setProperty("showingSpinner", true);
                } else {
                    // The logo hunt, in the slim rail's order: the
                    // STORE first (durable — survives restarts and
                    // background tabs whose view icon never landed),
                    // then the live view, then the letter. This block
                    // used to skip both lookups unless hasFavicon was
                    // already true, so a tab that started icon-less
                    // (every normal load: the icon arrives after the
                    // row is built) kept its letter forever.
                    tw.icon->setProperty("showingSpinner", false);
                    const QString host =
                        QUrl(QString::fromStdString(t.url)).host();
                    const QPixmap stored = engine_.faviconPixmap(host, 32);
                    QWebEngineView* view = engine_.viewForTab(t.id);
                    if (!stored.isNull()) {
                        tw.icon->setPixmap(stored.scaled(
                            16, 16, Qt::KeepAspectRatio, Qt::SmoothTransformation));
                        tw.icon->setText(QString());
                        tw.icon->setProperty("hasFavicon", true);
                    } else if (view && !view->icon().isNull()) {
                        tw.icon->setPixmap(view->icon().pixmap(16, 16));
                        tw.icon->setText(QString());
                        tw.icon->setProperty("hasFavicon", true);
                    } else if (!tw.icon->property("hasFavicon").toBool()) {
                        setTabIconFallback(tw.icon, host);
                    }
                }
            }
            if (tw.dot) tw.dot->setVisible(browser_.active_tab() == t.id);
            if (tw.close)
                tw.close->setVisible(!t.pinned && (browser_.active_tab() == t.id ||
                                                   item == hoveredTabItem_));
            // Pinned tabs are compact in the horizontal bar; in the
            // sidebar a pinned tab is a full-width row like any
            // other (a 46px row floats out of alignment). In
            // horizontal mode the ACTIVE tab is wider than an
            // inactive one by roughly its dot + close button, so the
            // current page's title is never the most truncated.
            // The active premium is a RATIO (205 vs 150), not just a
            // fixed allowance: if the strip ever compresses items
            // under tab pressure, the active tab keeps its edge in
            // proportion instead of falling to parity.
            item->setSizeHint(vertical_ ? QSize(184, 34)
                                        : (t.pinned ? QSize(46, 34)
                                                    : (browser_.active_tab() == t.id
                                                           ? QSize(205, 34)
                                                           : QSize(150, 34))));
            if (slim_) {
                // Rail rendering: logo only. The title, dot and
                // close button stay built (the classic list uses
                // the same widgets) but never show here.
                if (tw.title) tw.title->setVisible(false);
                if (tw.dot) tw.dot->setVisible(false);
                if (tw.close) tw.close->setVisible(false);
                if (tw.icon && !t.loading && !isSettings) {
                    // The stored logo wins: it survives restarts
                    // and tab restores, where the live view's icon
                    // may not have arrived (or may never, for a
                    // restored background tab).
                    const QString host =
                        QUrl(QString::fromStdString(t.url)).host();
                    const QPixmap stored = engine_.faviconPixmap(host, 40);
                    if (!stored.isNull()) {
                        tw.icon->setPixmap(stored.scaled(
                            20, 20, Qt::KeepAspectRatio, Qt::SmoothTransformation));
                        tw.icon->setText(QString());
                        tw.icon->setProperty("hasFavicon", true);
                    } else if (tw.icon->property("hasFavicon").toBool()) {
                        if (QWebEngineView* v = engine_.viewForTab(t.id))
                            tw.icon->setPixmap(v->icon().pixmap(20, 20));
                    }
                }
                item->setSizeHint(QSize(52, 44));
            }
        }
        item->setToolTip(slim_ && !title.isEmpty()
                             ? title
                             : QString::fromStdString(t.url));
    }
}

void TabStripController::onTabListCurrentChanged(int row) {
    if (row < 0 || syncingTabs_) return;
    QListWidgetItem* item = tabList_->item(row);
    if (!item) return;
    TabId id = static_cast<TabId>(item->data(Qt::UserRole).toULongLong());
    if (!id) return;
    // Show the page at once; the Browser follows through the notify below.
    if (QWidget* page = pages_.value(id, nullptr)) tabStack_->setCurrentWidget(page);
    if (browser_.active_tab() != id) browser_.activate(id);
}

QListWidgetItem* TabStripController::itemForTab(vile::TabId id) const {
    // Indexed: this used to be a linear scan per tab per sync (O(n^2))
    // and per loading tab per spinner tick.
    return itemIndex_.value(id, nullptr);
}

TabStripController::TabWidgets TabStripController::tabWidgets(QWidget* w) {
    TabWidgets tw;
    tw.title = w->property("twTitle").value<QLabel*>();
    if (tw.title) {
        tw.icon = w->property("twIcon").value<QLabel*>();
        tw.dot = w->property("twDot").value<QLabel*>();
        tw.close = w->property("twClose").value<QPushButton*>();
        return tw;
    }
    tw.title = w->findChild<QLabel*>(QStringLiteral("tabTitle"));
    tw.icon = w->findChild<QLabel*>(QStringLiteral("tabIcon"));
    tw.dot = w->findChild<QLabel*>(QStringLiteral("tabDot"));
    tw.close = w->findChild<QPushButton*>(QStringLiteral("tabClose"));
    w->setProperty("twTitle", QVariant::fromValue(tw.title));
    w->setProperty("twIcon", QVariant::fromValue(tw.icon));
    w->setProperty("twDot", QVariant::fromValue(tw.dot));
    w->setProperty("twClose", QVariant::fromValue(tw.close));
    return tw;
}

void TabStripController::refreshSpinnerIcons() {
    const QColor color = spinnerColor();
    for (const auto& t : browser_.tabs()) {
        if (!t.loading) continue;
        if (QListWidgetItem* item = itemForTab(t.id))
            if (QWidget* w = tabList_->itemWidget(item))
                if (QLabel* icon = tabWidgets(w).icon) {
                    icon->setPixmap(icons::spinnerPixmap(spinnerAngle_, color, 16));
                    icon->setText(QString());
                    icon->setProperty("showingSpinner", true);
                }
    }
}

void TabStripController::updateTabClose(QListWidgetItem* item, bool hovered) {
    if (!item) return;
    const auto id = static_cast<TabId>(item->data(Qt::UserRole).toULongLong());
    if (QWidget* w = tabList_->itemWidget(item))
        if (QPushButton* close = tabWidgets(w).close) {
            // Pinned tabs never show a close button.
            const Tab* t = browser_.find(id);
            close->setVisible(!(t && t->pinned) &&
                              (hovered || browser_.active_tab() == id));
        }
}

void TabStripController::setTabIconFallback(QLabel* icon, const QString& host) {
    if (!host.isEmpty() && host.front().isLetter()) {
        icon->setPixmap(QPixmap());
        icon->setText(host.left(1).toUpper());
    } else {
        icon->setText(QString());
        icon->setPixmap(
            icons::pixmap(icons::Kind::Globe, QColor(activePalette().muted), 16));
    }
}

void TabStripController::cycleTab(int direction) {
    if (browser_.tabs().empty()) return;
    const auto& tabs = browser_.tabs();
    int idx = 0;
    if (auto active = browser_.active_tab())
        for (int i = 0; i < static_cast<int>(tabs.size()); ++i)
            if (tabs[i].id == *active) {
                idx = i;
                break;
            }
    int next = (idx + direction + static_cast<int>(tabs.size())) %
               static_cast<int>(tabs.size());
    browser_.activate(tabs[next].id);
}

void TabStripController::reopenClosedTab() {
    if (closedTabs_.empty()) return;
    ClosedTab c = closedTabs_.back();
    closedTabs_.pop_back();
    browser_.open_tab(c.url, std::min(c.index, static_cast<int>(browser_.tabs().size())));
}

QColor TabStripController::spinnerColor() {
    // Cached: the spinner ticks at 10 Hz while pages load, and the naive
    // version built a fresh QSettings (a disk-backed read) on every tick.
    if (!spinnerColorCache_.isValid()) {
        spinnerColorCache_ = QColor(accentById(uiSettings().accent()).focus);
    }
    return spinnerColorCache_;
}

vile::TabId TabStripController::currentTabId() const {
    QWidget* page = tabStack_->currentWidget();
    if (!page) return 0;
    return static_cast<TabId>(page->property("tabId").toULongLong());
}

void TabStripController::onTabCloseClicked() {
    auto* btn = qobject_cast<QPushButton*>(sender());
    if (!btn) return;
    const auto id = static_cast<TabId>(btn->property("tabId").toULongLong());
    if (!id) return;
    browser_.close_tab(id);
    // No "open a fresh tab if that was the last one" here: the sync
    // guarantees a tab exists after ANY close path, uniformly.
}
