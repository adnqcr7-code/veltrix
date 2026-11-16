#include "historypanel.h"

#include <QDateTime>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QPushButton>
#include <QUrl>
#include <QVBoxLayout>

#include "entryrow.h"
#include "faviconstore.h"

HistoryPanel::HistoryPanel(QWidget* parent) : QWidget(parent) {
    auto* lay = new QVBoxLayout(this);
    lay->setContentsMargins(16, 16, 16, 16);
    lay->setSpacing(12);
    auto* title = new QLabel(tr("History"));
    title->setObjectName(QStringLiteral("panelTitle"));
    lay->addWidget(title);
    search_ = new QLineEdit(this);
    search_->setPlaceholderText(tr("Search history…"));
    connect(search_, &QLineEdit::textChanged, this, &HistoryPanel::searchChanged);
    lay->addWidget(search_);
    list_ = new QListWidget(this);
    list_->setObjectName(QStringLiteral("entryWell"));
    lay->addWidget(list_, 1);
    connect(list_, &QListWidget::itemDoubleClicked, this,
            [this](QListWidgetItem* item) {
                const QString url = item->data(Qt::UserRole).toString();
                if (!url.isEmpty()) emit openUrl(url);
            });
    connect(list_, &QListWidget::currentItemChanged, this,
            [this] { entryrow::markSelected(list_); });
    auto* clearBtn = new QPushButton(tr("Clear history"), this);
    clearBtn->setObjectName(QStringLiteral("secondaryAction"));
    connect(clearBtn, &QPushButton::clicked, this, &HistoryPanel::clearRequested);
    auto* clearRow = new QHBoxLayout;
    clearRow->addWidget(clearBtn);
    clearRow->addStretch(1);
    lay->addLayout(clearRow);
    lay->addStretch(1);  // surplus lands here; the well hugs its content
    // A footline at the panel's foot: with two entries the card list
    // ends a third of the way down, and a labelled bottom edge reads
    // as design where an unmarked void read as unfinished.
    auto* foot = new QLabel(
        tr("One row per visit, newest first. Visits are recorded only "
           "when history is on."),
        this);
    foot->setObjectName(QStringLiteral("panelFoot"));
    foot->setWordWrap(true);
    lay->addWidget(foot);
}

QString HistoryPanel::searchText() const { return search_->text(); }

void HistoryPanel::showEntries(const std::vector<vile::HistoryEntry>& entries) {
    list_->clear();
    for (const auto& e : entries) {
        const QString url = QString::fromStdString(e.url);
        const QString host = QUrl(url).host();
        QString meta = host;
        if (e.last_visit > 0) {
            const QString when = QDateTime::fromSecsSinceEpoch(e.last_visit)
                                     .toString(QStringLiteral("MMM d, HH:mm"));
            meta = meta.isEmpty() ? when : meta + QStringLiteral(" · ") + when;
        }
        if (e.visit_count > 1) meta += QStringLiteral(" · ×%1").arg(e.visit_count);
        entryrow::add(list_, QString::fromStdString(e.title), url, meta,
                      favicons_ ? favicons_->pixmap(host, 32) : QPixmap());
    }
    if (entries.empty()) {
        entryrow::addPlaceholder(
            list_, search_->text().isEmpty()
                       ? tr("No history yet — pages you visit will appear here.")
                       : tr("Nothing matches that search."));
    }
    // The well hugs its content now (see entryrow::fitWell).
    entryrow::fitWell(list_);
    entryrow::markSelected(list_);
    // Keep a selection whenever rows exist — the mirror of the
    // Bookmarks rule below. Round 12's design review measured ZERO
    // selection pixels in this panel: markSelected had no current
    // item to mark, because nothing ever set one here.
    if (!entries.empty() && !list_->currentItem()) list_->setCurrentRow(0);
}
