#include "faviconstore.h"

#include <QBuffer>
#include <QDebug>
#include <QDir>
#include <QFile>
#include <QSaveFile>

namespace {
// Hosts become file names: keep the host's own alphabet, flatten the
// rest (ports, userinfo can never appear — QUrl::host is bare — but
// IPv6 brackets and zone ids can).
QString sanitize(const QString& host) {
    QString out;
    for (QChar ch : host) {
        if (ch.isLetterOrNumber() || ch == '.' || ch == '-')
            out += ch.toLower();
        else
            out += '_';
    }
    return out;
}
}  // namespace

FaviconStore::FaviconStore(QString dataDir, QObject* parent)
    : QObject(parent), dir_(std::move(dataDir) + QStringLiteral("/favicons")) {
    QDir().mkpath(dir_);
    // Owner-only, matching the database file beside it: the file
    // names in here are visited hosts.
    if (!QFile::setPermissions(dir_, QFileDevice::ReadOwner | QFileDevice::WriteOwner |
                                         QFileDevice::ExeOwner))
        qWarning("FaviconStore: could not restrict permissions on %s",
                 qPrintable(dir_));
}

QString FaviconStore::pathFor(const QString& host) const {
    return dir_ + '/' + sanitize(host) + QStringLiteral(".png");
}

void FaviconStore::cacheInsert(const QString& key, const QPixmap& px,
                               const QString& uri) const {
    // Bounded caches, enforced at EVERY insert (round 13: the cap
    // used to live only in capture(), so the read paths the panels
    // and the NTP actually exercise re-grew both maps unbounded).
    // Dropping the whole cache at the cap is crude but honest —
    // entries are re-read from disk on demand. (The check runs
    // before the insert, so the true ceiling is 513 — the bound is
    // "about 512", and the comment no longer pretends otherwise.)
    if (cache_.size() > 512 || dataUriCache_.size() > 512) {
        cache_.clear();
        dataUriCache_.clear();
    }
    if (!px.isNull()) cache_.insert(key, px);
    if (!uri.isEmpty()) dataUriCache_.insert(key, uri);
}

void FaviconStore::capture(const QString& host, const QIcon& icon) {
    if (host.isEmpty() || icon.isNull()) return;
    const QPixmap px = icon.pixmap(32, 32);
    if (px.isNull()) return;
    QByteArray bytes;
    {
        QBuffer buf(&bytes);
        buf.open(QIODevice::WriteOnly);
        px.save(&buf, "PNG");
    }
    const QString path = pathFor(host);
    QFile existing(path);
    if (existing.exists() && existing.open(QIODevice::ReadOnly) &&
        existing.readAll() == bytes) {
        // Already have exactly this logo — but a file that arrived
        // with looser permissions keeps them unless they're set, so
        // enforce the mode on this path too (round 16 footnote).
        QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
        return;
    }
    // Staged write (QSaveFile renames over the target on commit) and
    // a checked result: a failed write must not announce a logo the
    // disk doesn't have. Permissions are set AFTER commit (below) —
    // between creation and that chmod the file carries umask modes,
    // which the 0700 directory makes unreachable to anyone else.
    QSaveFile f(path);
    // No pre-commit setPermissions: QSaveFile's version warns
    // "Empty filename passed to function" on Qt 6.4 (traced in
    // round 14 — it also never delivered the requested mode, being
    // umask-filtered). The post-commit chmod below is the
    // enforcement; the 0700 directory covers the interval.
    if (!f.open(QIODevice::WriteOnly)) return;
    if (f.write(bytes) != bytes.size()) return;
    if (!f.commit()) return;
    // QSaveFile's setPermissions is filtered by the process umask at
    // temp-file creation (measured on Qt 6.4: a 0600 request landed
    // as 0660), so chmod the committed file explicitly — the end
    // state is the promise: owner-only, like the database. The
    // directory is 0700, so nothing outside the owner could reach
    // the file in between regardless.
    if (!QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner))
        qWarning("FaviconStore: could not restrict permissions on %s",
                 qPrintable(path));
    cacheInsert(sanitize(host), px,
                QStringLiteral("data:image/png;base64,") +
                    QString::fromLatin1(bytes.toBase64()));
    emit faviconReady(host);
}

void FaviconStore::clear() {
    const QStringList files = QDir(dir_).entryList({QStringLiteral("*.png")}, QDir::Files);
    for (const QString& name : files) QFile::remove(dir_ + '/' + name);
    cache_.clear();
    dataUriCache_.clear();
    emit cleared();
}

bool FaviconStore::has(const QString& host) const {
    return !host.isEmpty() && QFile::exists(pathFor(host));
}

QPixmap FaviconStore::pixmap(const QString& host, int size) const {
    const QString key = sanitize(host);
    auto it = cache_.find(key);
    QPixmap px;
    if (it != cache_.end()) {
        px = it.value();
    } else {
        if (!has(host)) return {};
        px.load(pathFor(host));
        if (px.isNull()) return {};
        cacheInsert(key, px, {});
    }
    return px.size() == QSize(size, size) ? px : px.scaled(size, size);
}

QString FaviconStore::fileUrl(const QString& host) const {
    const QString key = sanitize(host);
    auto it = dataUriCache_.find(key);
    if (it != dataUriCache_.end()) return it.value();
    if (!has(host)) return {};
    QFile f(pathFor(host));
    if (!f.open(QIODevice::ReadOnly)) return {};
    const QString uri = QStringLiteral("data:image/png;base64,") +
                        QString::fromLatin1(f.readAll().toBase64());
    cacheInsert(key, {}, uri);
    return uri;
}
