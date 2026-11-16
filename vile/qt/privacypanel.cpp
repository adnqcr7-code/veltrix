#include "privacypanel.h"

#include "entryrow.h"

#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QPushButton>
#include <QVBoxLayout>

PrivacyPanel::PrivacyPanel(QWidget* parent) : QWidget(parent) {
    auto* lay = new QVBoxLayout(this);
    lay->setContentsMargins(16, 16, 16, 16);
    lay->setSpacing(12);
    auto* title = new QLabel(tr("Privacy"));
    title->setObjectName(QStringLiteral("panelTitle"));
    lay->addWidget(title);
    // Status card: the Shield's state at a glance, in the semantic
    // colours (green = protected, amber = off).
    auto* statusCard = new QFrame(this);
    statusCard->setObjectName(QStringLiteral("statusCard"));
    auto* cardLay = new QVBoxLayout(statusCard);
    cardLay->setContentsMargins(14, 12, 14, 12);
    cardLay->setSpacing(4);
    statusTitle_ = new QLabel(statusCard);
    statusTitle_->setObjectName(QStringLiteral("statusCardTitle"));
    cardLay->addWidget(statusTitle_);
    statusSub_ = new QLabel(statusCard);
    statusSub_->setObjectName(QStringLiteral("mutedLabel"));
    statusSub_->setWordWrap(true);
    cardLay->addWidget(statusSub_);
    lay->addWidget(statusCard);
    summary_ = new QLabel(this);
    summary_->setObjectName(QStringLiteral("mutedLabel"));
    summary_->setWordWrap(true);
    lay->addWidget(summary_);
    lay->addWidget(new QLabel(tr("Recent blocks:"), this));
    blocksEmpty_ = new QLabel(
        tr("Nothing blocked yet — what the Shield stops will show up here."), this);
    blocksEmpty_->setObjectName(QStringLiteral("mutedLabel"));
    blocksEmpty_->setWordWrap(true);
    lay->addWidget(blocksEmpty_);
    blockList_ = new QListWidget(this);
    blockList_->setObjectName(QStringLiteral("entryWell"));
    lay->addWidget(blockList_, 1);
    auto* updateBtn = new QPushButton(tr("Update blocklist"), this);
    updateBtn->setObjectName(QStringLiteral("secondaryAction"));
    connect(updateBtn, &QPushButton::clicked, this,
            &PrivacyPanel::updateBlocklistRequested);
    auto* updateRow = new QHBoxLayout;
    updateRow->addWidget(updateBtn);
    updateRow->addStretch(1);
    lay->addLayout(updateRow);
    // A trailing spacer at factor 0: the block list (stretch 1)
    // takes the surplus while visible; when it HIDES (no blocks),
    // this absorbs the space so the layout never smears it across
    // the Preferred-policy labels (the pass-3 void).
    lay->addStretch(1);  // surplus lands here; the well hugs its content
    auto* foot = new QLabel(
        tr("Blocking happens on this device, against the list above. "
           "Nothing about your browsing is sent anywhere."),
        this);
    foot->setObjectName(QStringLiteral("panelFoot"));
    foot->setWordWrap(true);
    lay->addWidget(foot);
}

void PrivacyPanel::setStatus(bool shieldOn, std::size_t blocked, std::size_t rules) {
    if (shieldOn) {
        statusTitle_->setText(tr("● Protected"));
        statusTitle_->setStyleSheet(QStringLiteral("color: #3fb68b;"));
        statusSub_->setText(
            tr("%1 trackers blocked · %2 rules").arg(blocked).arg(rules));
    } else {
        statusTitle_->setText(tr("○ Shield off"));
        statusTitle_->setStyleSheet(QStringLiteral("color: #d9a441;"));
        statusSub_->setText(tr("Nothing is being blocked"));
    }
}

void PrivacyPanel::setBlocklistInfo(const QString& info) {
    summary_->setText(tr("Blocklist: %1").arg(info));
}

void PrivacyPanel::setBlocks(const std::vector<vile::BlockEvent>& recent) {
    blockList_->clear();
    for (auto it = recent.rbegin(); it != recent.rend(); ++it) {
        blockList_->addItem(QString::fromStdString(it->request_url + " — " + it->reason));
        if (blockList_->count() >= 50) break;
    }
    // An empty list under a heading reads as broken; say so instead.
    blocksEmpty_->setVisible(recent.empty());
    blockList_->setVisible(!recent.empty());
    if (!recent.empty()) entryrow::fitWell(blockList_);
}
