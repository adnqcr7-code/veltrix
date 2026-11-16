#include "settingsdialog.h"

#include "entryrow.h"

#include <QAbstractButton>
#include <QButtonGroup>
#include <QCheckBox>
#include <QColor>
#include <QComboBox>
#include <QDialogButtonBox>
#include <QFileDialog>
#include <QFrame>
#include <QScrollArea>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QMessageBox>
#include <QCoreApplication>
#include <QDesktopServices>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLineEdit>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPixmap>
#include <QPushButton>
#include <QRadioButton>
#include "uisettings.h"
#include <QStackedWidget>
#include <QTimer>
#include <QStandardPaths>
#include <QVBoxLayout>
#include <algorithm>
#include <random>
#include <vector>

#include "theme.h"
#include "icons.h"
#include "vile/search_engines.hpp"
#include "vile/privacy.hpp"
#include <QUrl>

using namespace vile;

namespace {
QCheckBox* toggle(const QString& text, bool checked) {
    auto* c = new QCheckBox(text);
    c->setChecked(checked);
    return c;
}
}  // namespace

void SettingsDialog::pageHeader(QVBoxLayout* lay, const QString& title, const QString& desc) {
    auto* t = new QLabel(title);
    t->setObjectName(QStringLiteral("settingsTitle"));
    lay->addWidget(t);
    auto* d = new QLabel(desc);
    d->setObjectName(QStringLiteral("settingsDesc"));
    d->setWordWrap(true);
    lay->addWidget(d);
    lay->addSpacing(10);
}

QCheckBox* SettingsDialog::settingRow(QVBoxLayout* lay, const QString& title,
                                      const QString& desc, bool checked) {
    auto* c = new QCheckBox;
    c->setChecked(checked);
    // The title is a LABEL, not the checkbox's own text: the
    // settings search paints matched letters inside the title, and
    // a checkbox paints its text as one unbreakable run. Clicking
    // the label toggles the box (eventFilter below), so the row
    // still behaves like one control.
    auto* t = new QLabel(title);
    t->setObjectName(QStringLiteral("settingsCheckTitle"));
    t->setProperty("toggles", QVariant::fromValue(static_cast<QObject*>(c)));
    t->installEventFilter(this);
    auto* row = new QHBoxLayout;
    row->setSpacing(8);
    row->addWidget(c);
    row->addWidget(t);
    row->addStretch(1);
    lay->addLayout(row);
    auto* d = new QLabel(desc);
    d->setObjectName(QStringLiteral("settingsDesc"));
    d->setWordWrap(true);
    d->setIndent(26);
    lay->addWidget(d);
    lay->addSpacing(6);
    return c;
}

bool SettingsDialog::eventFilter(QObject* obj, QEvent* event) {
    if (event->type() == QEvent::MouseButtonRelease) {
        if (auto* box = qobject_cast<QCheckBox*>(
                obj->property("toggles").value<QObject*>()))
            box->toggle();
    }
    return QDialog::eventFilter(obj, event);
}

SettingsDialog::SettingsDialog(PrivacySettings settings,
                               const std::vector<LocalAiProvider>& detected,
                               const QString& blocklistInfo, QWidget* parent)
    : QDialog(parent), settings_(settings), detected_(detected) {
    setWindowTitle(tr("Settings — VILE"));
    // The height floor matches fitToCurrentPage's lower clamp: an
    // earlier 540 minimum silently vetoed every shrink the fit asked
    // for, so short pages rendered at 540 no matter what it computed.
    // 352 (round 13: short pages still floated at 430): the nav's
    // seven rows + chrome fit inside it, and the shortest page
    // (About) now nearly fills its dialog.
    setMinimumSize(780, 352);
    auto* root = new QVBoxLayout(this);
    root->setContentsMargins(16, 16, 16, 12);
    auto* body = new QHBoxLayout;
    body->setSpacing(16);
    root->addLayout(body, 1);

    auto* nav = new QListWidget(this);
    nav->setObjectName(QStringLiteral("settingsNav"));
    nav->setFixedWidth(180);
    nav->setIconSize(QSize(16, 16));
    const std::pair<const char*, icons::Kind> navEntries[] = {
        {"Appearance", icons::Kind::Palette},
        {"Privacy & Shield", icons::Kind::Shield},
        {"Search", icons::Kind::Search},
        {"New Tab", icons::Kind::Grid},
        {"Downloads", icons::Kind::Download},
        {"Local AI", icons::Kind::Sparkle},
        {"About", icons::Kind::Globe},
    };
    for (const auto& [label, kind] : navEntries) {
        auto* item = new QListWidgetItem(
            icons::icon(kind, QColor(QStringLiteral("#a3a3a3"))), tr(label));
        // An explicit row height: the view otherwise measures rows
        // before the stylesheet's padding lands, allocates less
        // than the painted height, and the selected row's background
        // spills over its neighbours — the "one above the other"
        // overlap the settings page used to show.
        item->setSizeHint(QSize(0, 36));
        nav->addItem(item);
    }
    body->addWidget(nav);

    auto* pages = new QStackedWidget(this);
    pages_ = pages;
    body->addWidget(pages, 1);
    connect(nav, &QListWidget::currentRowChanged, pages, &QStackedWidget::setCurrentIndex);
    connect(pages, &QStackedWidget::currentChanged, this,
            [this](int) { fitToCurrentPage(); });
    nav->setCurrentRow(0);

    UiSettings& prefs = uiSettings();
    snapshot_.theme = prefs.theme();
    snapshot_.restoreSession = prefs.restoreSession();
    snapshot_.suggestions = prefs.suggestions();
    snapshot_.ntpClock = prefs.ntpShowClock();
    snapshot_.ntpTiles = prefs.ntpShowTiles();
    snapshot_.ntpStats = prefs.ntpShowStats();
    snapshot_.ntpVisited = prefs.ntpShowVisited();
    snapshot_.downloadsFolder = prefs.downloadsFolder();
    snapshot_.askWhereSave = prefs.askWhereSave();
    snapshot_.userDomains = prefs.userBlockedDomains();
    snapshot_.forceDarkPages = prefs.forceDarkPages();
    snapshot_.railHover = prefs.railHoverExpand();
    snapshot_.verticalTabs = prefs.verticalTabs();
    snapshot_.railDelayMs = prefs.railCollapseDelayMs();
    themeNow_ = snapshot_.theme;

    // ---- Appearance ----
    {
        auto* page = new QWidget;
        auto* lay = new QVBoxLayout(page);
        lay->setContentsMargins(4, 2, 4, 2);
        pageHeader(lay, tr("Appearance"),
                   tr("How VILE looks. Changes here apply immediately."));
        auto* themeHeader = new QLabel(tr("Theme"));
        themeHeader->setObjectName(QStringLiteral("settingsGroup"));
        lay->addWidget(themeHeader);
        auto* themeGroup = new QButtonGroup(this);
        // Two real themes, not accent tints: dark is the original
        // obsidian system, light mirrors it role for role. The
        // preview is the dialog itself — toggling restyles the whole
        // app behind (and including) this window, immediately.
        for (const auto& t : {std::pair<QString, QString>{QStringLiteral("dark"),
                                                          tr("Dark — the original obsidian")},
                              std::pair<QString, QString>{QStringLiteral("light"),
                                                          tr("Light — the same VILE, lit")}}) {
            auto* row = new QWidget(page);
            auto* rowLay = new QHBoxLayout(row);
            rowLay->setContentsMargins(0, 2, 0, 2);
            rowLay->setSpacing(10);
            auto* r = new QRadioButton(t.second);
            r->setChecked(t.first == prefs.theme());
            r->setProperty("themeId", t.first);
            themeGroup->addButton(r);
            rowLay->addWidget(r, 1);
            lay->addWidget(row);
        }
        connect(themeGroup, &QButtonGroup::buttonToggled, this,
                [this](QAbstractButton* b, bool checked) {
                    if (checked) {
                        themeNow_ = b->property("themeId").toString();
                        emit themeChanged(themeNow_);
                    }
                });
        lay->addSpacing(4);
        auto* darkBox = settingRow(
            lay, tr("Ask sites for their dark theme"),
            tr("Sites with a dark theme use it (search engines included); sites "
               "without one stay as they are — VILE doesn't repaint other people's "
               "pages. Chromium's own error pages follow this too. Applies at "
               "restart."),
            prefs.forceDarkPages());
        connect(darkBox, &QCheckBox::toggled, this,
                [](bool on) { uiSettings().setForceDarkPages(on); });
        auto* railBox = settingRow(
            lay, tr("Expand the tab rail on hover"),
            tr("Hovering the rail widens it to show the tab titles "
               "until the pointer leaves."),
            prefs.railHoverExpand());
        connect(railBox, &QCheckBox::toggled, this,
                [](bool on) { uiSettings().setRailHoverExpand(on); });
        auto* vertBox = settingRow(
            lay, tr("Vertical tabs"),
            tr("Tabs down the left edge as site logos. Off: a tab bar "
               "across the top and a bookmarks bar under the address bar."),
            prefs.verticalTabs());
        connect(vertBox, &QCheckBox::toggled, this,
                [](bool on) { uiSettings().setVerticalTabs(on); });
        // Collapse delay: a preset picker, not a free number — the
        // honest choices are fractions of a second to a few seconds.
        auto* delayLabel = new QLabel(tr("Collapse the rail after the pointer leaves"));
        auto* delayRow = new QHBoxLayout;
        delayRow->addWidget(delayLabel);
        auto* delayCombo = new QComboBox(page);
        for (const auto& preset : {std::pair<int, QString>{500, tr("0.5 seconds")},
                                   {1000, tr("1 second")},
                                   {2000, tr("2 seconds")},
                                   {3000, tr("3 seconds")},
                                   {5000, tr("5 seconds")}})
            delayCombo->addItem(preset.second, preset.first);
        const int delayIdx = delayCombo->findData(prefs.railCollapseDelayMs());
        delayCombo->setCurrentIndex(delayIdx >= 0 ? delayIdx : 1);
        connect(delayCombo, &QComboBox::currentIndexChanged, this,
                [delayCombo](int) {
                    uiSettings().setRailCollapseDelayMs(delayCombo->currentData().toInt());
                });
        delayRow->addWidget(delayCombo);
        delayRow->addStretch(1);
        lay->addLayout(delayRow);
        lay->addSpacing(6);
        lay->addStretch(1);
        // Each page scrolls on its own: a section taller than the
        // dialog must clip into a scroll, never off the edge.
        auto* scroll = new QScrollArea;
        scroll->setMinimumHeight(80);
        scroll->setWidget(page);
        scroll->setWidgetResizable(true);
        scroll->setFrameShape(QFrame::NoFrame);
        scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        pages->addWidget(scroll);
    }

    // ---- Privacy & Shield ----
    {
        auto* page = new QWidget;
        auto* lay = new QVBoxLayout(page);
        lay->setContentsMargins(4, 2, 4, 2);
        pageHeader(lay, tr("Privacy & Shield"),
                   tr("What VILE blocks and what it remembers. These apply as you change them."));
        httpsOnly_ = settingRow(
            lay, tr("HTTPS-only"),
            tr("Upgrade plain http pages to https when the site supports it."), settings_.https_only);
        blockTrackers_ = settingRow(
            lay, tr("Block known trackers (Shield)"),
            tr("Block requests to known trackers. Turning this off turns the Shield off."),
            settings_.block_trackers);
        blockCookies_ = settingRow(
            lay, tr("Block third-party cookies"),
            tr("Sites can't set cookies from other sites."), settings_.block_third_party_cookies);
        saveHistory_ = settingRow(
            lay, tr("Save history"),
            tr("Keep a history of visited pages. Off means private mode: nothing is recorded, "
               "and address-bar suggestions have nothing to match."),
            settings_.save_history);
        clearOnExit_ = settingRow(
            lay, tr("Clear cookies and site data on exit"),
            tr("Wipe cookies and site data every time VILE closes."), settings_.clear_on_exit);
        {
            // A UI preference, not a PrivacySetting: it lives in QSettings
            // and applies immediately, like the New Tab toggles.
            auto* restore = settingRow(
                lay, tr("Reopen tabs from last time"),
                tr("Your open tabs come back when VILE starts. Only the page addresses are "
                   "saved — cookies and site data are still wiped if clearing on exit is on."),
                prefs.restoreSession());
            connect(restore, &QCheckBox::toggled, this, [](bool on) {
                uiSettings().setRestoreSession(on);
            });
        }
        sendGpc_ = settingRow(
            lay, tr("Send Global Privacy Control"),
            tr("Tell sites not to sell or share your data (Sec-GPC: 1). Sites may ignore it."),
            settings_.send_gpc);

        // The user's OWN list leads the Shield section: it is the
        // control they came here for, and round 12's design review
        // found it clipped below the fold under the maintained
        // list's (much longer) group.
        auto* mine = new QGroupBox(tr("Your blocked sites"));
        auto* mineLay = new QVBoxLayout(mine);
        auto* mineNote = new QLabel(
            tr("Your own list, on top of the maintained one. Blocking a site here "
               "blocks it and its subdomains — only on this device, and it is never "
               "sent anywhere."));
        mineNote->setWordWrap(true);
        mineLay->addWidget(mineNote);
        userDomainsList_ = new QListWidget;
        userDomainsList_->addItems(prefs.userBlockedDomains());
        mineLay->addWidget(userDomainsList_);
        // The list's empty state + height (round 13's design list):
        // an uncapped QListWidget asks for ~150px even with zero
        // entries — a tall framed void with nothing to say. Show the
        // shared in-list placeholder when empty and fit the height
        // to the content, like the panels' wells.
        // ONE discriminator for "this row is the empty-state
        // placeholder": it carries a widget, real domains never do.
        // (Round 14's code review found refreshDomainsEmpty using
        // the widget test while syncDomains used empty text — two
        // predicates guarding one concept, free to drift apart.)
        auto isPlaceholder = [this](QListWidgetItem* it) {
            return userDomainsList_->itemWidget(it) != nullptr;
        };
        auto refreshDomainsEmpty = [this, isPlaceholder] {
            bool hasReal = false;
            for (int i = userDomainsList_->count() - 1; i >= 0; --i) {
                QListWidgetItem* it = userDomainsList_->item(i);
                if (isPlaceholder(it)) {
                    delete userDomainsList_->takeItem(i);  // placeholder
                } else {
                    hasReal = true;
                }
            }
            if (!hasReal && userDomainsList_->count() == 0)
                entryrow::addPlaceholder(userDomainsList_,
                                         tr("No sites blocked yet — add one below."));
            entryrow::fitWell(userDomainsList_, 5);
        };
        refreshDomainsEmpty();
        auto* addRow = new QHBoxLayout;
        auto* domainEdit = new QLineEdit;
        domainEdit->setPlaceholderText(tr("example.com"));
        addRow->addWidget(domainEdit, 1);
        auto* addBtn = new QPushButton(tr("Block site"));
        auto* removeBtn = new QPushButton(tr("Remove selected"));
        addRow->addWidget(addBtn);
        addRow->addWidget(removeBtn);
        mineLay->addLayout(addRow);
        // Refusals are explained, never silent: an entry the Shield
        // would not enforce must not sit in this list looking blocked
        // (round 12, both the architect and the code review).
        auto* mineHint = new QLabel;
        mineHint->setObjectName(QStringLiteral("mutedLabel"));
        mineHint->setWordWrap(true);
        mineHint->setVisible(false);
        mineLay->addWidget(mineHint);
        auto syncDomains = [this, isPlaceholder] {
            QStringList domains;
            for (int i = 0; i < userDomainsList_->count(); ++i) {
                QListWidgetItem* it = userDomainsList_->item(i);
                if (!isPlaceholder(it)) domains << it->text();
            }
            uiSettings().setUserBlockedDomains(domains);
        };
        connect(addBtn, &QPushButton::clicked, this,
                [this, domainEdit, syncDomains, mineHint, refreshDomainsEmpty] {
            QString d = domainEdit->text().trimmed();
            // Normalise to the host Chromium will actually report:
            // strip scheme / userinfo / path / port, drop a trailing
            // dot, lowercase, and convert IDN to punycode (hosts
            // arrive as xn--…; a UTF-8 entry could never match).
            if (d.contains(QStringLiteral("://"))) d = d.section(QStringLiteral("://"), 1);
            d = d.split('/').first().split('?').first();
            if (d.contains('@')) d = d.section('@', -1);
            d = d.split(':').first().toLower();
            if (d.endsWith('.')) d.chop(1);
            d = QString::fromLatin1(QUrl::toAce(d));
            auto refuse = [mineHint](const QString& why) {
                mineHint->setText(why);
                mineHint->setVisible(true);
            };
            if (d.isEmpty() || !d.contains('.')) {
                refuse(tr("That doesn't look like a site — try example.com."));
                return;
            }
            if (!vile::blocklist_domain_acceptable(d.toStdString())) {
                refuse(tr("%1 is a public suffix — blocking it would block thousands "
                          "of unrelated sites under it, so the Shield won't add it.")
                           .arg(d));
                return;
            }
            mineHint->setVisible(false);
            if (userDomainsList_->findItems(d, Qt::MatchExactly).isEmpty())
                userDomainsList_->addItem(d);
            domainEdit->clear();
            syncDomains();
            refreshDomainsEmpty();
        });
        connect(removeBtn, &QPushButton::clicked, this,
                [this, syncDomains, refreshDomainsEmpty] {
            qDeleteAll(userDomainsList_->selectedItems());
            syncDomains();
            refreshDomainsEmpty();
        });
        lay->addWidget(mine);

        auto* bl = new QGroupBox(tr("Tracker blocklist"));
        auto* blLay = new QVBoxLayout(bl);
        blocklistInfo_ = new QLabel(blocklistInfo);
        blocklistInfo_->setWordWrap(true);
        blLay->addWidget(blocklistInfo_);
        auto* updateBtn = new QPushButton(tr("Update blocklist (downloads the maintained StevenBlack list)"));
        connect(updateBtn, &QPushButton::clicked, this, &SettingsDialog::requestBlocklistUpdate);
        blLay->addWidget(updateBtn);
        lay->addWidget(bl);

        auto* clearBtn = new QPushButton(tr("Clear browsing data…"));
        clearBtn->setObjectName(QStringLiteral("dangerButton"));
        connect(clearBtn, &QPushButton::clicked, this, &SettingsDialog::requestClearData);
        // Content width, not a full-width slab: this button only opens
        // the clear-data dialog; it deletes nothing itself.
        auto* clearRow = new QHBoxLayout;
        clearRow->addWidget(clearBtn);
        clearRow->addStretch(1);
        lay->addLayout(clearRow);
        lay->addStretch(1);
        // Each page scrolls on its own: a section taller than the
        // dialog must clip into a scroll, never off the edge.
        auto* scroll = new QScrollArea;
        scroll->setMinimumHeight(80);
        scroll->setWidget(page);
        scroll->setWidgetResizable(true);
        scroll->setFrameShape(QFrame::NoFrame);
        scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        pages->addWidget(scroll);
    }

    // ---- Search: engines in RANDOM order ----
    {
        auto* page = new QWidget;
        auto* lay = new QVBoxLayout(page);
        lay->setContentsMargins(4, 2, 4, 2);
        pageHeader(lay, tr("Search"),
                   tr("Pick a search engine. The order is shuffled every time so no engine "
                      "gets the top spot by default. This applies as you change it."));
        std::vector<SearchEngine> engines = search_engines();
        std::shuffle(engines.begin(), engines.end(),
                     std::mt19937{std::random_device{}()});
        for (const auto& e : engines) {
            auto* r = new QRadioButton(QString::fromStdString(e.name));
            r->setChecked(e.id == settings_.search_engine_id);
            r->setToolTip(QString::fromStdString(e.summary + "\n\nSource: " + e.source_url +
                                                 " (checked " + e.checked_on + ")"));
            lay->addWidget(r);
            auto* summary = new QLabel(QString::fromStdString(e.summary));
            summary->setObjectName(QStringLiteral("settingsDesc"));
            summary->setWordWrap(true);
            summary->setIndent(22);
            lay->addWidget(summary);
            engineRadios_.append(r);
            engineIds_.append(QString::fromStdString(e.id));
        }
        lay->addSpacing(12);
        auto* sugg = settingRow(
            lay, tr("Address-bar suggestions"),
            tr("Show history matches, !bangs and a search row as you type. Needs history on "
               "to match past pages."),
            prefs.suggestions());
        connect(sugg, &QCheckBox::toggled, this, [](bool on) {
            uiSettings().setSuggestions(on);
        });
        lay->addStretch(1);
        // Each page scrolls on its own: a section taller than the
        // dialog must clip into a scroll, never off the edge.
        auto* scroll = new QScrollArea;
        scroll->setMinimumHeight(80);
        scroll->setWidget(page);
        scroll->setWidgetResizable(true);
        scroll->setFrameShape(QFrame::NoFrame);
        scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        pages->addWidget(scroll);
    }

    // ---- New Tab ----
    {
        auto* page = new QWidget;
        auto* lay = new QVBoxLayout(page);
        lay->setContentsMargins(4, 2, 4, 2);
        pageHeader(lay, tr("New Tab"),
                   tr("What a blank tab shows. Changes here apply to the next new tab."));
        auto addNtp = [&prefs, lay, this](const QString& title, const QString& desc,
                                         const char* key) {
            const QString k = QString::fromLatin1(key);
            const bool initial = k == QLatin1String("ntp/showClock")   ? prefs.ntpShowClock()
                                 : k == QLatin1String("ntp/showTiles") ? prefs.ntpShowTiles()
                                 : k == QLatin1String("ntp/showStats") ? prefs.ntpShowStats()
                                                                       : prefs.ntpShowVisited();
            auto* c = settingRow(lay, title, desc, initial);
            connect(c, &QCheckBox::toggled, this, [k](bool on) {
                if (k == QLatin1String("ntp/showClock")) uiSettings().setNtpShowClock(on);
                else if (k == QLatin1String("ntp/showTiles")) uiSettings().setNtpShowTiles(on);
                else if (k == QLatin1String("ntp/showStats")) uiSettings().setNtpShowStats(on);
                else uiSettings().setNtpShowVisited(on);
            });
        };
        addNtp(tr("Show clock and date"),
               tr("The time and date at the top of the new tab page."), "ntp/showClock");
        addNtp(tr("Show bookmarks"),
               tr("The bookmarks package in the tab rail — the colour-squares "
                  "tile at the top of the rail, opening into your saved sites."),
               "ntp/showTiles");
        addNtp(tr("Show trackers blocked"),
               tr("How many trackers the Shield blocked this session."), "ntp/showStats");
        lay->addStretch(1);
        // Each page scrolls on its own: a section taller than the
        // dialog must clip into a scroll, never off the edge.
        auto* scroll = new QScrollArea;
        scroll->setMinimumHeight(80);
        scroll->setWidget(page);
        scroll->setWidgetResizable(true);
        scroll->setFrameShape(QFrame::NoFrame);
        scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        pages->addWidget(scroll);
    }

    // ---- Downloads ----
    {
        auto* page = new QWidget;
        auto* lay = new QVBoxLayout(page);
        lay->setContentsMargins(4, 2, 4, 2);
        pageHeader(lay, tr("Downloads"),
                   tr("Where downloaded files go. Applies to the next download."));
        // This is the shortest page — alone at the dialog's floor
        // height (the section nav sets the minimum). Splitting the
        // surplus above and below the controls centres them in the
        // space instead of leaving one block of air underneath
        // (the design critics' standing note, rounds 14-16).
        lay->addStretch(1);
        const QString defaultFolder =
            QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
        downloadFolderLabel_ = new QLabel(
            prefs.downloadsFolder(), page);
        downloadFolderLabel_->setObjectName(QStringLiteral("mutedLabel"));
        downloadFolderLabel_->setWordWrap(true);
        auto* folderRow = new QHBoxLayout;
        folderRow->addWidget(downloadFolderLabel_, 1);
        auto* chooseBtn = new QPushButton(tr("Choose…"), page);
        connect(chooseBtn, &QPushButton::clicked, this, [this, defaultFolder] {
            const QString dir = QFileDialog::getExistingDirectory(
                this, tr("Choose download folder"), downloadFolderLabel_->text());
            if (!dir.isEmpty()) {
                uiSettings().setDownloadsFolder(dir);
                downloadFolderLabel_->setText(dir);
            }
        });
        folderRow->addWidget(chooseBtn);
        auto* resetBtn = new QPushButton(tr("Default"), page);
        resetBtn->setToolTip(tr("Back to the system Downloads folder"));
        connect(resetBtn, &QPushButton::clicked, this, [this, defaultFolder] {
            uiSettings().resetDownloadsFolder();
            downloadFolderLabel_->setText(defaultFolder);
        });
        folderRow->addWidget(resetBtn);
        lay->addLayout(folderRow);
        auto* askBox = settingRow(lay, tr("Ask where to save each file"),
                                  tr("Show a save dialog for every download instead of "
                                     "saving straight to the folder above."),
                                  prefs.askWhereSave());
        connect(askBox, &QCheckBox::toggled, this, [](bool on) {
            uiSettings().setAskWhereSave(on);
        });
        lay->addStretch(1);
        // Each page scrolls on its own: a section taller than the
        // dialog must clip into a scroll, never off the edge.
        auto* scroll = new QScrollArea;
        scroll->setMinimumHeight(80);
        scroll->setWidget(page);
        scroll->setWidgetResizable(true);
        scroll->setFrameShape(QFrame::NoFrame);
        scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        pages->addWidget(scroll);
    }

    // ---- Local AI ----
    {
        auto* page = new QWidget;
        auto* lay = new QVBoxLayout(page);
        lay->setContentsMargins(4, 2, 4, 2);
        pageHeader(lay, tr("Local AI"),
                   tr("The page assistant only talks to software on this computer. "
                      "It never sends page text anywhere else."));
        if (detected_.empty()) {
            lay->addWidget(new QLabel(tr("No local AI server was found on this computer "
                                          "(looked for Ollama, LM Studio and llama.cpp). "
                                          "Start one, then reopen Settings to enable the page assistant.")));
            aiEnabled_ = toggle(tr("Enable on-device AI page assistant"), false);
            aiEnabled_->setEnabled(false);
            lay->addWidget(aiEnabled_);
        } else {
            aiEnabled_ = settingRow(lay, tr("Enable on-device AI page assistant"),
                                    tr("Explain the current page, or answer questions about it. "
                                       "Read-only: it never clicks, navigates or runs anything."),
                                    settings_.ai_enabled);
            auto* form = new QFormLayout;
            aiProvider_ = new QComboBox;
            for (const auto& p : detected_)
                aiProvider_->addItem(QString::fromStdString(p.display_name),
                                     QString::fromStdString(p.id));
            int idx = aiProvider_->findData(QString::fromStdString(settings_.ai_provider));
            if (idx >= 0) aiProvider_->setCurrentIndex(idx);
            form->addRow(tr("Provider:"), aiProvider_);
            aiModel_ = new QComboBox;
            form->addRow(tr("Model:"), aiModel_);
            lay->addLayout(form);
            connect(aiProvider_, &QComboBox::currentIndexChanged, this,
                    &SettingsDialog::rebuildModelCombo);
            rebuildModelCombo();
        }
        lay->addStretch(1);
        // Each page scrolls on its own: a section taller than the
        // dialog must clip into a scroll, never off the edge.
        auto* scroll = new QScrollArea;
        scroll->setMinimumHeight(80);
        scroll->setWidget(page);
        scroll->setWidgetResizable(true);
        scroll->setFrameShape(QFrame::NoFrame);
        scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        pages->addWidget(scroll);
    }

    // ---- About & updates ----
    {
        auto* page = new QWidget;
        auto* lay = new QVBoxLayout(page);
        lay->setContentsMargins(22, 18, 22, 18);
        lay->setSpacing(10);
        pageHeader(lay, tr("About VILE"), tr("A private browser. The AI stays on your machine, and so does your history."));
        auto* logo = new QLabel;
        logo->setPixmap(QPixmap(QStringLiteral(":/assets/logo-alpha.png"))
                            .scaled(84, 84, Qt::KeepAspectRatio, Qt::SmoothTransformation));
        lay->addWidget(logo);
        // Set once in main.cpp from the CMake project version —
        // deliberately no fallback literal here to drift against it.
        const QString version = QCoreApplication::applicationVersion();
        auto* versionLabel = new QLabel(tr("Version %1").arg(version));
        versionLabel->setObjectName(QStringLiteral("settingsGroup"));
        lay->addWidget(versionLabel);
        updateStatus_ = new QLabel(tr("Updates come from the VILE repository on GitHub."));
        updateStatus_->setWordWrap(true);
        lay->addWidget(updateStatus_);
        auto* updateRow = new QHBoxLayout;
        auto* checkBtn = new QPushButton(tr("Check for updates"));
        updateOpenBtn_ = new QPushButton(tr("Open the release page"));
        updateOpenBtn_->setEnabled(false);
        updateRow->addWidget(checkBtn);
        updateRow->addWidget(updateOpenBtn_);
        updateRow->addStretch(1);
        lay->addLayout(updateRow);
        connect(updateOpenBtn_, &QPushButton::clicked, this, [this] {
            if (!updateUrl_.isEmpty()) QDesktopServices::openUrl(QUrl(updateUrl_));
        });
        connect(checkBtn, &QPushButton::clicked, this, [this, checkBtn, version] {
            updateStatus_->setText(tr("Checking the repository…"));
            updateOpenBtn_->setEnabled(false);
            checkBtn->setEnabled(false);  // one check in flight, never two racing
            auto* net = new QNetworkAccessManager(this);
            QNetworkRequest req{QUrl(QStringLiteral(
                "https://api.github.com/repos/mymaniscr7-sudo/vile/releases/latest"))};
            req.setHeader(QNetworkRequest::UserAgentHeader,
                          QStringLiteral("VILE update check"));
            QNetworkReply* reply = net->get(req);
            connect(reply, &QNetworkReply::finished, this,
                    [this, reply, net, version, checkBtn] {
                reply->deleteLater();
                net->deleteLater();
                checkBtn->setEnabled(true);
                if (reply->error() != QNetworkReply::NoError) {
                    updateStatus_->setText(
                        tr("Couldn't check for updates — no releases published yet, "
                           "or you're offline."));
                    return;
                }
                const QJsonObject obj =
                    QJsonDocument::fromJson(reply->readAll()).object();
                QString tag = obj.value(QStringLiteral("tag_name")).toString();
                if (tag.startsWith('v') || tag.startsWith('V')) tag.remove(0, 1);
                updateUrl_ = obj.value(QStringLiteral("html_url")).toString();
                // "Latest version" is an affirmative claim and needs an
                // affirmative basis: a tag that actually parses as a
                // version. A 200 with no usable tag (API shape change,
                // proxy garbage) is a COULDN'T-CHECK, not an all-clear
                // (round 12). Components compare by their leading
                // digits, so "3-beta" reads as 3 rather than 0.
                auto components = [](const QString& v) {
                    std::vector<int> out;
                    for (const QString& part : v.split('.')) {
                        QString digits;
                        for (QChar ch : part) {
                            if (!ch.isDigit()) break;
                            digits += ch;
                        }
                        if (digits.isEmpty()) return std::vector<int>{};
                        out.push_back(digits.toInt());
                    }
                    return out;
                };
                const std::vector<int> tagParts = components(tag);
                if (tagParts.empty()) {
                    updateStatus_->setText(
                        tr("Couldn't check for updates — the reply didn't include a "
                           "version I can compare."));
                    return;
                }
                const std::vector<int> curParts = components(version);
                bool isNewer = false, decided = false;
                for (size_t i = 0; i < qMax(tagParts.size(), curParts.size()); ++i) {
                    const int na = i < tagParts.size() ? tagParts[i] : 0;
                    const int nb = i < curParts.size() ? curParts[i] : 0;
                    if (na != nb) {
                        isNewer = na > nb;
                        decided = true;
                        break;
                    }
                }
                if (isNewer && decided) {
                    updateStatus_->setText(
                        tr("Version %1 is available — you have %2.").arg(tag, version));
                    updateOpenBtn_->setEnabled(!updateUrl_.isEmpty());
                } else {
                    updateStatus_->setText(tr("You're on the latest version."));
                }
            });
        });
        lay->addStretch(1);
        pages->addWidget(page);
    }

    buttons_ = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
    // Text-only buttons: the platform theme's green-check / red-cross
    // icons are the only stock clip art left in the dialog.
    if (auto* ok = buttons_->button(QDialogButtonBox::Ok)) ok->setIcon(QIcon());
    if (auto* cancel = buttons_->button(QDialogButtonBox::Cancel)) cancel->setIcon(QIcon());
    connect(buttons_, &QDialogButtonBox::accepted, this, &QDialog::accept);
    connect(buttons_, &QDialogButtonBox::rejected, this, &QDialog::reject);
    root->addWidget(buttons_);
}

void SettingsDialog::setEmbedded(bool on) {
    embedded_ = on;
    if (buttons_) buttons_->setVisible(!on);
    if (on) wireLiveApply();
}

void SettingsDialog::setCurrentPage(int index) {
    if (!pages_) return;
    pages_->setCurrentIndex(index);
    if (auto* nav = findChild<QListWidget*>(QStringLiteral("settingsNav")))
        nav->setCurrentRow(index);
}

void SettingsDialog::wireLiveApply() {
    if (liveWired_) return;
    liveWired_ = true;
    // Embedded (tab) mode has no OK to press: every privacy change
    // applies the moment it's made, like a browser settings page.
    auto emitNow = [this] { emit privacySettingsChanged(settings()); };
    for (QCheckBox* box :
         {httpsOnly_, blockTrackers_, blockCookies_, saveHistory_, clearOnExit_,
          sendGpc_, aiEnabled_})
        if (box) connect(box, &QCheckBox::toggled, this, emitNow);
    for (QRadioButton* r : engineRadios_)
        connect(r, &QRadioButton::toggled, this, [emitNow](bool on) {
            if (on) emitNow();
        });
    if (aiProvider_)
        connect(aiProvider_, &QComboBox::currentIndexChanged, this, emitNow);
    if (aiModel_)
        connect(aiModel_, &QComboBox::currentIndexChanged, this, emitNow);
}

void SettingsDialog::fitToCurrentPage() {
    if (embedded_ || !isVisible() || !pages_) return;
    QWidget* page = pages_->currentWidget();
    if (!page) return;
    // Every page is a scroll area over a content widget. The fit is
    // driven by the CONTENT's natural height: a scroll area's own
    // sizeHint tracks its viewport, so measuring the page itself (as
    // the first version did, before bailing out on scroll areas
    // entirely — i.e. on every page) resized nothing, ever.
    int contentH = page->sizeHint().height();
    if (auto* scroll = qobject_cast<QScrollArea*>(page)) {
        if (QWidget* inner = scroll->widget()) {
            contentH = inner->sizeHint().height();
            // Wrapped labels make the true height width-dependent:
            // sizeHint prices them at a width the page may not have.
            // When the layout can answer for the CURRENT width, that
            // answer is the honest one.
            if (inner->layout() && inner->layout()->hasHeightForWidth() &&
                inner->width() > 0)
                contentH = inner->layout()->heightForWidth(inner->width());
        }
    }
    // Chrome = everything that is not the page stack, measured as
    // built (title, button row, margins) so the fit self-calibrates.
    const int chrome = height() - pages_->height();
    if (chrome <= 0) return;
    resize(width(), qBound(352, contentH + chrome, 780));
}

void SettingsDialog::showEvent(QShowEvent* event) {
    QDialog::showEvent(event);
    // The initial page was selected before the dialog had geometry;
    // fit once it does. Then fit AGAIN once the width has settled:
    // the first fit measures wrapped labels at whatever width the
    // dialog happens to have in its first event-loop turn, and a
    // description that wraps to three lines there but two at the
    // final width left the dialog a line too tall (round 13's
    // floating-pages item, last 17px).
    QTimer::singleShot(0, this, [this] { fitToCurrentPage(); });
    QTimer::singleShot(90, this, [this] { fitToCurrentPage(); });
}

void SettingsDialog::rebuildModelCombo() {
    if (!aiModel_ || !aiProvider_) return;
    aiModel_->clear();
    QString providerId = aiProvider_->currentData().toString();
    for (const auto& p : detected_) {
        if (QString::fromStdString(p.id) != providerId) continue;
        for (const auto& m : p.models) {
            QString label = QString::fromStdString(m.name);
            if (m.size_bytes > 0)
                label += QStringLiteral(" (%1)").arg(QString::fromStdString(format_size(m.size_bytes)));
            aiModel_->addItem(label, QString::fromStdString(p.id + "|" + m.name));
        }
    }
    int idx = aiModel_->findData(QString::fromStdString(settings_.ai_provider + "|" + settings_.ai_model));
    if (idx >= 0) aiModel_->setCurrentIndex(idx);
}

PrivacySettings SettingsDialog::settings() const {
    PrivacySettings s = settings_;
    s.https_only = httpsOnly_->isChecked();
    s.block_trackers = blockTrackers_->isChecked();
    s.block_third_party_cookies = blockCookies_->isChecked();
    s.save_history = saveHistory_->isChecked();
    s.clear_on_exit = clearOnExit_->isChecked();
    s.send_gpc = sendGpc_->isChecked();
    for (int i = 0; i < engineRadios_.size(); ++i)
        if (engineRadios_[i]->isChecked()) s.search_engine_id = engineIds_[i].toStdString();
    if (aiEnabled_) {
        s.ai_enabled = aiEnabled_->isChecked();
        if (aiProvider_ && aiModel_ && aiModel_->currentIndex() >= 0) {
            QString data = aiModel_->currentData().toString();
            auto parts = data.split('|');
            if (parts.size() == 2) {
                s.ai_provider = parts[0].toStdString();
                s.ai_model = parts[1].toStdString();
            }
        }
    }
    return s;
}

void SettingsDialog::refreshBlocklistInfo(const QString& info) {
    if (blocklistInfo_) blocklistInfo_->setText(info);
}

int SettingsDialog::highlightSearch(const QString& query) {
    // Undo the last search's paint: restore each label's plain text.
    for (const RichRestore& r : searchRich_)
        if (r.label) {
            r.label->setTextFormat(Qt::AutoText);
            r.label->setText(r.text);
        }
    searchRich_.clear();
    const QString q = query.trimmed().toLower();
    if (q.isEmpty() || !pages_) return 0;

    // One candidate text, scored: an exact substring is the best
    // match (earlier is better); failing that, the query's letters
    // appearing in order (a subsequence) is the closest-match the
    // user meant — "his" still finds "history" settings if a stray
    // letter crept in.
    struct Match {
        int score = -1;
        QVector<QPair<int, int>> ranges;  // [start, length) in plain text
    };
    auto scoreText = [&q](const QString& plain) {
        Match m;
        const QString lower = plain.toLower();
        const int pos = lower.indexOf(q);
        if (pos >= 0) {
            m.score = 10000 - pos;
            m.ranges.append({pos, q.size()});
            return m;
        }
        int qi = 0, first = -1, last = -1;
        QVector<QPair<int, int>> hits;
        for (int i = 0; i < lower.size() && qi < q.size(); ++i) {
            if (lower[i] == q[qi]) {
                hits.append({i, 1});
                if (first < 0) first = i;
                last = i;
                ++qi;
            }
        }
        if (qi == q.size() && !hits.isEmpty()) {
            m.score = 5000 - (last - first);
            m.ranges = hits;
        }
        return m;
    };
    // Paint ONLY the matched letters: the plain text is escaped
    // segment by segment so the span tags land exactly on them.
    auto paint = [this](QLabel* label, const Match& m) {
        const QString plain = label->text();
        QString html;
        int cursor = 0;
        for (const auto& [start, len] : m.ranges) {
            html += plain.mid(cursor, start - cursor).toHtmlEscaped();
            html += QStringLiteral(
                "<span style=\"background-color:#ffd94d;color:#141414\">");
            html += plain.mid(start, len).toHtmlEscaped();
            html += QStringLiteral("</span>");
            cursor = start + len;
        }
        html += plain.mid(cursor).toHtmlEscaped();
        searchRich_.append({label, plain});
        label->setTextFormat(Qt::RichText);
        label->setText(html);
    };

    int total = 0;
    int bestScore = -1;
    int bestPage = -1;
    for (int i = 0; i < pages_->count(); ++i) {
        QWidget* page = pages_->widget(i);
        auto considerScore = [&](const Match& m) {
            if (m.score < 0) return;
            ++total;
            if (m.score > bestScore) {
                bestScore = m.score;
                bestPage = i;
            }
        };
        for (QLabel* l : page->findChildren<QLabel*>()) {
            // Search-highlight restore bookkeeping keys on the
            // label's plain text; skip labels already painted.
            if (l->textFormat() == Qt::RichText) continue;
            const Match m = scoreText(l->text());
            if (m.score >= 0) {
                considerScore(m);
                paint(l, m);
            }
        }
        // Buttons and radios can't paint part of their text; they
        // still count as matches and steer the page jump.
        for (QAbstractButton* b : page->findChildren<QAbstractButton*>())
            considerScore(scoreText(b->text()));
    }
    if (bestPage >= 0) setCurrentPage(bestPage);
    return total;
}

void SettingsDialog::reject() {
    // Undo the live preview: every channel that wrote through (or
    // signalled out) while the dialog was open goes back to the
    // snapshot. Signal-driven channels are restored BY signalling —
    // the window owns their application, and it reapplies (and
    // re-saves) exactly as it did for the preview.
    UiSettings& prefs = uiSettings();
    if (prefs.restoreSession() != snapshot_.restoreSession)
        prefs.setRestoreSession(snapshot_.restoreSession);
    if (prefs.suggestions() != snapshot_.suggestions)
        prefs.setSuggestions(snapshot_.suggestions);
    if (prefs.ntpShowClock() != snapshot_.ntpClock) prefs.setNtpShowClock(snapshot_.ntpClock);
    if (prefs.ntpShowTiles() != snapshot_.ntpTiles) prefs.setNtpShowTiles(snapshot_.ntpTiles);
    if (prefs.ntpShowStats() != snapshot_.ntpStats) prefs.setNtpShowStats(snapshot_.ntpStats);
    if (prefs.ntpShowVisited() != snapshot_.ntpVisited)
        prefs.setNtpShowVisited(snapshot_.ntpVisited);
    if (prefs.downloadsFolder() != snapshot_.downloadsFolder)
        prefs.setDownloadsFolder(snapshot_.downloadsFolder);
    if (prefs.askWhereSave() != snapshot_.askWhereSave)
        prefs.setAskWhereSave(snapshot_.askWhereSave);
    if (prefs.userBlockedDomains() != snapshot_.userDomains)
        prefs.setUserBlockedDomains(snapshot_.userDomains);
    if (prefs.forceDarkPages() != snapshot_.forceDarkPages)
        prefs.setForceDarkPages(snapshot_.forceDarkPages);
    if (prefs.railHoverExpand() != snapshot_.railHover)
        prefs.setRailHoverExpand(snapshot_.railHover);
    if (prefs.verticalTabs() != snapshot_.verticalTabs)
        prefs.setVerticalTabs(snapshot_.verticalTabs);
    if (prefs.railCollapseDelayMs() != snapshot_.railDelayMs)
        prefs.setRailCollapseDelayMs(snapshot_.railDelayMs);
    if (themeNow_ != snapshot_.theme) emit themeChanged(snapshot_.theme);
    QDialog::reject();
}
