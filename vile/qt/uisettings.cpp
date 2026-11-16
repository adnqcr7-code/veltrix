#include "uisettings.h"

#include <QStandardPaths>

using namespace uisettings_keys;

UiSettings& uiSettings() {
    static UiSettings instance;
    return instance;
}

UiSettings::UiSettings(QObject* parent)
    : QObject(parent), store_(QStringLiteral("VILE"), QStringLiteral("VILE")) {
    accent_ = store_.value(kAccent, QStringLiteral("violet")).toString();
    theme_ = store_.value(kTheme, QStringLiteral("dark")).toString();
    verticalTabs_ = store_.value(kVerticalTabs, true).toBool();
    suggestions_ = store_.value(kSuggestions, true).toBool();
}

void UiSettings::setAccent(const QString& id) {
    accent_ = id;
    store_.setValue(kAccent, id);
    emit changed(kAccent);
}

void UiSettings::setTheme(const QString& id) {
    theme_ = id;
    store_.setValue(kTheme, id);
    emit changed(kTheme);
}

void UiSettings::setVerticalTabs(bool on) {
    verticalTabs_ = on;
    store_.setValue(kVerticalTabs, on);
    emit changed(kVerticalTabs);
}

bool UiSettings::railHoverExpand() const {
    return store_.value(kRailHoverExpand, true).toBool();
}

void UiSettings::setRailHoverExpand(bool on) {
    store_.setValue(kRailHoverExpand, on);
    emit changed(kRailHoverExpand);
}

int UiSettings::railCollapseDelayMs() const {
    return store_.value(kRailCollapseDelay, 1000).toInt();
}

void UiSettings::setRailCollapseDelayMs(int ms) {
    store_.setValue(kRailCollapseDelay, ms);
    emit changed(kRailCollapseDelay);
}

bool UiSettings::restoreSession() const {
    return store_.value(kRestoreSession, true).toBool();
}

void UiSettings::setRestoreSession(bool on) {
    store_.setValue(kRestoreSession, on);
    emit changed(kRestoreSession);
}

void UiSettings::setSuggestions(bool on) {
    suggestions_ = on;
    store_.setValue(kSuggestions, on);
    emit changed(kSuggestions);
}

QString UiSettings::downloadsFolder() const {
    return store_.value(kDownloadsFolder,
                        QStandardPaths::writableLocation(QStandardPaths::DownloadLocation))
        .toString();
}

void UiSettings::setDownloadsFolder(const QString& dir) {
    store_.setValue(kDownloadsFolder, dir);
    emit changed(kDownloadsFolder);
}

void UiSettings::resetDownloadsFolder() {
    store_.remove(kDownloadsFolder);
    emit changed(kDownloadsFolder);
}

bool UiSettings::askWhereSave() const {
    return store_.value(kAskWhereSave, false).toBool();
}

void UiSettings::setAskWhereSave(bool on) {
    store_.setValue(kAskWhereSave, on);
    emit changed(kAskWhereSave);
}

bool UiSettings::ntpShowClock() const { return store_.value(kNtpClock, true).toBool(); }
void UiSettings::setNtpShowClock(bool on) {
    store_.setValue(kNtpClock, on);
    emit changed(kNtpClock);
}
bool UiSettings::ntpShowTiles() const { return store_.value(kNtpTiles, true).toBool(); }
void UiSettings::setNtpShowTiles(bool on) {
    store_.setValue(kNtpTiles, on);
    emit changed(kNtpTiles);
}
bool UiSettings::ntpShowVisited() const { return store_.value(kNtpVisited, true).toBool(); }
void UiSettings::setNtpShowVisited(bool on) {
    store_.setValue(kNtpVisited, on);
    emit changed(kNtpVisited);
}
bool UiSettings::ntpShowStats() const {
    return store_.value(kNtpStats, true).toBool();
}
void UiSettings::setNtpShowStats(bool on) {
    store_.setValue(kNtpStats, on);
    emit changed(kNtpStats);
}

double UiSettings::zoomForHost(const QString& host) const {
    return store_.value(kZoomPrefix + host, 1.0).toDouble();
}

void UiSettings::setZoomForHost(const QString& host, double factor) {
    const QString key = kZoomPrefix + host;
    if (qAbs(factor - 1.0) < 0.001)
        store_.remove(key);
    else
        store_.setValue(key, factor);
    emit changed(key);
}

QStringList UiSettings::userBlockedDomains() const {
    return store_.value(kUserDomains).toStringList();
}

void UiSettings::setUserBlockedDomains(const QStringList& domains) {
    store_.setValue(kUserDomains, domains);
    emit changed(kUserDomains);
}

bool UiSettings::forceDarkPages() const {
    return store_.value(kForceDarkPages, true).toBool();
}

void UiSettings::setForceDarkPages(bool on) {
    store_.setValue(kForceDarkPages, on);
    emit changed(kForceDarkPages);
}
