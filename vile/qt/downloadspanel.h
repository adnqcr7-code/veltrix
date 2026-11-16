#pragma once
// DownloadsPanel: the Downloads dock page AND the owner of every
// in-flight download — extracted from MainWindow, where the panel
// widgets, the DownloadItem vector, a linear findDownload() scan from
// four per-byte signal handlers, and the row plumbing all lived in the
// window class. Here:
//   - each download is tracked in a hash keyed by a per-item id, so
//     the per-byte-change signals resolve in O(1);
//   - requests are held through QPointer, so a request that dies
//     before its row is refreshed can never dangle;
//   - the destination policy (downloads folder, unique names, the
//     "ask where to save" dialog) lives with the feature it serves.
#include <QHash>
#include <QPointer>
#include <QString>
#include <QWidget>
#include <functional>
#include <deque>
#include <memory>

class QLabel;
class QListWidget;
class QListWidgetItem;
class QPushButton;
class QProgressBar;
class QWebEngineDownloadRequest;

class DownloadsPanel : public QWidget {
    Q_OBJECT
public:
    explicit DownloadsPanel(QWidget* parent = nullptr);

    // Takes over a fresh download: chooses the destination (asking
    // via a save dialog when that setting is on), accepts the
    // request, builds its row and wires its progress signals. Emits
    // downloadStarted when a row was added (a cancelled save dialog
    // adds none).
    void addDownload(QWebEngineDownloadRequest* dl);

    // Removes finished / cancelled / interrupted rows; in-progress
    // (including paused) downloads are never cleared.
    void clearFinished();

    // Panel state the window and the demo need.
    void refreshEmptyNote();  // the empty-state line names the folder
    // Re-draw the rows' pause/play icons from the CURRENT palette —
    // they are pixmaps baked at row creation, so a live theme switch
    // would otherwise leave them in the outgoing theme (round 14).
    void refreshIcons();
    bool hasFinished() const;
    // The window's modal scrim, shown while the save dialog is up:
    // the dialog is a separate top-level, but the window behind it
    // should still read as inactive, like the Settings stack.
    void setModalHooks(std::function<void()> onOpen, std::function<void()> onClose) {
        modalOpened_ = std::move(onOpen);
        modalClosed_ = std::move(onClose);
    }
    int count() const { return static_cast<int>(items_.size()); }
    // Id-addressed access, resolved through the same index the
    // request signals use — for the demo and for tests that need to
    // prove a row's identity, not just the container's size.
    QList<quint64> downloadIds() const;
    bool pauseDownload(quint64 id);          // pauses (not resumes)
    bool resumeDownload(quint64 id);
    bool downloadPaused(quint64 id) const;   // false for unknown ids
    int finishedCount() const;
    bool hasPaused() const;
    void pauseFirstActive();
    void resumePaused();
    // Demo hook: pause the next download the moment it starts (the
    // demo's throttled server exists to exercise pause/resume).
    void setPauseNext(bool on) { pauseNext_ = on; }

signals:
    void downloadStarted();
    // An ask-mode download arrived while a save dialog was open and
    // took the default destination instead (see addDownload): the
    // window surfaces this so the substitution is never silent.
    void downloadDiverted(const QString& fileName);

private:
    // startDownload is addDownload's tail once the destination is
    // known: it accepts the request, builds the row, wires signals.
    void startDownload(QWebEngineDownloadRequest* dl, const QString& chosenDir,
                       const QString& chosenName);

    struct Row {
        QWidget* widget = nullptr;
        QLabel* nameLabel = nullptr;
        QLabel* statusLabel = nullptr;
        QProgressBar* bar = nullptr;
        QPushButton* pauseBtn = nullptr;   // Pause / Resume while active
        QPushButton* actionBtn = nullptr;  // Cancel while active, Open when finished
    };
    // Items are heap objects owned by a deque of unique_ptr, and the
    // index is keyed by a per-item id assigned at add:
    //   - an Item's address is fixed from creation to erasure, so an
    //     Item* in the index cannot dangle or start pointing at a
    //     different download (a plain vector's reallocation dangled
    //     entries; a deque of values still move-assigns elements
    //     across nodes on a middle erase, re-pointing entries at
    //     their neighbours);
    //   - the id, never the request address, is the identity: a
    //     request address can be recycled by a later request, an id
    //     cannot.
    struct Item {
        quint64 id = 0;
        QPointer<QWebEngineDownloadRequest> request;
        QString fileName;
        QString path;
        QListWidgetItem* listItem = nullptr;
        Row row;
    };
    Item* find(quint64 id);
    void refreshRow(Item& item);
    void refreshClear();
    static QString formatBytes(qint64 bytes);

    QListWidget* list_ = nullptr;
    QLabel* empty_ = nullptr;
    QPushButton* clearBtn_ = nullptr;
    // True while a save dialog is open: a download arriving in that
    // window takes the default destination instead of nesting a
    // second modal dialog inside the first (see addDownload).
    bool askActive_ = false;
    std::function<void()> modalOpened_, modalClosed_;
    std::deque<std::unique_ptr<Item>> items_;
    QHash<quint64, Item*> byId_;
    quint64 nextId_ = 1;
    bool pauseNext_ = false;
};
