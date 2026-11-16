// Shared card-row builder for the list panels (History, Bookmarks):
// one row language with Downloads — a bordered card holding a flat
// site letter, a title, and a muted meta line. Extracted after the
// panel split left two near-identical hand-rolled copies of it.
#pragma once

#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QUrl>
#include <QVBoxLayout>
#include <QWidget>

#include "icons.h"
#include "theme.h"

namespace entryrow {

// Builds the row widget and its list item; returns the item (already
// added to `list`) so the caller can attach data (url, id).
inline QListWidgetItem* add(QListWidget* list, const QString& title,
                            const QString& url, const QString& meta,
                            const QPixmap& logo = {}) {
    const QString host = QUrl(url).host();
    auto* rowWidget = new QWidget;
    rowWidget->setObjectName(QStringLiteral("entryRow"));
    auto* rowLay = new QHBoxLayout(rowWidget);
    rowLay->setContentsMargins(10, 7, 10, 7);
    rowLay->setSpacing(10);
    auto* letter = new QLabel(rowWidget);
    letter->setFixedSize(20, 20);
    letter->setAlignment(Qt::AlignCenter);
    if (!logo.isNull()) {
        // The site's own logo, captured when the page was visited.
        letter->setPixmap(logo.scaled(20, 20, Qt::KeepAspectRatio,
                                      Qt::SmoothTransformation));
    } else {
        const QString initial =
            host.isEmpty() ? QStringLiteral("?") : host.left(1).toUpper();
        letter->setPixmap(
            icons::letterIcon(initial, QColor(activePalette().accentText)).pixmap(20, 20));
    }
    rowLay->addWidget(letter);
    auto* textCol = new QVBoxLayout;
    textCol->setContentsMargins(0, 0, 0, 0);
    textCol->setSpacing(1);
    textCol->addWidget(new QLabel(title.isEmpty() ? url : title, rowWidget));
    auto* metaLabel = new QLabel(meta, rowWidget);
    metaLabel->setObjectName(QStringLiteral("mutedLabel"));
    textCol->addWidget(metaLabel);
    rowLay->addLayout(textCol, 1);
    auto* item = new QListWidgetItem(list);
    list->addItem(item);
    list->setItemWidget(item, rowWidget);
    // Height only: a full-width sizeHint makes the item wider than
    // the viewport and pushes content off-screen (Downloads' lesson).
    item->setSizeHint(QSize(0, rowWidget->sizeHint().height()));
    item->setToolTip(url);
    item->setData(Qt::UserRole, url);
    return item;
}

// Marks the current item's card as selected (accent border via the
// theme's [selected="true"] rule). The row is a child widget covering
// its item, so the list's own selection paint never shows — the
// panels call this whenever the current item changes. (Bookmarks'
// Remove button is selection-driven; an invisible selection made it
// look broken for three design rounds.)
inline void markSelected(QListWidget* list) {
    for (int i = 0; i < list->count(); ++i) {
        QListWidgetItem* item = list->item(i);
        if (QWidget* row = list->itemWidget(item)) {
            const bool sel = item == list->currentItem();
            if (row->property("selected").toBool() != sel) {
                row->setProperty("selected", sel);
                row->style()->unpolish(row);
                row->style()->polish(row);
            }
        }
    }
}

// An in-well empty state: one disabled row whose widget is a muted,
// centred line of text. Panels WITH their own empty-state label
// (Bookmarks, Downloads, Privacy) hide the list instead; History has
// none, so its empty state lives inside the well.
inline void addPlaceholder(QListWidget* list, const QString& text) {
    auto* label = new QLabel(text);
    label->setObjectName(QStringLiteral("mutedLabel"));
    label->setAlignment(Qt::AlignCenter);
    label->setWordWrap(true);
    auto* item = new QListWidgetItem(list);
    list->addItem(item);
    list->setItemWidget(item, label);
    item->setSizeHint(QSize(0, 56));
    item->setFlags(Qt::NoItemFlags);  // not selectable, not a "row"
}

// Sizes a panel well to its CONTENT (up to maxRows rows) instead of
// stretching a near-empty bordered box down the whole panel — round
// 12's design verdict: a tall empty well "advertises the emptiness".
// Sets min AND max height to the fitted content height; the panel's
// trailing spacer (factor 1) absorbs the panel surplus so the
// footline stays at the foot. Long lists cap at maxRows and scroll
// internally, as panels did when they filled the height anyway.
inline void fitWell(QListWidget* list, int maxRows = 8) {
    // Calibrated to the entry rows' own metrics (30px rows in a
    // borderless list); Settings' plain blocked-sites list uses it
    // too — the constants follow the ROWS, not the well.
    int h = 12;  // list padding, top + bottom
    const int rows = qMin(list->count(), maxRows);
    for (int i = 0; i < rows; ++i) {
        h += list->sizeHintForRow(i);
        if (i > 0) h += list->spacing();
    }
    h += 2;  // the well's border
    list->setMinimumHeight(h);
    list->setMaximumHeight(h);
}

}  // namespace entryrow
