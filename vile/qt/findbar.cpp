#include "findbar.h"

#include <QEvent>
#include <QHBoxLayout>
#include <QKeyEvent>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>

#include "icons.h"

FindBar::FindBar(QWidget* parent) : QWidget(parent) {
    setObjectName(QStringLiteral("findBar"));
    hide();
    auto* lay = new QHBoxLayout(this);
    lay->setContentsMargins(10, 6, 10, 6);
    lay->setSpacing(8);
    edit_ = new QLineEdit(this);
    edit_->setPlaceholderText(tr("Find in page"));
    edit_->setClearButtonEnabled(true);
    edit_->setMaximumWidth(360);
    lay->addWidget(edit_);
    count_ = new QLabel(this);
    count_->setObjectName(QStringLiteral("mutedLabel"));
    lay->addWidget(count_);
    prevBtn_ = new QPushButton(this);
    auto* prevBtn = prevBtn_;
    prevBtn->setObjectName(QStringLiteral("navButton"));
    prevBtn->setIcon(icons::icon(icons::Kind::ChevronUp));
    prevBtn->setToolTip(tr("Previous match (Shift+Enter)"));
    prevBtn->setFixedSize(30, 28);
    connect(prevBtn, &QPushButton::clicked, this,
            [this] { emit findRequested(edit_->text(), true); });
    lay->addWidget(prevBtn);
    nextBtn_ = new QPushButton(this);
    auto* nextBtn = nextBtn_;
    nextBtn->setObjectName(QStringLiteral("navButton"));
    nextBtn->setIcon(icons::icon(icons::Kind::ChevronDown));
    nextBtn->setToolTip(tr("Next match (Enter)"));
    nextBtn->setFixedSize(30, 28);
    connect(nextBtn, &QPushButton::clicked, this,
            [this] { emit findRequested(edit_->text(), false); });
    lay->addWidget(nextBtn);
    closeBtn_ = new QPushButton(this);
    auto* closeBtn = closeBtn_;
    closeBtn->setObjectName(QStringLiteral("navButton"));
    closeBtn->setIcon(icons::icon(icons::Kind::Close));
    closeBtn->setToolTip(tr("Close (Esc)"));
    closeBtn->setFixedSize(30, 28);
    connect(closeBtn, &QPushButton::clicked, this, &FindBar::hideBar);
    lay->addWidget(closeBtn);
    lay->addStretch(1);
    connect(edit_, &QLineEdit::textChanged, this,
            [this] { emit findRequested(edit_->text(), false); });
    connect(edit_, &QLineEdit::returnPressed, this,
            [this] { emit findRequested(edit_->text(), false); });
    edit_->installEventFilter(this);
}

void FindBar::refreshIcons() {
    if (prevBtn_) prevBtn_->setIcon(icons::icon(icons::Kind::ChevronUp));
    if (nextBtn_) nextBtn_->setIcon(icons::icon(icons::Kind::ChevronDown));
    if (closeBtn_) closeBtn_->setIcon(icons::icon(icons::Kind::Close));
}

void FindBar::showBar() {
    show();
    edit_->setFocus();
    edit_->selectAll();
    if (!edit_->text().isEmpty()) emit findRequested(edit_->text(), false);
}

void FindBar::hideBar() {
    hide();
    emit closed();
}

QString FindBar::text() const { return edit_->text(); }

void FindBar::setText(const QString& text) { edit_->setText(text); }

void FindBar::setResult(int active, int total) {
    count_->setText(total == 0 ? tr("No results")
                               : tr("%1 / %2").arg(active).arg(total));
}

void FindBar::clearResult() { count_->clear(); }

bool FindBar::eventFilter(QObject* watched, QEvent* event) {
    if (watched == edit_ && event->type() == QEvent::KeyPress) {
        auto* key = static_cast<QKeyEvent*>(event);
        if (key->key() == Qt::Key_Escape) {
            hideBar();
            return true;
        }
        if ((key->key() == Qt::Key_Return || key->key() == Qt::Key_Enter) &&
            (key->modifiers() & Qt::ShiftModifier)) {
            // Shift+Enter: previous match; plain Enter goes through
            // to returnPressed (next match).
            emit findRequested(edit_->text(), true);
            return true;
        }
    }
    return QWidget::eventFilter(watched, event);
}
