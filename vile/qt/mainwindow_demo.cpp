#include "mainwindow.h"
#include "uisettings.h"
#include "downloadspanel.h"
#include "tabstripcontroller.h"
#include <QAction>
#include <QApplication>
#include <QButtonGroup>
#include <QCloseEvent>
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
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QDateTime>
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
#include <QtConcurrent>

using namespace vile;

// Demo-only MainWindow methods, split out of mainwindow.cpp.
// This translation unit is compiled ONLY into the vile-demo
// target (see qt/CMakeLists.txt): the production binary does
// not contain a single demo entry point.

void MainWindow::demoOpenTabs() {
    browser_->open_tab("https://example.com");
    browser_->open_tab("VILE privacy browser");
}

bool MainWindow::demoSettled() const {
    if (browser_->tabs().empty()) return false;
    for (const auto& t : browser_->tabs())
        if (t.loading) return false;
    return true;
}

void MainWindow::demoFocusAddressBar() {
    activateWindow();
    addressBar_->focusBar();
}

void MainWindow::demoShowSuggestions(const QString& text) {
    // Under Xvfb there is no window manager, so the window is never active
    // and setFocus() can't take hold; bypass the focus guard for the demo.
    activateWindow();
    addressBar_->setText(text);
    addressBar_->focusBar();
    addressBar_->setDemoSuggestions(true);
    addressBar_->refreshSuggestions();
    addressBar_->setDemoSuggestions(false);
}

void MainWindow::demoClearFinishedDownloads() { downloadsPanel_->clearFinished(); }

void MainWindow::demoPauseNextDownload() { downloadsPanel_->setPauseNext(true); }

void MainWindow::demoDownloadFile(const QString& url) {
    browser_->open_tab(url.toStdString());
}

bool MainWindow::demoHasFinishedDownload() const { return downloadsPanel_->hasFinished(); }

bool MainWindow::demoHasPausedDownload() const { return downloadsPanel_->hasPaused(); }

void MainWindow::demoPauseDownload() { downloadsPanel_->pauseFirstActive(); }

void MainWindow::demoMiddleClickActiveTab() {
    if (!browser_ || !tabStripCtl_) return;
    const auto active = browser_->active_tab();
    if (!active) return;
    QListWidgetItem* item = tabStripCtl_->itemForTab(*active);
    if (!item) return;
    const QRect rect = tabStripCtl_->list()->visualItemRect(item);
    const QPoint center = rect.center();
    QMouseEvent press(QEvent::MouseButtonPress, QPointF(center),
                      QPointF(tabStripCtl_->list()->viewport()->mapToGlobal(center)),
                      Qt::MiddleButton, Qt::MiddleButton, Qt::NoModifier);
    QApplication::sendEvent(tabStripCtl_->list()->viewport(), &press);
}

void MainWindow::demoResumeDownload() { downloadsPanel_->resumePaused(); }

void MainWindow::demoSetDownloadFolder(const QString& path) {
    uiSettings().setDownloadsFolder(path);
}

void MainWindow::demoSetAskEachTime(bool on) {
    uiSettings().setAskWhereSave(on);
}

void MainWindow::demoResetDownloadFolder() {
    uiSettings().resetDownloadsFolder();
    uiSettings().setAskWhereSave(false);
}

void MainWindow::demoCloseCurrentTab() {
    // The Browser's active tab, not the UI's: the tab switch may not have
    // painted yet when the demo calls this.
    if (browser_)
        if (auto id = browser_->active_tab()) browser_->close_tab(*id);
}

void MainWindow::demoFindInPage(const QString& text) {
    findBar_->showBar();
    findBar_->setText(text);
}

void MainWindow::demoResetAddressBar() {
    addressBar_->clear();
    if (tabStripCtl_) tabStripCtl_->focusCurrentPage();
}

void MainWindow::demoBookmarkCurrentTab() {
    const Tab* t = browser_ ? browser_->find(currentTabId()) : nullptr;
    if (!t || t->url.empty() || t->url == "about:blank") return;
    bookmarks_.add(t->url, t->title);
    refreshBookmarks();
    refreshBookmarkStar();
}

void MainWindow::demoHideFindBar() { findBar_->hideBar(); }
