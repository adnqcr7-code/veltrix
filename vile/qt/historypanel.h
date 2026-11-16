// The History dock page, extracted from MainWindow: a search field
// and the visit list, rendered as cards (site letter, title, host ·
// time) — the same row language as the Downloads page. The window
// owns the history store: it pushes entries in and hears openUrl /
// clearRequested / searchChanged.
#pragma once

#include <QWidget>

#include <vector>

#include "vile/storage.hpp"

class QLineEdit;
class QListWidget;

class FaviconStore;

class HistoryPanel : public QWidget {
    Q_OBJECT
public:
    explicit HistoryPanel(QWidget* parent = nullptr);

    void showEntries(const std::vector<vile::HistoryEntry>& entries);
    void setFaviconStore(FaviconStore* store) { favicons_ = store; }
    QString searchText() const;
    QListWidget* listWidget() const { return list_; }

signals:
    void openUrl(const QString& url);
    void clearRequested();
    void searchChanged();

private:
    FaviconStore* favicons_ = nullptr;
    QLineEdit* search_ = nullptr;
    QListWidget* list_ = nullptr;
};
