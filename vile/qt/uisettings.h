#pragma once
// UiSettings: the ONE owner of the Qt layer's QSettings preferences.
//
// Before this class, ~19 sites across main.cpp, MainWindow and
// SettingsDialog each constructed their own QSettings("VILE","VILE")
// and restated the defaults — so the same key had as many default
// statements as readers, and hot paths (the address bar's textChanged,
// per keystroke) did disk-backed reads. Here:
//   - every key and its default is stated exactly once, below;
//   - hot-path values (accent, suggestions, vertical tabs) are cached
//     in memory and kept current by the setters;
//   - setters emit changed(key) so owners can react live.
// Privacy *policy* does NOT live here — that is vile::PrivacySettings
// in the SQLite store, saved transactionally. This is UI preference
// only: accent, layout, downloads folder, per-site zoom, NTP toggles.
#include <QObject>
#include <QSettings>
#include <QString>
#include <QStringList>

// Every QSettings key, stated exactly once, HERE — including the
// three the newest features first wrote as inline literals in the
// .cpp (round 12's architecture review caught the erosion). The
// changed() signal carries these constants, and consumers (e.g.
// MainWindow watching the downloads folder) compare against them
// rather than restating the string.
namespace uisettings_keys {
inline const QString kAccent = QStringLiteral("ui/accent");
inline const QString kTheme = QStringLiteral("ui/theme");
inline const QString kVerticalTabs = QStringLiteral("ui/verticalTabs");
inline const QString kRestoreSession = QStringLiteral("ui/restoreSession");
inline const QString kSuggestions = QStringLiteral("privacy/suggestions");
inline const QString kDownloadsFolder = QStringLiteral("downloads/folder");
inline const QString kAskWhereSave = QStringLiteral("downloads/askEachTime");
inline const QString kNtpClock = QStringLiteral("ntp/showClock");
inline const QString kNtpTiles = QStringLiteral("ntp/showTiles");
inline const QString kNtpVisited = QStringLiteral("ntp/showVisited");
inline const QString kNtpStats = QStringLiteral("ntp/showStats");
inline const QString kUserDomains = QStringLiteral("shield/userDomains");
inline const QString kForceDarkPages = QStringLiteral("appearance/forceDarkPages");
inline const QString kRailHoverExpand = QStringLiteral("ui/railHoverExpand");
inline const QString kRailCollapseDelay = QStringLiteral("ui/railCollapseDelayMs");
inline const QString kZoomPrefix = QStringLiteral("zoom/");
}  // namespace uisettings_keys

class UiSettings : public QObject {
    Q_OBJECT
public:
    explicit UiSettings(QObject* parent = nullptr);

    // Appearance / layout.
    QString accent() const { return accent_; }
    void setAccent(const QString& id);
    // "dark" (default) or "light" — the palette choice. The accent
    // stays the brand violet in both.
    QString theme() const { return theme_; }
    void setTheme(const QString& id);
    bool verticalTabs() const { return verticalTabs_; }
    void setVerticalTabs(bool on);

    // Tab rail behaviour: hovering the slim rail expands it to show
    // tab titles; it collapses again this long after the pointer
    // leaves. Both user-editable (Settings → Appearance).
    bool railHoverExpand() const;
    void setRailHoverExpand(bool on);
    int railCollapseDelayMs() const;
    void setRailCollapseDelayMs(int ms);

    // Behaviour toggles.
    bool restoreSession() const;
    void setRestoreSession(bool on);
    bool suggestions() const { return suggestions_; }
    void setSuggestions(bool on);

    // Downloads. folder() returns the EFFECTIVE folder (the stored one,
    // or the system Downloads location when unset).
    QString downloadsFolder() const;
    void setDownloadsFolder(const QString& dir);
    void resetDownloadsFolder();
    bool askWhereSave() const;
    void setAskWhereSave(bool on);

    // New tab page sections.
    bool ntpShowClock() const;
    void setNtpShowClock(bool on);
    bool ntpShowTiles() const;
    void setNtpShowTiles(bool on);
    bool ntpShowVisited() const;
    void setNtpShowVisited(bool on);
    bool ntpShowStats() const;
    void setNtpShowStats(bool on);

    // The user's OWN blocked domains (Settings → Privacy & Shield):
    // a personal list layered over the maintained blocklist, stored
    // only on this device.
    QStringList userBlockedDomains() const;
    void setUserBlockedDomains(const QStringList& domains);

    // Ask sites for their dark theme (prefers-color-scheme: dark;
    // search engines included). Read once at startup — changing it
    // applies on the next launch.
    bool forceDarkPages() const;
    void setForceDarkPages(bool on);

    // Per-site zoom: 1.0 means "no stored factor" (the key is removed).
    double zoomForHost(const QString& host) const;
    void setZoomForHost(const QString& host, double factor);

signals:
    void changed(const QString& key);

private:
    QSettings store_;
    QString accent_;
    QString theme_;
    bool verticalTabs_ = true;
    bool suggestions_ = true;
};

// The process-wide instance. QSettings itself is process-global state;
// this gives it one owner with one set of defaults instead of nineteen
// ad-hoc constructions.
UiSettings& uiSettings();
