#pragma once
// FaviconStore: the site logos Chromium fetches, kept on disk so the
// new-tab tiles, sidebar favorites and panel rows can show a site's
// real logo instead of a generated letter — the way every other
// browser presents them. One PNG per host under
// <dataDir>/favicons/, written by the engine when a page's icon
// arrives. Local files only: nothing is fetched for display, so
// showing a logo never makes a network request of its own.
//
// Privacy governance (this is a per-host record, so it lives under
// the same discipline as history): the engine only captures from
// non-private (persistent-profile) views — private mode IS the
// history-off posture in VILE, so nothing is recorded while history
// is off; clear() is wired into site-data clearing and clear-on-exit
// via QtEngine::clear_site_data and into full history clears from
// the window; files are owner-only (0600, directory 0700) like the
// database. UI-thread only, like the rest of the Qt layer.
#include <QIcon>
#include <QMap>
#include <QObject>
#include <QPixmap>
#include <QString>

class FaviconStore : public QObject {
    Q_OBJECT
public:
    explicit FaviconStore(QString dataDir, QObject* parent = nullptr);

    // Records a page's icon for its host. Null icons and repeats of
    // what's already stored are ignored. Callers gate on privacy
    // posture (see the class comment); the store itself just stores.
    void capture(const QString& host, const QIcon& icon);

    // Removes every stored logo (files + caches). Emits cleared()
    // so chrome surfaces can fall back to letters immediately.
    void clear();

    bool has(const QString& host) const;
    QPixmap pixmap(const QString& host, int size = 32) const;
    // data: URL for HTML surfaces (the new-tab page), "" when the
    // host has no stored logo.
    QString fileUrl(const QString& host) const;

signals:
    void faviconReady(const QString& host);
    void cleared();

private:
    QString pathFor(const QString& host) const;
    QString dir_;
    mutable QMap<QString, QPixmap> cache_;
    // data: URIs are what the new-tab page renders on every load;
    // caching them here keeps fileUrl() off the disk after the
    // first read (capture() fills it directly).
    // Single capped insert path for both caches (see the .cpp).
    void cacheInsert(const QString& key, const QPixmap& px, const QString& uri) const;
    mutable QMap<QString, QString> dataUriCache_;
};
