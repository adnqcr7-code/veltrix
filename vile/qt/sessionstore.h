#pragma once
// SessionStore (Qt layer): owns saving and reading back the tab
// session — which tabs were open and which was active — on top of the
// backend SettingsStore. Extracted from MainWindow, where saveSession
// ran unguarded from the sync path until its guard moved inside; the
// guard, the warn-once, the saved-marker ordering and the history gate
// all live here now, by construction.
//
// Policy (unchanged from when this lived in MainWindow):
//   - Nothing is stored while history saving is off (privacy promise).
//   - A save is deferred while any tab is still loading from blank —
//     persisting "about:blank" for a restoring tab would lose its URL.
//   - The write is transactional and the saved-marker advances only
//     after it lands, so a failed write is retried by a later sync.
//   - Reading is gated on BOTH the restore preference and history.
#include <QObject>
#include <QString>
#include <vector>

namespace vile {
class Browser;
class SettingsStore;
}  // namespace vile

class SessionStore : public QObject {
    Q_OBJECT
public:
    SessionStore(vile::SettingsStore& store, vile::Browser& browser,
                 QObject* parent = nullptr);

    // Persist the current tabs. Guarded internally: a storage failure
    // emits storageWarning once and never throws.
    void save(bool historyEnabled);

    // The stored tab URLs + active index, or empty when restoring is
    // off, history is off, or nothing was stored. Also guarded.
    std::vector<std::string> savedTabs(bool historyEnabled, bool restoreEnabled,
                                       int* activeIndex);

signals:
    void storageWarning(const QString& message);

private:
    vile::SettingsStore& store_;
    vile::Browser& browser_;
    QString lastSaved_;       // dedupes no-change syncs
    bool warned_ = false;     // the failure warning shows once
    bool privateCleared_ = false;  // stored keys already wiped for
                                   // this private-mode stretch
};
