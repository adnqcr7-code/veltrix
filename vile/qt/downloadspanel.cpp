#include "downloadspanel.h"

#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QFontMetrics>
#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QProgressBar>
#include <QPushButton>
#include <QStandardPaths>
#include <QUrl>
#include <QVBoxLayout>
#include <QWebEngineDownloadRequest>

#include "entryrow.h"
#include "icons.h"
#include "uisettings.h"

DownloadsPanel::DownloadsPanel(QWidget* parent) : QWidget(parent) {
    auto* lay = new QVBoxLayout(this);
    lay->setContentsMargins(16, 16, 16, 16);
    lay->setSpacing(12);
    auto* dlTitle = new QLabel(tr("Downloads"));
    dlTitle->setObjectName(QStringLiteral("panelTitle"));
    lay->addWidget(dlTitle);
    empty_ = new QLabel(this);
    empty_->setObjectName(QStringLiteral("mutedLabel"));
    empty_->setWordWrap(true);
    lay->addWidget(empty_);
    list_ = new QListWidget;
    // One name only: a second setObjectName here used to clobber
    // "entryWell" with "downloadList", silently un-welling this
    // panel while its siblings got the well.
    list_->setObjectName(QStringLiteral("entryWell"));
    list_->setSpacing(8);
    lay->addWidget(list_, 1);
    // Clears finished / cancelled / interrupted rows (in-progress ones
    // stay — clearing must never kill an active download).
    clearBtn_ = new QPushButton(tr("Clear finished"));
    clearBtn_->setObjectName(QStringLiteral("secondaryAction"));
    clearBtn_->setEnabled(false);
    connect(clearBtn_, &QPushButton::clicked, this, &DownloadsPanel::clearFinished);
    auto* clearDlRow = new QHBoxLayout;
    clearDlRow->addWidget(clearBtn_);
    clearDlRow->addStretch(1);
    lay->addLayout(clearDlRow);
    lay->addStretch(1);  // surplus lands here; the well hugs its content
    auto* foot = new QLabel(
        tr("Downloads land in the folder from Settings. In-progress "
           "downloads are never cleared."),
        this);
    foot->setObjectName(QStringLiteral("panelFoot"));
    foot->setWordWrap(true);
    lay->addWidget(foot);
    refreshEmptyNote();
}

bool DownloadsPanel::hasFinished() const {
    for (const auto& up : items_) {
        const Item& d = *up;
        if (d.request &&
            d.request->state() == QWebEngineDownloadRequest::DownloadCompleted)
            return true;
    }
    return false;
}

int DownloadsPanel::finishedCount() const {
    int n = 0;
    for (const auto& up : items_) {
        const Item& d = *up;
        if (d.request &&
            d.request->state() == QWebEngineDownloadRequest::DownloadCompleted)
            ++n;
    }
    return n;
}

bool DownloadsPanel::hasPaused() const {
    for (const auto& up : items_) {
        const Item& d = *up;
        if (d.request && d.request->isPaused()) return true;
    }
    return false;
}

void DownloadsPanel::pauseFirstActive() {
    for (auto& up : items_) {
        Item& d = *up;
        if (d.request &&
            d.request->state() == QWebEngineDownloadRequest::DownloadInProgress &&
            !d.request->isPaused()) {
            d.request->pause();
            return;
        }
    }
}

void DownloadsPanel::resumePaused() {
    for (auto& up : items_) {
        Item& d = *up;
        if (d.request && d.request->isPaused()) d.request->resume();
    }
}

QString DownloadsPanel::formatBytes(qint64 bytes) {
    if (bytes < 1024) return tr("%1 B").arg(bytes);
    if (bytes < 1024 * 1024) return tr("%1 KB").arg(bytes / 1024.0, 0, 'f', 1);
    if (bytes < 1024 * 1024 * 1024) return tr("%1 MB").arg(bytes / 1048576.0, 0, 'f', 1);
    return tr("%1 GB").arg(bytes / 1073741824.0, 0, 'f', 1);
}

void DownloadsPanel::addDownload(QWebEngineDownloadRequest* dl) {
    // "Ask where to save each file": the request must be answered
    // inside this emission — Qt destroys an unanswered
    // QWebEngineDownloadRequest when the signal unwinds, so the
    // dialog cannot be deferred to a later event-loop turn (a queued
    // version of this code silently lost every ask-mode download).
    // It CAN be guarded: if a save dialog is already open, a second
    // arrival does not nest another modal loop inside it — it takes
    // the default destination instead, and its row shows where it
    // went.
    if (uiSettings().askWhereSave()) {
        if (askActive_) {
            const QString name = dl->downloadFileName();
            startDownload(dl, QString(), QString());
            emit downloadDiverted(name);
            return;
        }
        askActive_ = true;
        QString dir = uiSettings().downloadsFolder();
        if (dir.isEmpty())
            dir = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
        QDir().mkpath(dir);
        QString name = dl->downloadFileName();
        if (name.isEmpty()) name = tr("download");
        if (modalOpened_) modalOpened_();
        const QString chosen = QFileDialog::getSaveFileName(
            this, tr("Save download"), dir + '/' + name);
        askActive_ = false;
        if (modalClosed_) modalClosed_();
        if (chosen.isEmpty()) {
            dl->cancel();
            return;
        }
        startDownload(dl, QFileInfo(chosen).absolutePath(), QFileInfo(chosen).fileName());
        return;
    }
    startDownload(dl, QString(), QString());
}

void DownloadsPanel::startDownload(QWebEngineDownloadRequest* dl,
                                   const QString& chosenDir, const QString& chosenName) {
    // Destination: the dialog's choice when given, else the download
    // folder with a unique name when the file already exists
    // ("file (1).pdf"). Either way the panel opens so the download is
    // visible, with Cancel.
    QString dir = chosenDir;
    QString unique = chosenName;
    if (dir.isEmpty()) {
        dir = uiSettings().downloadsFolder();
        if (dir.isEmpty())
            dir = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
        QDir().mkpath(dir);
        unique = dl->downloadFileName();
        if (unique.isEmpty()) unique = tr("download");
        const QString name = unique;
        const int dot = name.lastIndexOf('.');
        const QString stem = dot > 0 ? name.left(dot) : name;
        const QString ext = dot > 0 ? name.mid(dot) : QString();
        int n = 1;
        while (QFile::exists(dir + '/' + unique))
            unique = QStringLiteral("%1 (%2)%3").arg(stem).arg(n++).arg(ext);
    }
    dl->setDownloadDirectory(dir);
    dl->setDownloadFileName(unique);
    dl->accept();

    auto item = std::make_unique<Item>();
    item->id = nextId_++;
    item->request = dl;
    item->fileName = unique;
    item->path = dir + '/' + unique;
    Item& added = *item;
    items_.push_back(std::move(item));
    byId_[added.id] = &added;
    const quint64 id = added.id;

    auto* rowWidget = new QWidget;
    rowWidget->setObjectName(QStringLiteral("downloadRow"));
    auto* rowLay = new QVBoxLayout(rowWidget);
    rowLay->setContentsMargins(10, 8, 10, 8);
    rowLay->setSpacing(4);
    auto* topRow = new QHBoxLayout;
    topRow->setContentsMargins(0, 0, 0, 0);
    added.row.nameLabel = new QLabel(unique, rowWidget);
    topRow->addWidget(added.row.nameLabel, 1);
    added.row.pauseBtn = new QPushButton(rowWidget);
    added.row.pauseBtn->setObjectName(QStringLiteral("navButton"));
    added.row.pauseBtn->setIcon(icons::icon(icons::Kind::Pause));
    added.row.pauseBtn->setToolTip(tr("Pause"));
    added.row.pauseBtn->setFixedSize(30, 28);
    connect(added.row.pauseBtn, &QPushButton::clicked, this, [this, id] {
        if (auto* d = find(id); d && d->request) {
            if (d->request->isPaused()) d->request->resume();
            else d->request->pause();
        }
    });
    topRow->addWidget(added.row.pauseBtn);
    added.row.actionBtn = new QPushButton(tr("Cancel"), rowWidget);
    added.row.actionBtn->setObjectName(QStringLiteral("navButton"));
    connect(added.row.actionBtn, &QPushButton::clicked, this, [this, id] {
        if (auto* d = find(id); d && d->request) {
            if (d->request->state() == QWebEngineDownloadRequest::DownloadInProgress)
                d->request->cancel();
            else if (d->request->state() == QWebEngineDownloadRequest::DownloadCompleted)
                QDesktopServices::openUrl(QUrl::fromLocalFile(d->path));
        }
    });
    topRow->addWidget(added.row.actionBtn);
    rowLay->addLayout(topRow);
    added.row.bar = new QProgressBar(rowWidget);
    added.row.bar->setTextVisible(false);
    added.row.bar->setFixedHeight(6);
    rowLay->addWidget(added.row.bar);
    added.row.statusLabel = new QLabel(rowWidget);
    added.row.statusLabel->setObjectName(QStringLiteral("mutedLabel"));
    rowLay->addWidget(added.row.statusLabel);
    added.row.widget = rowWidget;

    auto* listItem = new QListWidgetItem(list_);
    list_->addItem(listItem);
    list_->setItemWidget(listItem, rowWidget);
    added.listItem = listItem;
    // Height only: a full-width sizeHint makes the item wider than the
    // viewport and pushes the action button off-screen.
    listItem->setSizeHint(QSize(0, rowWidget->sizeHint().height()));
    refreshEmptyNote();

    connect(dl, &QWebEngineDownloadRequest::receivedBytesChanged, this,
            [this, id] { if (auto* d = find(id)) refreshRow(*d); });
    connect(dl, &QWebEngineDownloadRequest::totalBytesChanged, this,
            [this, id] { if (auto* d = find(id)) refreshRow(*d); });
    connect(dl, &QWebEngineDownloadRequest::stateChanged, this,
            [this, id] { if (auto* d = find(id)) refreshRow(*d); });
    connect(dl, &QWebEngineDownloadRequest::isPausedChanged, this,
            [this, id] { if (auto* d = find(id)) refreshRow(*d); });
    refreshRow(added);
    if (pauseNext_) {
        pauseNext_ = false;
        dl->pause();
    }
    emit downloadStarted();
}

void DownloadsPanel::refreshIcons() {
    // refreshRow re-sets the pause/play icon from the download's
    // live state; the rest of what it touches (labels, bar) is
    // state-derived too, so re-running it is harmless.
    for (auto& item : items_) refreshRow(*item);
}

void DownloadsPanel::refreshRow(Item& item) {
    auto* dl = item.request.data();
    if (!dl) return;  // the request died with its profile; the row is stale
    const qint64 received = dl->receivedBytes();
    const qint64 total = dl->totalBytes();
    const auto state = dl->state();
    QFontMetrics metrics(item.row.nameLabel->font());
    const int nameWidth = list_ ? list_->viewport()->width() - 90 : 200;
    item.row.nameLabel->setText(
        metrics.elidedText(item.fileName, Qt::ElideMiddle, qMax(nameWidth, 60)));
    if (state == QWebEngineDownloadRequest::DownloadInProgress) {
        item.row.bar->show();
        const bool paused = dl->isPaused();
        item.row.bar->setMaximum(total > 0 ? 100 : 0);
        item.row.bar->setValue(total > 0 ? static_cast<int>(received * 100 / total) : 0);
        item.row.statusLabel->setText(
            total > 0
                ? (paused ? tr("Paused · %1 of %2").arg(formatBytes(received), formatBytes(total))
                          : tr("%1 of %2").arg(formatBytes(received), formatBytes(total)))
                : (paused ? tr("Paused · %1 received").arg(formatBytes(received))
                          : tr("%1 received").arg(formatBytes(received))));
        item.row.pauseBtn->setIcon(
            icons::icon(paused ? icons::Kind::Play : icons::Kind::Pause));
        item.row.pauseBtn->setToolTip(paused ? tr("Resume") : tr("Pause"));
        item.row.pauseBtn->show();
        item.row.actionBtn->setText(tr("Cancel"));
        item.row.actionBtn->show();
    } else if (state == QWebEngineDownloadRequest::DownloadCompleted) {
        // A full violet bar under "Finished" reads as still-in-progress;
        // the status text already says everything.
        item.row.bar->hide();
        item.row.statusLabel->setText(
            tr("Finished · %1").arg(formatBytes(total > 0 ? total : received)));
        item.row.pauseBtn->hide();
        item.row.actionBtn->setText(tr("Open"));
        item.row.actionBtn->show();
    } else if (state == QWebEngineDownloadRequest::DownloadCancelled) {
        item.row.bar->hide();
        item.row.statusLabel->setText(tr("Cancelled"));
        item.row.pauseBtn->hide();
        item.row.actionBtn->hide();
    } else {  // DownloadInterrupted
        item.row.bar->hide();
        item.row.statusLabel->setText(tr("Interrupted"));
        item.row.pauseBtn->hide();
        item.row.actionBtn->hide();
    }
    refreshClear();
}

QList<quint64> DownloadsPanel::downloadIds() const {
    QList<quint64> ids;
    for (const auto& item : items_) ids.append(item->id);
    return ids;
}

bool DownloadsPanel::pauseDownload(quint64 id) {
    auto* d = find(id);
    if (!d || !d->request) return false;
    d->request->pause();
    return true;
}

bool DownloadsPanel::resumeDownload(quint64 id) {
    auto* d = find(id);
    if (!d || !d->request) return false;
    d->request->resume();
    return true;
}

bool DownloadsPanel::downloadPaused(quint64 id) const {
    auto it = byId_.find(id);
    if (it == byId_.end() || !it.value()->request) return false;
    return it.value()->request->isPaused();
}

DownloadsPanel::Item* DownloadsPanel::find(quint64 id) {
    // O(1): the four per-byte signal handlers used to linear-scan a
    // vector for every event.
    return byId_.value(id, nullptr);
}

void DownloadsPanel::refreshEmptyNote() {
    if (!empty_) return;
    const QString dir = uiSettings().downloadsFolder();
    empty_->setText(tr("No downloads yet. Files save to %1.").arg(dir));
    empty_->setVisible(items_.empty());
    // Same rule as Bookmarks: the note is the empty state, so the
    // well hides while empty and hugs its rows otherwise.
    list_->setVisible(!items_.empty());
    if (!items_.empty()) entryrow::fitWell(list_);
}

void DownloadsPanel::refreshClear() {
    if (!clearBtn_) return;
    bool any = false;
    for (const auto& up : items_) {
        const Item& d = *up;
        if (!d.request) continue;
        const auto s = d.request->state();
        if (s == QWebEngineDownloadRequest::DownloadCompleted ||
            s == QWebEngineDownloadRequest::DownloadCancelled ||
            s == QWebEngineDownloadRequest::DownloadInterrupted) {
            any = true;
            break;
        }
    }
    clearBtn_->setEnabled(any);
}

void DownloadsPanel::clearFinished() {
    // Walk backwards so erasing doesn't shift the indices still to
    // visit. Erasing an entry destroys exactly that Item (heap-owned);
    // the survivors' Items — and their index entries — are untouched.
    auto removeRow = [this](Item& item) {
        if (QListWidgetItem* li = item.listItem) {
            // removeItemWidget first: the row widget is ours to delete,
            // and takeItem hands the item back for deletion.
            list_->removeItemWidget(li);
            delete item.row.widget;
            delete list_->takeItem(list_->row(li));
        }
    };
    for (int i = static_cast<int>(items_.size()) - 1; i >= 0; --i) {
        Item& item = *items_[i];
        if (item.request) {
            const auto s = item.request->state();
            if (s != QWebEngineDownloadRequest::DownloadCompleted &&
                s != QWebEngineDownloadRequest::DownloadCancelled &&
                s != QWebEngineDownloadRequest::DownloadInterrupted)
                continue;  // in progress (incl. paused) — leave it alone
        }  // a null request died with its profile: its row is stale
        removeRow(item);
        byId_.remove(item.id);
        items_.erase(items_.begin() + i);
    }
    refreshEmptyNote();
    refreshClear();
}
