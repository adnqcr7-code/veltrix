// The Privacy dock page, extracted from MainWindow: the Shield
// status card, the blocklist summary, and the recent-blocks list.
// The window owns the Shield itself and the status-bar badge; it
// pushes snapshots in (setStatus / setBlocklistInfo / setBlocks) and
// hears updateBlocklistRequested when the user asks for fresh rules.
#pragma once

#include <QWidget>

#include <cstddef>
#include <vector>

#include "vile/privacy.hpp"  // vile::BlockEvent

class QLabel;
class QListWidget;

class PrivacyPanel : public QWidget {
    Q_OBJECT
public:
    explicit PrivacyPanel(QWidget* parent = nullptr);

    // Shield state for the card: on/off plus the session numbers.
    void setStatus(bool shieldOn, std::size_t blocked, std::size_t rules);
    // "bundled curated list (101 rules)" / "StevenBlack list (…)".
    void setBlocklistInfo(const QString& info);
    // Recent blocks, oldest first as the log returns them.
    void setBlocks(const std::vector<vile::BlockEvent>& recent);

signals:
    void updateBlocklistRequested();

private:
    QLabel* statusTitle_ = nullptr;
    QLabel* statusSub_ = nullptr;
    QLabel* summary_ = nullptr;
    QLabel* blocksEmpty_ = nullptr;
    QListWidget* blockList_ = nullptr;
};
