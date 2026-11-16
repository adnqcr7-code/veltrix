#include "bookmarkspanel.h"

#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QPushButton>
#include <QUrl>
#include <QVBoxLayout>

#include "entryrow.h"
#include "faviconstore.h"

BookmarksPanel::BookmarksPanel(QWidget* parent) : QWidget(parent) {
    auto* lay = new QVBoxLayout(this);
    lay->setContentsMargins(16, 16, 16, 16);
    lay->setSpacing(12);
    auto* title = new QLabel(tr("Bookmarks"));
    title->setObjectName(QStringLiteral("panelTitle"));
    lay->addWidget(title);
    empty_ = new QLabel(
        tr("No bookmarks yet. Tap the star in the address bar to save a page."), this);
    empty_->setObjectName(QStringLiteral("mutedLabel"));
    empty_->setWordWrap(true);
    lay->addWidget(empty_);
    list_ = new QListWidget(this);
    list_->setObjectName(QStringLiteral("entryWell"));
    lay->addWidget(list_, 1);
    connect(list_, &QListWidget::itemDoubleClicked, this,
            [this](QListWidgetItem* item) {
                const QString url = item->data(Qt::UserRole).toString();
                if (!url.isEmpty()) emit openUrl(url);
            });
    removeBtn_ = new QPushButton(tr("Remove bookmark"), this);
    removeBtn_->setObjectName(QStringLiteral("secondaryAction"));
    removeBtn_->setEnabled(false);
    connect(list_, &QListWidget::currentItemChanged, this,
            [this] { entryrow::markSelected(list_); });
    connect(list_, &QListWidget::currentRowChanged, removeBtn_,
            [this](int row) { removeBtn_->setEnabled(row >= 0); });
    connect(removeBtn_, &QPushButton::clicked, this, [this] {
        if (QListWidgetItem* item = list_->currentItem())
            emit removeRequested(item->data(Qt::UserRole + 1).toLongLong());
    });
    auto* removeRow = new QHBoxLayout;
    removeRow->addWidget(removeBtn_);
    removeRow->addStretch(1);
    lay->addLayout(removeRow);
    // Trailing spacer at factor 1: the well hugs its content now
    // (entryrow::fitWell), so the surplus lands here and the
    // footline stays at the panel's foot.
    lay->addStretch(1);
    auto* foot = new QLabel(
        tr("Saved pages live on this device. Double-click one to open "
           "it; select one to remove it."),
        this);
    foot->setObjectName(QStringLiteral("panelFoot"));
    foot->setWordWrap(true);
    lay->addWidget(foot);
}

void BookmarksPanel::showBookmarks(const std::vector<vile::Bookmark>& marks) {
    list_->clear();
    empty_->setVisible(marks.empty());
    // An empty well under the empty-state label is a bordered sliver;
    // the label IS the empty state, so the well hides until it has
    // rows, then hugs them.
    list_->setVisible(!marks.empty());
    for (const auto& b : marks) {
        const QString url = QString::fromStdString(b.url);
        auto* item = entryrow::add(
            list_, QString::fromStdString(b.title), url, QUrl(url).host(),
            favicons_ ? favicons_->pixmap(QUrl(url).host(), 32) : QPixmap());
        item->setData(Qt::UserRole + 1, QVariant::fromValue<qint64>(b.id));
    }
    entryrow::fitWell(list_);
    entryrow::markSelected(list_);
    // Keep a selection whenever rows exist: Remove is selection-
    // driven, and an unselected list left it rendering in the
    // disabled register beside saved bookmarks — looking broken
    // rather than conditional, three design rounds running.
    if (!marks.empty() && !list_->currentItem()) list_->setCurrentRow(0);
}
