// The Bookmarks dock page, extracted from MainWindow: the saved
// pages as cards (site letter, title, host) — the same row language
// as History and Downloads. The window owns the bookmark store: it
// pushes the list in and hears openUrl / removeRequested.
#pragma once

#include <QWidget>

#include <vector>

#include "vile/storage.hpp"

class QLabel;
class QListWidget;
class QPushButton;

class FaviconStore;

class BookmarksPanel : public QWidget {
    Q_OBJECT
public:
    explicit BookmarksPanel(QWidget* parent = nullptr);

    void showBookmarks(const std::vector<vile::Bookmark>& marks);
    void setFaviconStore(FaviconStore* store) { favicons_ = store; }
    QListWidget* listWidget() const { return list_; }

signals:
    void openUrl(const QString& url);
    void removeRequested(qint64 bookmarkId);

private:
    FaviconStore* favicons_ = nullptr;
    QLabel* empty_ = nullptr;
    QListWidget* list_ = nullptr;
    QPushButton* removeBtn_ = nullptr;
};
