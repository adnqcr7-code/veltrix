#include "sessionstore.h"

#include "vile/browser.hpp"
#include "vile/storage.hpp"

#include <QStringList>

SessionStore::SessionStore(vile::SettingsStore& store, vile::Browser& browser,
                           QObject* parent)
    : QObject(parent), store_(store), browser_(browser) {}

void SessionStore::save(bool historyEnabled) {
    // History off IS private mode: the session is not persisted either —
    // a list of open-tab URLs is browsing history by another name, and
    // restoring it later would leak the private session back. The
    // stored keys are actively CLEARED (once per private stretch, not
    // on every sync) rather than merely left for the read path to
    // blank: what privacy mode promises should not depend on nobody
    // reading the raw settings first.
    if (!historyEnabled) {
        if (!privateCleared_) {
            lastSaved_.clear();
            try {
                store_.set_many({{"session/tabs", ""}, {"session/active", "0"}});
                privateCleared_ = true;  // only a landed wipe counts
            } catch (const std::exception&) {
                // A failed wipe is retried by the read path's blanking;
                // save() must never throw into the sync path.
            }
        }
        return;
    }
    privateCleared_ = false;
    // A tab that is loading from about:blank has no real URL yet (it is
    // mid-restore or mid-navigation): defer the write until its URL
    // lands, or a half-restored session would overwrite the saved one.
    for (const auto& t : browser_.tabs())
        if (t.loading && t.url == "about:blank") return;
    QStringList urls;
    int activeIdx = 0;
    const auto& tabs = browser_.tabs();
    for (int i = 0; i < static_cast<int>(tabs.size()); ++i) {
        urls << QString::fromStdString(tabs[i].url);
        if (browser_.active_tab() && tabs[i].id == *browser_.active_tab())
            activeIdx = i;
    }
    // Only the page addresses are saved — never cookies or site data.
    const QString s = urls.join('\n') + QStringLiteral("\n#") + QString::number(activeIdx);
    if (s == lastSaved_) return;
    // Guarded HERE, not at call sites: save runs from syncTabs (the
    // hottest path in the window), aboutToQuit and closeEvent —
    // enumerating guards per call site missed two of the three. The
    // write is transactional and the saved-marker advances only AFTER
    // it lands, so a failed write is retried by a later sync.
    try {
        store_.set_many({
            {"session/tabs", urls.join('\n').toStdString()},
            {"session/active", std::to_string(activeIdx)},
        });
        lastSaved_ = s;
    } catch (const std::exception& e) {
        if (!warned_) {
            warned_ = true;
            emit storageWarning(
                tr("Saving the session failed: %1\n\nThe rest of your data is untouched.")
                    .arg(QString::fromUtf8(e.what())));
        }
    }
}

std::vector<std::string> SessionStore::savedTabs(bool historyEnabled, bool restoreEnabled,
                                                 int* activeIndex) {
    if (activeIndex) *activeIndex = 0;
    try {
        if (!historyEnabled) {
            // A session saved by an earlier non-private run must not be
            // resurrected into a private one. Drop the stored keys.
            store_.set("session/tabs", "");
            store_.set("session/active", "0");
            return {};
        }
        if (!restoreEnabled) return {};
        const std::string saved = store_.get_or("session/tabs", "");
        if (saved.empty()) return {};
        const QStringList urls = QString::fromStdString(saved).split('\n');
        const int idx =
            QString::fromStdString(store_.get_or("session/active", "0")).toInt();
        if (activeIndex) *activeIndex = idx;
        // Prime the saved-marker: the restored state IS the saved
        // state, so the first sync after restore writes nothing.
        lastSaved_ = urls.join('\n') + QStringLiteral("\n#") + QString::number(idx);
        std::vector<std::string> out;
        for (const QString& u : urls) out.push_back(u.toStdString());
        return out;
    } catch (const std::exception&) {
        return {};  // a broken store must never block startup
    }
}
