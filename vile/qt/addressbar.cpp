#include "addressbar.h"

#include <QAction>
#include <QEvent>
#include <QHBoxLayout>
#include <QIcon>
#include <QKeyEvent>
#include <QLineEdit>
#include <QListWidget>
#include <QPixmap>
#include <QUrl>
#include <QVBoxLayout>

#include "bangcolors.h"
#include "icons.h"
#include "uisettings.h"
#include "theme.h"
#include "vile/url.hpp"

AddressBar::AddressBar(QWidget* parent) : QWidget(parent) {
    auto* lay = new QHBoxLayout(this);
    lay->setContentsMargins(0, 0, 0, 0);
    edit_ = new QLineEdit(this);
    edit_->setObjectName(QStringLiteral("addressBar"));
    edit_->setPlaceholderText(tr("Search or type a URL"));
    edit_->setClearButtonEnabled(true);
    // The Shield badge lives at the front of the address bar, like a
    // browser's padlock: green while protection is on, amber off.
    shieldAction_ = edit_->addAction(
        icons::icon(icons::Kind::Shield, QColor(QStringLiteral("#3fb68b"))),
        QLineEdit::LeadingPosition);
    connect(shieldAction_, &QAction::triggered, this, &AddressBar::shieldClicked);
    // The bookmark star at the end: outline when the page is not
    // bookmarked, filled violet when it is.
    bookmarkAction_ = edit_->addAction(
        QIcon(icons::bookmarkPixmap(false, QColor(activePalette().muted), 32)),
        QLineEdit::TrailingPosition);
    bookmarkAction_->setToolTip(tr("Bookmark this page"));
    connect(bookmarkAction_, &QAction::triggered, this, &AddressBar::bookmarkClicked);
    lay->addWidget(edit_);

    // Suggestions: history matches, !bangs, and a search row, in a
    // popup card under the bar.
    popup_ = new QWidget(this, Qt::Popup | Qt::FramelessWindowHint);
    popup_->setObjectName(QStringLiteral("suggestionPopup"));
    popup_->hide();
    auto* suggLay = new QVBoxLayout(popup_);
    suggLay->setContentsMargins(0, 0, 0, 0);
    list_ = new QListWidget(popup_);
    list_->setObjectName(QStringLiteral("suggestionList"));
    // The popup is sized exactly to its rows (see showSuggestions);
    // a scrollbar on a two-row list is pure residue.
    list_->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    list_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    suggLay->addWidget(list_);
    connect(list_, &QListWidget::itemClicked, this, &AddressBar::activateSuggestion);
    edit_->installEventFilter(this);
    connect(edit_, &QLineEdit::textChanged, this, &AddressBar::onTextChanged);
    connect(edit_, &QLineEdit::returnPressed, this, &AddressBar::submitted);
}

void AddressBar::setHistoryProvider(HistoryProvider provider) {
    historyProvider_ = std::move(provider);
}

void AddressBar::focusBar() {
    edit_->setFocus();
    edit_->selectAll();
}

bool AddressBar::hasFocus() const { return edit_->hasFocus(); }
QString AddressBar::text() const { return edit_->text(); }
void AddressBar::setText(const QString& text) { edit_->setText(text); }
void AddressBar::clear() { edit_->clear(); }

void AddressBar::setDisplayText(const QString& urlText) {
    if (!edit_->hasFocus()) edit_->setText(urlText);
}

void AddressBar::setSearchEngineName(const QString& name) {
    edit_->setPlaceholderText(
        name.isEmpty() ? tr("Search or type a URL")
                       : tr("Search or type a URL (%1 by default)").arg(name));
}

void AddressBar::setShieldState(bool on, int blockedTotal) {
    if (!shieldAction_) return;
    if (on) {
        if (shieldOnIcon_.isNull())
            shieldOnIcon_ =
                icons::icon(icons::Kind::Shield, QColor(QStringLiteral("#3fb68b")));
        shieldAction_->setIcon(shieldOnIcon_);
        shieldAction_->setToolTip(
            tr("Shield on — %1 trackers blocked this session").arg(blockedTotal));
    } else {
        if (shieldOffIcon_.isNull())
            shieldOffIcon_ =
                icons::icon(icons::Kind::Shield, QColor(QStringLiteral("#d9a441")));
        shieldAction_->setIcon(shieldOffIcon_);
        shieldAction_->setToolTip(tr("Shield off — nothing is being blocked"));
    }
}

void AddressBar::setBookmarked(bool marked, bool enabled) {
    if (!bookmarkAction_) return;
    bookmarkAction_->setEnabled(enabled);
    bookmarkAction_->setIcon(QIcon(icons::bookmarkPixmap(
        marked, QColor(marked ? activePalette().accentText : activePalette().muted),
        32)));
    bookmarkAction_->setToolTip(marked ? tr("Bookmarked — click to remove")
                                       : tr("Bookmark this page"));
}

void AddressBar::showSuggestions() {
    QPoint p = edit_->mapToGlobal(QPoint(0, edit_->height() + 4));
    popup_->move(p);
    // Size to the content: the SUM of the rows' own heights (at most
    // 8 rows) + the border. Round 12's design review measured the
    // hand-multiplied version: a 36px row with 9px of QSS padding
    // left each line floating at the top of a too-tall cell, with a
    // dead band under the last row.
    const int rows = qMin(8, list_->count());
    if (rows > 0 && list_->currentRow() < 0) list_->setCurrentRow(0);
    int height = 2;
    for (int i = 0; i < rows; ++i) height += list_->sizeHintForRow(i);
    popup_->resize(qMin(edit_->width(), 720), height);
    popup_->show();
}

void AddressBar::hideSuggestions() { popup_->hide(); }

void AddressBar::onTextChanged(const QString& text) {
    // A suggestion being applied changes the bar too; that change
    // must not rebuild the popup it just closed.
    if (suppress_) {
        suppress_ = false;
        return;
    }
    // Only the user's typing should open suggestions (tab sync
    // rewrites the bar when it isn't focused). demoSuggestions_ is
    // an inert-in-production bypass for the demo build (under Xvfb
    // no window is ever active, so the bar can't take focus).
    if (!edit_->hasFocus() && !demoSuggestions_) return;
    // Suggestions can be turned off in Settings → Search.
    if (!uiSettings().suggestions()) {
        hideSuggestions();
        return;
    }
    QString q = text.trimmed();
    list_->clear();
    if (q.isEmpty()) {
        hideSuggestions();
        return;
    }
    auto addRow = [this](const QString& display, const QString& completion,
                         const QString& kind) {
        auto* item = new QListWidgetItem(display, list_);
        item->setData(Qt::UserRole, completion);
        item->setData(Qt::UserRole + 1, kind);
        // A fixed row height + a per-kind icon: the popup sizes
        // itself from these, deterministically (see showSuggestions).
        // 30px fits the 20px icon + the theme's 5px vertical item
        // padding with the text centred, not floating.
        item->setSizeHint(QSize(0, 30));
        // The palette's muted role — the value differs per theme
        // so the glyphs stay legible in both (round 14 residue: this
        // was a hardcoded literal; the hex is deliberately not
        // repeated here — comments citing checkable values rot).
        const QColor muted(activePalette().muted);
        // A stored logo for `host`, or a null icon (the generic
        // fallback below). Real logos beat glyphs: a history row
        // wearing the site's own mark is recognisable at a glance.
        auto logo = [this](const QString& host) -> QIcon {
            if (host.isEmpty() || !iconProvider_) return QIcon();
            const QPixmap px = iconProvider_(host);
            return px.isNull() ? QIcon() : QIcon(px);
        };
        if (kind == QStringLiteral("history")) {
            QIcon fav = logo(QUrl(completion).host());
            item->setIcon(fav.isNull() ? icons::icon(icons::Kind::Clock, muted)
                                       : fav);
        } else if (kind == QStringLiteral("bang")) {
            // The bang's own letters in its tile colour — the same
            // flat-letter vocabulary as the new-tab page. The bang
            // name is the completion's token ("!gh " -> "gh").
            // The one shared bang-colour table (bangcolors.h) —
            // this popup used to keep its own drifted copy, and its
            // neutral letters never got the light-theme adaptation.
            const QString name = completion.mid(1).trimmed();
            const bool light =
                uiSettings().theme() == QStringLiteral("light");
            QIcon fav;
            for (const auto& b : vile::bangs())
                if (QString::fromStdString(b.name) == name) {
                    fav = logo(QUrl(QString::fromStdString(b.home)).host());
                    break;
                }
            item->setIcon(fav.isNull()
                              ? icons::letterIcon(name.toUpper(),
                                                  QColor(bangColor(name, light)))
                              : fav);
        } else {
            QIcon fav = logo(searchHost_);
            item->setIcon(fav.isNull() ? icons::icon(icons::Kind::Search, muted)
                                       : fav);
        }
    };
    if (q.startsWith('!')) {
        // !bangs: complete the bang, then the user types the query.
        QString name = q.mid(1).toLower();
        for (const auto& b : vile::bangs()) {
            QString bn = QString::fromStdString(b.name);
            if (bn.startsWith(name))
                addRow(QStringLiteral("!%1  —  %2").arg(bn, QString::fromStdString(b.site)),
                       QStringLiteral("!%1 ").arg(bn), QStringLiteral("bang"));
        }
    } else {
        // History matches (empty when history is off, so this quietly
        // shows nothing in the default private mode).
        if (historyProvider_) {
            for (const auto& match : historyProvider_(q)) {
                QString host = QUrl(match.second).host();
                addRow(match.first + QStringLiteral("  —  ") + host, match.second,
                       QStringLiteral("history"));
            }
        }
        addRow(tr("Search for “%1”").arg(q), q, QStringLiteral("search"));
    }
    if (list_->count() > 0) showSuggestions();
    else hideSuggestions();
}

void AddressBar::activateSuggestion(QListWidgetItem* item) {
    if (!item) return;
    QString completion = item->data(Qt::UserRole).toString();
    QString kind = item->data(Qt::UserRole + 1).toString();
    hideSuggestions();
    suppress_ = true;
    edit_->setText(completion);
    // setText fires textChanged synchronously (or not at all, when
    // the completion equals the current text): the guard must never
    // outlive this call, or it swallows the user's next genuine edit.
    suppress_ = false;
    if (kind == QStringLiteral("bang")) {
        edit_->setFocus();
        return;  // user still has to type the query
    }
    emit submitted();
}

bool AddressBar::eventFilter(QObject* watched, QEvent* event) {
    if (watched == edit_ && event->type() == QEvent::KeyPress) {
        auto* key = static_cast<QKeyEvent*>(event);
        if (popup_->isVisible()) {
            int count = list_->count();
            if (key->key() == Qt::Key_Down || key->key() == Qt::Key_Up) {
                int row = list_->currentRow();
                if (count == 0) return false;
                if (key->key() == Qt::Key_Down) row = row < 0 ? 0 : (row + 1) % count;
                else row = row < 0 ? count - 1 : (row - 1 + count) % count;
                list_->setCurrentRow(row);
                return true;
            }
            if (key->key() == Qt::Key_Return || key->key() == Qt::Key_Enter) {
                if (QListWidgetItem* item = list_->currentItem()) {
                    activateSuggestion(item);
                    return true;
                }
                // No row selected: let the Return through to
                // navigate the typed text.
                hideSuggestions();
                return false;
            }
            if (key->key() == Qt::Key_Escape) {
                hideSuggestions();
                return true;
            }
        } else if (key->key() == Qt::Key_Down) {
            // Open the popup from the keyboard.
            onTextChanged(edit_->text());
            if (popup_->isVisible()) {
                list_->setCurrentRow(0);
                return true;
            }
        }
    }
    return QWidget::eventFilter(watched, event);
}
