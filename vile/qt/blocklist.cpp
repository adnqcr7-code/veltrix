#include "blocklist.h"

#include <QDir>
#include <QFile>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QStandardPaths>

#include "vile/privacy.hpp"

namespace blocklist {

QString maintainedListUrl() {
    return QStringLiteral("https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts");
}

QString normalizeText(const QString& text) {
    // EasyPrivacy-style "||domain^..." -> "domain" (hosts format handles the rest).
    static const QRegularExpression kEasyPrivacy(
        QStringLiteral("^\\|\\|([A-Za-z0-9.-]+)(?:\\^|/|$)"));
    QStringList out;
    for (const QString& rawLine : text.split('\n')) {
        QString line = rawLine.trimmed();
        if (line.startsWith(QLatin1String("||"))) {
            auto m = kEasyPrivacy.match(line);
            if (m.hasMatch()) out << QStringLiteral("0.0.0.0 ") + m.captured(1);
        } else {
            out << rawLine;
        }
    }
    return out.join('\n');
}

size_t bundledRuleCount() {
    // Parsed once per process: this used to re-read and re-parse the
    // bundled resource on every call — and the update path's rejection
    // branch called it twice in a row to format its own message.
    static const size_t count = [] {
        QFile bundled(QStringLiteral(":/blocklists/trackers.txt"));
        if (!bundled.open(QIODevice::ReadOnly | QIODevice::Text)) return size_t{0};
        vile::Shield scratch;
        return scratch.add_rules_from_text(
            normalizeText(QString::fromUtf8(bundled.readAll())).toStdString());
    }();
    return count;
}

size_t load(vile::Shield& shield, const QString& dataDir, QString* sourceDescription) {
    // The bundled list is the protection floor: its count comes from
    // bundledRuleCount() (parsed once per process), and a downloaded
    // file that parses to FEWER rules — garbage, truncated, or
    // poisoned — can never displace it.
    QString bundledText;
    {
        QFile bundled(QStringLiteral(":/blocklists/trackers.txt"));
        if (bundled.open(QIODevice::ReadOnly | QIODevice::Text))
            bundledText = normalizeText(QString::fromUtf8(bundled.readAll()));
    }
    const size_t bundledCount = bundledText.isEmpty() ? 0 : bundledRuleCount();

    // 1. Downloaded maintained list — only if it beats the floor.
    QString downloaded = QDir(dataDir).filePath(QStringLiteral("blocklists/hosts.txt"));
    QFile f(downloaded);
    if (f.exists() && f.open(QIODevice::ReadOnly | QIODevice::Text)) {
        QString text = normalizeText(QString::fromUtf8(f.readAll()));
        vile::Shield scratch;
        const size_t count = scratch.add_rules_from_text(text.toStdString());
        if (count >= bundledCount) {
            size_t added = shield.add_rules_from_text(text.toStdString());
            if (sourceDescription)
                *sourceDescription = QStringLiteral("maintained list (downloaded, %1 rules)")
                                         .arg(shield.rule_count());
            return added;
        }
        // Below the floor: fall through to the bundled list.
    }
    // 2. Bundled curated list.
    if (!bundledText.isEmpty()) {
        size_t added = shield.add_rules_from_text(bundledText.toStdString());
        if (sourceDescription)
            *sourceDescription = QStringLiteral("bundled curated list (%1 rules)")
                                     .arg(shield.rule_count());
        return added;
    }
    // 3. Seed set only (already in the Shield from its constructor).
    if (sourceDescription)
        *sourceDescription = QStringLiteral("built-in seed list (%1 rules)")
                                  .arg(shield.rule_count());
    return 0;
}

void updateFromNetwork(const QString& dataDir, const std::function<void(bool, const QString&)>& done) {
    auto* manager = new QNetworkAccessManager();
    QNetworkRequest request{QUrl(maintainedListUrl())};
    request.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("VILE/0.1 blocklist-update"));
    QNetworkReply* reply = manager->get(request);
    QObject::connect(reply, &QNetworkReply::finished, [manager, reply, dataDir, done]() {
        manager->deleteLater();
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            done(false, QStringLiteral("Download failed: %1").arg(reply->errorString()));
            return;
        }
        QByteArray body = reply->readAll();
        if (body.size() < 10000) {  // a real unified hosts file is ~1 MB
            done(false, QStringLiteral("Download looked truncated (%1 bytes).").arg(body.size()));
            return;
        }
        if (body.size() > 8 * 1024 * 1024) {  // …and not remotely ~1 MB either
            done(false, QStringLiteral("Download was implausibly large (%1 KB).")
                            .arg(body.size() / 1024));
            return;
        }
        // Parse BEFORE staging anything: size alone proves nothing, and
        // the user is about to be told the update worked. The body must
        // parse to at least the bundled floor — the same check load()
        // applies at startup — or it is rejected here, honestly, instead
        // of being silently ignored at the next launch.
        {
            vile::Shield scratch;
            const size_t count = scratch.add_rules_from_text(
                normalizeText(QString::fromUtf8(body)).toStdString());
            const size_t floor = bundledRuleCount();
            if (count < floor) {
                done(false, QStringLiteral("Download parsed to only %1 rules "
                                           "(the bundled list has %2) — keeping the current list.")
                                .arg(count)
                                .arg(floor));
                return;
            }
        }
        QDir dir(dataDir);
        if (!dir.mkpath(QStringLiteral("blocklists"))) {
            done(false, QStringLiteral("Could not create the blocklist folder."));
            return;
        }
        // Stage the download and rename it over the live list: a crash or
        // a truncated write must never leave a half-written file behind as
        // the Shield's policy (rename is atomic on the same filesystem).
        const QString staging = dir.filePath(QStringLiteral("blocklists/hosts.txt.new"));
        QFile out(staging);
        if (!out.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            done(false, QStringLiteral("Could not save the downloaded list."));
            return;
        }
        // The rename below is only as atomic as the staged file is
        // complete: verify the write AND the flush before the staged
        // file is allowed to become policy.
        if (out.write(body) != body.size() || !out.flush()) {
            out.close();
            QFile::remove(staging);
            done(false, QStringLiteral("Could not write the downloaded list in full."));
            return;
        }
        out.close();
        if (out.error() != QFile::NoError) {
            QFile::remove(staging);
            done(false, QStringLiteral("Could not save the downloaded list."));
            return;
        }
        const QString target = dir.filePath(QStringLiteral("blocklists/hosts.txt"));
        QFile::remove(target + QStringLiteral(".old"));
        if (QFile::exists(target) && !QFile::rename(target, target + QStringLiteral(".old"))) {
            QFile::remove(staging);
            done(false, QStringLiteral("Could not replace the current list."));
            return;
        }
        if (!QFile::rename(staging, target)) {
            QFile::rename(target + QStringLiteral(".old"), target);  // roll back
            QFile::remove(staging);
            done(false, QStringLiteral("Could not replace the current list."));
            return;
        }
        QFile::remove(target + QStringLiteral(".old"));
        done(true, QStringLiteral("Downloaded %1 KB.").arg(body.size() / 1024));
    });
}

}  // namespace blocklist
