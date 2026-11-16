#include "cleardatadialog.h"

#include "theme.h"

#include <QCheckBox>
#include <QComboBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QVBoxLayout>

ClearDataDialog::ClearDataDialog(QWidget* parent) : QDialog(parent) {
    setWindowTitle(tr("Clear browsing data"));
    setModal(true);
    // Elevation: this dialog opens over Settings, whose background is
    // the palette's bg — without a step up (the surface colour) and a
    // border the two merge into one unreadable plane, in either theme.
    const Palette& p = activePalette();
    setStyleSheet(QStringLiteral("QDialog { background: %1; border: 1px solid %2; }")
                      .arg(p.surface, p.borderStrong));

    auto* lay = new QVBoxLayout(this);
    lay->setContentsMargins(20, 18, 20, 16);
    lay->setSpacing(10);

    auto* title = new QLabel(tr("Clear browsing data"));
    title->setStyleSheet(QStringLiteral("font-size: 16px; font-weight: 700;"));
    lay->addWidget(title);
    auto* intro = new QLabel(tr("This can't be undone. Bookmarks and open tabs are not touched."));
    intro->setObjectName(QStringLiteral("mutedLabel"));
    intro->setWordWrap(true);
    lay->addWidget(intro);

    history_ = new QCheckBox(tr("Browsing history"));
    history_->setChecked(true);
    lay->addWidget(history_);
    auto* rangeRow = new QHBoxLayout;
    auto* rangeLabel = new QLabel(tr("Time range"));
    rangeLabel->setObjectName(QStringLiteral("mutedLabel"));
    rangeRow->addWidget(rangeLabel);
    range_ = new QComboBox;
    range_->addItem(tr("All time"), 0);
    range_->addItem(tr("Last hour"), 1);
    range_->addItem(tr("Last 24 hours"), 24);
    rangeRow->addWidget(range_);
    rangeRow->addStretch(1);
    lay->addLayout(rangeRow);
    connect(history_, &QCheckBox::toggled, range_, &QWidget::setEnabled);

    siteData_ = new QCheckBox(tr("Cookies and site data"));
    siteData_->setChecked(true);
    lay->addWidget(siteData_);
    auto* siteNote = new QLabel(
        tr("Site data is always cleared in full — the engine can't clear it by time range."));
    siteNote->setObjectName(QStringLiteral("mutedLabel"));
    siteNote->setWordWrap(true);
    lay->addWidget(siteNote);

    auto* buttons = new QHBoxLayout;
    buttons->addStretch(1);
    auto* cancel = new QPushButton(tr("Cancel"));
    cancel->setObjectName(QStringLiteral("secondaryAction"));
    connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
    buttons->addWidget(cancel);
    auto* clear = new QPushButton(tr("Clear data"));
    clear->setObjectName(QStringLiteral("dangerButton"));
    connect(clear, &QPushButton::clicked, this, &QDialog::accept);
    buttons->addWidget(clear);
    lay->addLayout(buttons);
}

bool ClearDataDialog::clearHistory() const { return history_->isChecked(); }

bool ClearDataDialog::clearSiteData() const { return siteData_->isChecked(); }

int ClearDataDialog::historyRangeHours() const { return range_->currentData().toInt(); }
