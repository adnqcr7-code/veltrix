// Qt-layer tests — the layer the screenshot demo cannot verify. The
// demo asserts nothing; these do. Run offscreen (ctest sets
// QT_QPA_PLATFORM=offscreen): WebEngine works headless with the
// software-GL flags set in main().
#include <QtTest>

#include <memory>

#include <QApplication>
#include <QTextEdit>

#include "../assistantpanel.h"
#include <QPushButton>
#include <QSettings>
#include <QCheckBox>
#include <QComboBox>
#include <QLabel>
#include <QLineEdit>
#include <QLayout>
#include <QListWidget>
#include <QElapsedTimer>
#include <functional>
#include <QRadioButton>
#include <QSignalSpy>
#include <QStandardPaths>
#include <QStackedWidget>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineView>
#include <QWidget>

#include "../cleardatadialog.h"
#include "../downloadspanel.h"
#include "../mainwindow.h"
#include "../qt_engine.h"
#include "../sessionstore.h"
#include "../settingsdialog.h"
#include "../tabstripcontroller.h"
#include "../uisettings.h"
#include "../faviconstore.h"
#include "../theme.h"
#include "../addressbar.h"
#include "../ntppage.h"
#include "vile/browser.hpp"
#include "vile/privacy.hpp"
#include "vile/storage.hpp"

#include <atomic>

// Qt's profile-teardown warning ("Release of profile requested but
// WebEnginePage still not deleted") is the sound of a page outliving
// its profile. It printed five times per test run while every test
// passed — a suite that ignores its own stderr teaches nothing. The
// hard enforcement is CTest's FAIL_REGULAR_EXPRESSION on this suite
// (qt/CMakeLists.txt): if the string ever appears in the output, the
// test fails regardless of QTest's verdicts. The counter here is a
// second net for handler chains that do forward the message.
static std::atomic<int> g_profileReleaseWarnings{0};
static QtMessageHandler g_previousHandler = nullptr;
static void countingMessageHandler(QtMsgType type, const QMessageLogContext& ctx,
                                   const QString& msg) {
    if (msg.contains(QStringLiteral("Release of profile requested")))
        g_profileReleaseWarnings.fetch_add(1);
    if (g_previousHandler) g_previousHandler(type, ctx, msg);
}

using namespace vile;

// Restores a UiSettings downloads folder on EVERY exit path — two
// download tests saved/restored by hand and only on success, so a
// failed QVERIFY used to leave the scratch folder configured.
struct FolderRestore {
    UiSettings& settings;
    QString old;
    explicit FolderRestore(UiSettings& s) : settings(s), old(s.downloadsFolder()) {}
    ~FolderRestore() { settings.setDownloadsFolder(old); }
};

// Same discipline for the theme-switch test: restore the FOUND
// theme and clear the app stylesheet on EVERY exit path (round 14's
// code review: the restore lines used to sit after the assertions,
// happy-path only, and hardcoded "dark" — a mid-test failure left
// the whole process styled for every later slot).
struct ThemeRestore {
    UiSettings& settings;
    QString old;
    explicit ThemeRestore(UiSettings& s) : settings(s), old(s.theme()) {}
    ~ThemeRestore() {
        settings.setTheme(old);
        qApp->setStyleSheet(QString());
    }
};

// Poll a predicate on the event loop until it holds or time runs out.
static bool waitForPred(const std::function<bool()>& pred, int ms) {
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < ms) {
        if (pred()) return true;
        QTest::qWait(50);
    }
    return pred();
}

class UiTests : public QObject {
    Q_OBJECT
private slots:
    // The theme system is a hand-maintained token table whose failure
    // mode is SILENT (Qt drops an unresolvable declaration, and a
    // literal @role@ in the output shows as a subtly wrong colour).
    // Round 13's code critic found zero tests touching it. These pin
    // the contract: both palettes fully resolve, the anchor colours
    // are present, and the two themes genuinely differ.
    void themeStylesheetsResolve() {
        const Accent violet = accentById(QStringLiteral("violet"));
        QCOMPARE(violet.primary, QStringLiteral("#7c2bf5"));
        // An unknown id falls back to the brand violet, never to junk.
        QCOMPARE(accentById(QStringLiteral("no-such-accent")).primary,
                 QStringLiteral("#7c2bf5"));
        const QString dark = appStyleSheet(violet, darkPalette());
        const QString light = appStyleSheet(violet, lightPalette());
        QVERIFY2(!dark.contains(QLatin1Char('@')),
                 "dark stylesheet has an unresolved @role@ token");
        QVERIFY2(!light.contains(QLatin1Char('@')),
                 "light stylesheet has an unresolved @role@ token");
        QVERIFY(dark.contains(QStringLiteral("#131316")));   // bg
        QVERIFY(dark.contains(QStringLiteral("#2c2552")));   // selected tab
        QVERIFY(light.contains(QStringLiteral("#f6f6f9")));  // light bg
        QVERIFY(dark != light);
        QCOMPARE(paletteById(QStringLiteral("light")).bg,
                 QStringLiteral("#f6f6f9"));
        QCOMPARE(paletteById(QStringLiteral("bogus")).bg,
                 darkPalette().bg);
    }

    // The new-tab page takes its colours from the same Palette
    // (round 13, T3). This test exists because the first palette
    // conversion silently missed the page-background slot — its
    // search pattern matched the OLD swap table's copy of the
    // string instead of the CSS literal — and shipped a light page
    // with a black background. Pin the outcome, not the mechanism.
    void ntpPageFollowsPalette() {
        NtpPage::Inputs in;
        in.searchTemplate =
            QStringLiteral("https://search.brave.com/search?q={q}");
        in.accent = accentById(QStringLiteral("violet"));
        in.palette = darkPalette();
        const QString dark = NtpPage::html(in);
        QVERIFY(dark.contains(QStringLiteral("#131316")));
        QVERIFY2(!dark.contains(QStringLiteral("__")),
                 "dark NTP has an unresolved __TOKEN__");
        in.palette = lightPalette();
        const QString light = NtpPage::html(in);
        QVERIFY(light.contains(QStringLiteral("#f6f6f9")));
        QVERIFY2(!light.contains(QStringLiteral("#131316")),
                 "light NTP still carries the dark page background");
        QVERIFY2(!light.contains(QStringLiteral("__")),
                 "light NTP has an unresolved __TOKEN__");
    }

    // Round 13, finding T1: a LIVE theme switch must re-draw the
    // pixmap consumers (nav/rail icons, favorite-tile stylesheets),
    // not just restyle surfaces — the dialog promises changes apply
    // immediately. Before the fix, both assertions below failed:
    // the icons were drawn once in the constructor and the tiles'
    // hover was a literal from the outgoing theme.
    void liveThemeSwitchRedrawsIcons() {
        ThemeRestore themeGuard(uiSettings());
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        Database db((dir.path() + "/theme.db").toStdString());
        PrivacySettings settings;
        MainWindow window(db, settings, {}, dir.path());
        window.applyTheme(QStringLiteral("dark"));
        QPushButton* navBtn = nullptr;
        for (QPushButton* b : window.findChildren<QPushButton*>()) {
            if (b->objectName() == QStringLiteral("navButton")) {
                navBtn = b;
                break;
            }
        }
        QVERIFY(navBtn != nullptr);
        const QImage darkIcon = navBtn->icon().pixmap(18, 18).toImage();
        // The stylesheet is rebuilt from the incoming palette (the
        // sidebar favorite tiles that used to prove this are gone —
        // the app stylesheet is the same claim on the same switch).
        QVERIFY(qApp->styleSheet().contains(QStringLiteral("#131316")));
        window.applyTheme(QStringLiteral("light"));
        const QImage lightIcon = navBtn->icon().pixmap(18, 18).toImage();
        QVERIFY2(darkIcon != lightIcon,
                 "nav icon did not change with the theme");
        QVERIFY(qApp->styleSheet().contains(QStringLiteral("#f6f6f9")));
        QVERIFY(!qApp->styleSheet().contains(QStringLiteral("#131316")));
        // themeGuard (RAII, above) restores the found theme and
        // clears the app stylesheet on every exit path — no test
        // before this one ever set a stylesheet, and later
        // layout-measuring tests (tab title budgets) were written
        // against the unstyled state.
    }

    // Private mode must be a real off-the-record profile, not a flag:
    // flipping the engine moves a LIVE view to the OTR profile and back.
    void otrProfileSwap() {
        ShieldAccess access;
        access.shield.store(std::make_shared<Shield>());
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        QtEngine engine(dir.path(), &access);
        const ViewId v = engine.create_view("about:blank");
        QWebEngineView* view = engine.viewFor(v);
        QVERIFY(view != nullptr);
        QVERIFY(!view->page()->profile()->isOffTheRecord());
        engine.set_private_mode(true);
        QVERIFY(view->page()->profile()->isOffTheRecord());
        engine.set_private_mode(false);
        QVERIFY(!view->page()->profile()->isOffTheRecord());
    }

    // Many downloads at once: the panel indexes its rows by a
    // per-item id into heap items, and adding or clearing rows must
    // never invalidate or re-point the entries already handed out
    // (a reallocating container behind the index was a use-after-free;
    // a value-shifting one mis-pointed them). Real downloads through a
    // loopback server exercise exactly that path, including a clear
    // with downloads still in flight on both sides of a finished one.
    // Tab title budgets: the row layout once gave its trailing
    // spacer stretch factor 1, splitting every row's surplus evenly
    // with the title label — halving all titles and eating the
    // active tab's width premium (measured: 59 px titles in 150 px
    // rows). The spacer is factor 0 now: titles take the surplus,
    // the active title is the widest, and a pinned row's lone icon
    // still packs to the start.
    void tabTitleBudgets() {
        QWidget listHost, stackHost;
        ShieldAccess access;
        access.shield.store(std::make_shared<Shield>());
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        QtEngine engine(dir.path(), &access);
        Browser browser(engine);
        const TabId pinnedId = browser.open_tab("https://en.wikipedia.org/wiki/Vile");
        browser.open_tab("https://en.wikipedia.org/wiki/Browser");
        const TabId mid = browser.open_tab("https://en.wikipedia.org/wiki/Tab");
        browser.open_tab("https://duckduckgo.com/?q=x");
        browser.open_tab("https://example.com");
        browser.set_pinned(pinnedId, true);
        browser.activate(mid);
        TabStripController ctl(browser, engine, &listHost, &stackHost);
        ctl.setVertical(false);
        ctl.list()->setFlow(QListView::LeftToRight);
        ctl.list()->setWrapping(false);
        ctl.syncNow();
        listHost.resize(900, 60);
        listHost.show();
        QTest::qWait(80);
        QListWidget* list = ctl.list();
        int inactiveTitle = -1, activeTitle = -1;
        for (int i = 0; i < list->count(); ++i) {
            QListWidgetItem* item = list->item(i);
            QWidget* iw = list->itemWidget(item);
            QVERIFY(iw != nullptr);
            const auto id = static_cast<TabId>(item->data(Qt::UserRole).toULongLong());
            if (id == pinnedId) {
                QLabel* icon = iw->findChild<QLabel*>(QStringLiteral("tabIcon"));
                QVERIFY(icon != nullptr);
                QVERIFY2(icon->x() <= 12,
                         qPrintable(QStringLiteral("pinned icon drifted to x=%1").arg(icon->x())));
                continue;
            }
            QLabel* title = iw->findChild<QLabel*>(QStringLiteral("tabTitle"));
            QVERIFY(title != nullptr);
            if (id == mid) activeTitle = title->width();
            else if (inactiveTitle < 0) inactiveTitle = title->width();
        }
        QVERIFY(inactiveTitle >= 100);
        QVERIFY2(activeTitle > inactiveTitle,
                 qPrintable(QStringLiteral("active title %1 !> inactive %2")
                                .arg(activeTitle).arg(inactiveTitle)));
    }

    // A pinned tab's title is hidden in the horizontal strip and
    // shown in the vertical list — and the switch itself must apply
    // it. v32 shipped the rule but not the refresh: the window
    // switches modes without a tab sync, so the strip kept the old
    // mode's rendering (the demo's vertical shot showed the lone
    // letter, byte-identical to the version without the rule).
    // Settings Cancel is honest: the live-preview channels (NTP
    // toggles write UiSettings directly; accent signals out) are
    // snapshotted on open and restored on reject.
    // The favicon store: a captured logo persists per host and
    // serves pixmap + file URL; unknown hosts get nothing.
    // The suggestions popup's favicon feature shipped in the
    // user's port with zero coverage (round 16 code review — this
    // suite exists because an untested surface slipped before).
    // All three branches: provider logo wins where stored, glyph
    // fallback where not, and no provider at all.
    void suggestionRowsUseStoredFavicons() {
        QPixmap logo(32, 32);
        logo.fill(QColor(QStringLiteral("#832afb")));
        auto history = [](const QString&) {
            return std::vector<std::pair<QString, QString>>{
                {QStringLiteral("Example Domain"),
                 QStringLiteral("https://example.com/")}};
        };
        auto iconOf = [](QListWidget* list, const QString& kind) {
            for (int i = 0; i < list->count(); ++i)
                if (list->item(i)->data(Qt::UserRole + 1).toString() == kind)
                    return list->item(i)->icon();
            return QIcon();
        };
        {
            AddressBar bar;
            bar.setDemoSuggestions(true);
            bar.setHistoryProvider(history);
            bar.setIconProvider([logo](const QString& host) {
                return (host == QStringLiteral("example.com") ||
                        host == QStringLiteral("search.brave.com"))
                           ? logo
                           : QPixmap();
            });
            bar.setSearchEngineHost(QStringLiteral("search.brave.com"));
            bar.setText(QStringLiteral("ex"));
            auto* list = bar.findChild<QListWidget*>();
            QVERIFY(list != nullptr);
            QVERIFY(list->count() >= 2);
            const QIcon hist = iconOf(list, QStringLiteral("history"));
            QVERIFY(!hist.isNull());
            QCOMPARE(hist.pixmap(QSize(32, 32)).toImage().pixelColor(16, 16),
                     QColor(QStringLiteral("#832afb")));
            const QIcon search = iconOf(list, QStringLiteral("search"));
            QVERIFY(!search.isNull());
            QCOMPARE(search.pixmap(QSize(32, 32)).toImage().pixelColor(16, 16),
                     QColor(QStringLiteral("#832afb")));
        }
        {
            // No provider: rows keep their generic glyphs.
            AddressBar bar;
            bar.setDemoSuggestions(true);
            bar.setHistoryProvider(history);
            bar.setText(QStringLiteral("ex"));
            auto* list = bar.findChild<QListWidget*>();
            QVERIFY(list != nullptr);
            const QIcon hist = iconOf(list, QStringLiteral("history"));
            QVERIFY(!hist.isNull());
            QVERIFY(hist.pixmap(QSize(32, 32)).toImage().pixelColor(16, 16) !=
                    QColor(QStringLiteral("#832afb")));
        }
    }

    void faviconStoreRoundTrip() {
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        FaviconStore store(dir.path());
        QVERIFY(!store.has(QStringLiteral("example.com")));
        QVERIFY(store.fileUrl(QStringLiteral("example.com")).isEmpty());
        QPixmap px(32, 32);
        px.fill(QColor(QStringLiteral("#832afb")));
        QSignalSpy spy(&store, &FaviconStore::faviconReady);
        store.capture(QStringLiteral("example.com"), QIcon(px));
        QVERIFY(store.has(QStringLiteral("example.com")));
        QVERIFY(!store.pixmap(QStringLiteral("example.com"), 32).isNull());
        QVERIFY(store.fileUrl(QStringLiteral("example.com"))
                    .startsWith(QStringLiteral("data:image/png;base64,")));
        QCOMPARE(spy.count(), 1);
        // Same icon again: no rewrite, no second signal.
        store.capture(QStringLiteral("example.com"), QIcon(px));
        QCOMPARE(spy.count(), 1);
        // The ON-DISK bytes decode as the captured image (round 12:
        // pixmap() may be served from the memory cache and fileUrl()
        // checked only for its prefix, so a corrupt write passed).
        const QString file = dir.path() + QStringLiteral("/favicons/example.com.png");
        QVERIFY(QFile::exists(file));
        QFile f(file);
        QVERIFY(f.open(QIODevice::ReadOnly));
        QPixmap fromDisk;
        QVERIFY(fromDisk.loadFromData(f.readAll()));
        QCOMPARE(fromDisk.toImage().pixelColor(0, 0), QColor(QStringLiteral("#832afb")));
        // Owner-only, like the database: the file names in this
        // folder are visited hosts.
        const QFile::Permissions perms = QFile::permissions(file);
        QVERIFY(!(perms & QFile::ReadGroup) && !(perms & QFile::ReadOther) &&
                !(perms & QFile::WriteGroup) && !(perms & QFile::WriteOther));
        // And the directory itself: 0700, asserted since round 13's
        // code critic noticed only the files were checked (exec bits
        // included: no group/other access of any kind).
        const QFile::Permissions dirPerms =
            QFile::permissions(dir.path() + QStringLiteral("/favicons"));
        QVERIFY(!(dirPerms & (QFile::ReadGroup | QFile::WriteGroup | QFile::ExeGroup |
                              QFile::ReadOther | QFile::WriteOther | QFile::ExeOther)));
        // clear() removes the record entirely (the clear-data and
        // clear-on-exit paths land here).
        QSignalSpy clearedSpy(&store, &FaviconStore::cleared);
        store.clear();
        QCOMPARE(clearedSpy.count(), 1);
        QVERIFY(!store.has(QStringLiteral("example.com")));
        QVERIFY(!QFile::exists(file));
        QVERIFY(store.fileUrl(QStringLiteral("example.com")).isEmpty());
    }

    void settingsCancelRestoresLivePreview() {
        // EVERY live channel, not a sample (round 12: the old version
        // exercised 3 of 12, and the two channels added by the very
        // pass that introduced it had none — a dropped line in
        // reject() would have stayed green). For each channel: flip
        // it in the dialog, prove the preference moved, reject, prove
        // it is back. Signal channels additionally prove the restore
        // went out as a signal carrying the original value.
        UiSettings& prefs = uiSettings();
        // Round 13's code critic: this test used to "restore" the
        // downloads folder to its own QTemporaryDir — deleted at
        // scope exit, leaving the suite's shared store pointing at a
        // nonexistent path for every later test. FolderRestore puts
        // back the REAL pre-test value on every exit path.
        FolderRestore folderGuard(prefs);
        QTemporaryDir tempDir;
        QVERIFY(tempDir.isValid());
        const QString folderBefore = tempDir.path();  // deliberately not the default
        prefs.setDownloadsFolder(folderBefore);
        const QString themeBefore = prefs.theme();
        const bool restoreBefore = prefs.restoreSession();
        const bool suggBefore = prefs.suggestions();
        const bool clockBefore = prefs.ntpShowClock();
        const bool tilesBefore = prefs.ntpShowTiles();
        const bool statsBefore = prefs.ntpShowStats();
        const bool askBefore = prefs.askWhereSave();
        const bool darkBefore = prefs.forceDarkPages();
        const QStringList domainsBefore = prefs.userBlockedDomains();
        const QString testDomain = QStringLiteral("cancel-restore.example.com");
        QVERIFY(!domainsBefore.contains(testDomain));
        {
            SettingsDialog dlg(vile::PrivacySettings{}, {},
                               QStringLiteral("101 rules"));
            QSignalSpy themeSpy(&dlg, &SettingsDialog::themeChanged);
            auto box = [&dlg](const QString& text) {
                // Setting titles are labels that toggle their box
                // (the search paints matched letters inside them).
                for (QLabel* l : dlg.findChildren<QLabel*>())
                    if (l->text() == text)
                        return qobject_cast<QCheckBox*>(
                            l->property("toggles").value<QObject*>());
                return static_cast<QCheckBox*>(nullptr);
            };
            // Direct-write channels: flip each checkbox.
            const std::pair<const char*, bool> flips[] = {
                {"Reopen tabs from last time", restoreBefore},
                {"Address-bar suggestions", suggBefore},
                {"Show clock and date", clockBefore},
                {"Show bookmarks", tilesBefore},
                {"Show trackers blocked", statsBefore},
                {"Ask where to save each file", askBefore},
                {"Ask sites for their dark theme", darkBefore},
            };
            for (const auto& [text, before] : flips) {
                QCheckBox* b = box(QString::fromLatin1(text));
                QVERIFY2(b != nullptr, text);
                b->setChecked(!before);
            }
            QCOMPARE(prefs.restoreSession(), !restoreBefore);
            QCOMPARE(prefs.suggestions(), !suggBefore);
            QCOMPARE(prefs.ntpShowClock(), !clockBefore);
            QCOMPARE(prefs.ntpShowTiles(), !tilesBefore);
            QCOMPARE(prefs.ntpShowStats(), !statsBefore);
            QCOMPARE(prefs.askWhereSave(), !askBefore);
            QCOMPARE(prefs.forceDarkPages(), !darkBefore);
            // Signal channel: the theme radios.
            for (QRadioButton* r : dlg.findChildren<QRadioButton*>()) {
                const QString id = r->property("themeId").toString();
                if (!id.isEmpty() && id != themeBefore) {
                    r->setChecked(true);
                    break;
                }
            }
            QVERIFY(themeSpy.count() >= 1);
            // Downloads folder: the dialog's Default button resets it
            // (a real channel write, no file dialog needed).
            for (QPushButton* b : dlg.findChildren<QPushButton*>())
                if (b->text() == QStringLiteral("Default")) b->click();
            QCOMPARE(prefs.downloadsFolder(),
                     QStandardPaths::writableLocation(QStandardPaths::DownloadLocation));
            // Personal blocklist: add an entry through its own row.
            QLineEdit* domainEdit = nullptr;
            for (QLineEdit* e : dlg.findChildren<QLineEdit*>())
                if (e->placeholderText() == QStringLiteral("example.com")) domainEdit = e;
            QVERIFY(domainEdit != nullptr);
            domainEdit->setText(testDomain);
            for (QPushButton* b : dlg.findChildren<QPushButton*>())
                if (b->text() == QStringLiteral("Block site")) b->click();
            QVERIFY(prefs.userBlockedDomains().contains(testDomain));
            // Cancel: everything above must come back.
            dlg.reject();
            QCOMPARE(prefs.theme(), themeBefore);
            QVERIFY(themeSpy.count() >= 2);
            QCOMPARE(themeSpy.last().at(0).toString(), themeBefore);
            QCOMPARE(prefs.restoreSession(), restoreBefore);
            QCOMPARE(prefs.suggestions(), suggBefore);
            QCOMPARE(prefs.ntpShowClock(), clockBefore);
            QCOMPARE(prefs.ntpShowTiles(), tilesBefore);
            QCOMPARE(prefs.ntpShowStats(), statsBefore);
            QCOMPARE(prefs.downloadsFolder(), folderBefore);
            QCOMPARE(prefs.askWhereSave(), askBefore);
            QCOMPARE(prefs.forceDarkPages(), darkBefore);
            QCOMPARE(prefs.userBlockedDomains(), domainsBefore);
        }
        // folderGuard's destructor leaves the store as the test
        // found it — the real folder, not this test's temp dir.
    }

    void verticalPinnedTitleAppliesOnSwitch() {
        QWidget listHost, stackHost;
        ShieldAccess access;
        access.shield.store(std::make_shared<Shield>());
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        QtEngine engine(dir.path(), &access);
        Browser browser(engine);
        const TabId pinnedId = browser.open_tab("https://example.com");
        browser.open_tab("https://duckduckgo.com");
        browser.set_pinned(pinnedId, true);
        TabStripController ctl(browser, engine, &listHost, &stackHost);
        ctl.setVertical(false);
        ctl.list()->setFlow(QListView::LeftToRight);
        ctl.syncNow();
        listHost.resize(760, 60);
        listHost.show();
        QTest::qWait(60);
        auto titleOf = [&] {
            QListWidget* list = ctl.list();
            for (int i = 0; i < list->count(); ++i) {
                QWidget* iw = list->itemWidget(list->item(i));
                if (iw && static_cast<TabId>(list->item(i)->data(Qt::UserRole).toULongLong()) == pinnedId)
                    return iw->findChild<QLabel*>(QStringLiteral("tabTitle"));
            }
            return static_cast<QLabel*>(nullptr);
        };
        QVERIFY(titleOf() != nullptr);
        QVERIFY(!titleOf()->isVisible());  // horizontal: icon only
        // The window's order: switch modes, NO sync afterwards.
        ctl.setVertical(true);
        QTest::qWait(60);
        QVERIFY2(titleOf()->isVisible(),
                 "pinned title stayed hidden after the mode switch");
        QVERIFY(titleOf()->width() > 100);
    }

    void downloadsIndexStability() {
        // Opt-in: on this sandboxed dev host the very first attachment
        // navigation can wedge inside QWebEngineView::load() itself
        // (a Mojo reply from the browser process never arrives), so
        // the test cannot even protect itself with a timeout — it has
        // to not start. CI sets VILE_TEST_DOWNLOADS=1 and runs it in
        // full; locally the xvfb screenshot demo exercises real
        // downloads through the same panel on every run.
        if (!qEnvironmentVariableIsSet("VILE_TEST_DOWNLOADS"))
            QSKIP("set VILE_TEST_DOWNLOADS=1 to run the live-download index test");
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        const QString outDir = dir.path() + QStringLiteral("/out");
        const FolderRestore folderGuard(uiSettings());
        uiSettings().setDownloadsFolder(outDir);

        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QList<QTcpSocket*> sockets;
        connect(&server, &QTcpServer::newConnection, &server, [&] {
            QTcpSocket* s = server.nextPendingConnection();
            sockets.append(s);
            connect(s, &QTcpSocket::readyRead, s, [s] {
                s->readAll();
                const QByteArray body(2048, 'x');
                s->write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                         "Content-Disposition: attachment\r\nContent-Length: " +
                         QByteArray::number(body.size()) + "\r\n\r\n" + body);
                connect(s, &QTcpSocket::bytesWritten, s,
                        [s](qint64 n) { if (n > 0) s->disconnectFromHost(); });
            });
        });

        DownloadsPanel panel;
        // Unnamed profile with storage and cache inside the test's
        // temp dir: a named profile's store is shared across runs.
        QWebEngineProfile profile;
        profile.setPersistentStoragePath(dir.path() + QStringLiteral("/storage"));
        profile.setCachePath(dir.path() + QStringLiteral("/cache"));
        QWebEnginePage page(&profile);
        QWebEngineView view;
        view.setPage(&page);
        view.resize(800, 600);
        view.show();  // the product's views are always shown
        connect(&profile, &QWebEngineProfile::downloadRequested, &panel,
                [&panel](QWebEngineDownloadRequest* dl) { panel.addDownload(dl); });

        // Bounded waits with an explicit event pump. QTRY timeouts
        // never fired when this environment wedged the first download:
        // on this sandboxed host, loopback downloads through a test
        // harness's WebEngine processes can stall indefinitely (the
        // full application under xvfb downloads fine, and CI runners
        // run this test to completion). The waits are bounded so a
        // stall FAILS the opted-in run instead of hanging the suite.
        auto waitFor = [](const std::function<bool()>& pred, int ms) {
            QElapsedTimer t;
            t.start();
            while (!pred() && t.elapsed() < ms) {
                QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
                QTest::qWait(10);
            }
            return pred();
        };
        const int kDownloads = 10;
        const QUrl first = QUrl(QStringLiteral("http://127.0.0.1:%1/f0.bin")
                                    .arg(server.serverPort()));
        view.load(first);
        if (!waitFor([&] { return panel.count() == 1; }, 10000))
            QFAIL("first download never reached the panel — "
                  "VILE_TEST_DOWNLOADS is set, so this environment "
                  "declared it can run downloads; a stall is a failure, "
                  "not a skip");
        for (int i = 1; i < kDownloads; ++i) {
            view.load(QUrl(QStringLiteral("http://127.0.0.1:%1/f%2.bin")
                                   .arg(server.serverPort())
                                   .arg(i)));
            QVERIFY2(waitFor([&] { return panel.count() == i + 1; }, 10000),
                     qPrintable(QStringLiteral("download %1 never reached the panel").arg(i)));
        }
        // The realloc-growth pattern that used to corrupt the index:
        // ten adds, every request still mapped, clear removes all.
        QVERIFY2(waitFor([&] { return panel.finishedCount() == kDownloads; }, 20000),
                 "downloads did not all finish");
        panel.clearFinished();
        QCOMPARE(panel.count(), 0);
        qDeleteAll(sockets);  // folder restored by folderGuard
    }

    // The regression rounds 5-6 actually burned on: [active,
    // finished, active] and "Clear finished" in between. The two slow
    // downloads stay in flight (the server holds their responses)
    // while the finished one between them is cleared; afterwards the
    // survivors must still resolve through the panel's index and
    // finish normally. Same opt-in gate as downloadsIndexStability.
    void downloadsInterleavedClear() {
        if (qEnvironmentVariableIsEmpty("VILE_TEST_DOWNLOADS"))
            QSKIP("set VILE_TEST_DOWNLOADS=1 to run the loopback-download test");

        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        const quint16 port = server.serverPort();
        const QByteArray body(2048, 'z');
        auto head = [body](QTcpSocket* sock, int bytesNow) {
            // Headers plus a first slice of the body: Chromium turns a
            // response into a download when the HEADERS land, so a
            // "slow" download is one whose body stalls, not one whose
            // headers never arrive.
            QByteArray resp = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                              "Content-Disposition: attachment\r\nContent-Length: "
                            + QByteArray::number(body.size()) + "\r\n\r\n"
                            + body.left(bytesNow);
            sock->write(resp);
        };
        auto respond = [body, head](QTcpSocket* sock) {
            head(sock, body.size());
            sock->disconnectFromHost();
        };
        // Slow bodies stall after 512 bytes until the test releases
        // them — the [active, finished, active] arrangement must be
        // exact, not whatever a timer race produces.
        QList<QTcpSocket*> held;
        bool release = false;
        connect(&server, &QTcpServer::newConnection, &server, [&] {
            while (QTcpSocket* sock = server.nextPendingConnection()) {
                connect(sock, &QTcpSocket::readyRead, sock, [sock, &held, respond, head] {
                    const QByteArray req = sock->readAll();
                    if (req.contains("slow")) {
                        head(sock, 512);
                        held.append(sock);
                    } else {
                        respond(sock);
                    }
                });
            }
        });
        QTimer releaser;
        releaser.setInterval(100);
        connect(&releaser, &QTimer::timeout, &releaser, [&] {
            if (!release) return;
            for (QTcpSocket* sock : held) {
                sock->write(body.mid(512));
                sock->disconnectFromHost();
            }
            held.clear();
        });
        releaser.start();

        QTemporaryDir profileDir;
        QVERIFY(profileDir.isValid());
        // Unnamed profile, like the sibling test: a named profile's
        // store is shared across runs.
        auto* profile = new QWebEngineProfile(static_cast<QObject*>(nullptr));
        profile->setPersistentStoragePath(profileDir.path());
        QTemporaryDir dlDir;
        QVERIFY(dlDir.isValid());
        UiSettings settings;
        const FolderRestore folderGuard(settings);
        settings.setDownloadsFolder(dlDir.path());
        DownloadsPanel panel;
        connect(profile, &QWebEngineProfile::downloadRequested, &panel,
                [&panel](QWebEngineDownloadRequest* dl) { panel.addDownload(dl); });
        QWebEnginePage page(profile);
        QWebEngineView view;
        view.setPage(&page);
        view.resize(800, 600);
        view.show();  // the product's views are always shown

        // Sequential loads, waiting for each download to register: a
        // navigation replaced before it commits starts no download.
        const QString base = QStringLiteral("http://127.0.0.1:%1/").arg(port);
        view.load(QUrl(base + "slow-a.bin"));
        QTRY_VERIFY_WITH_TIMEOUT(panel.count() == 1, 30000);
        view.load(QUrl(base + "fast-b.bin"));
        QTRY_VERIFY_WITH_TIMEOUT(panel.count() == 2, 30000);
        QTRY_VERIFY_WITH_TIMEOUT(panel.finishedCount() == 1, 30000);
        view.load(QUrl(base + "slow-c.bin"));
        QTRY_VERIFY_WITH_TIMEOUT(panel.count() == 3, 30000);
        QCOMPARE(panel.finishedCount(), 1);  // only the middle one
        panel.clearFinished();
        QCOMPARE(panel.count(), 2);
        QCOMPARE(panel.finishedCount(), 0);
        // Row IDENTITY through the index, not just container counts:
        // pausing survivor A by its id must pause A and only A. (The
        // round-6 bug repainted/refreshed the wrong row while counts
        // stayed perfect; count-only assertions cannot see that.)
        const QList<quint64> ids = panel.downloadIds();
        QCOMPARE(ids.size(), 2);
        QVERIFY(panel.pauseDownload(ids.at(0)));
        QVERIFY(panel.downloadPaused(ids.at(0)));
        QVERIFY(!panel.downloadPaused(ids.at(1)));
        QVERIFY(panel.resumeDownload(ids.at(0)));
        // The survivors' signals still resolve their rows after the
        // erase between them: both finish once the server releases.
        release = true;
        QTRY_VERIFY_WITH_TIMEOUT(panel.finishedCount() == 2, 30000);
        panel.clearFinished();
        QCOMPARE(panel.count(), 0);
        delete profile;  // folder restored by folderGuard
    }

    // The ask-where-save flow: the save dialog is answered by a
    // polling accepter (the demo's trick), and the download must
    // land and finish. This path once silently lost every download:
    // a deferred dialog never happened because Qt destroys an
    // unanswered download request when its signal unwinds.
    void askWhereSaveFlow() {
        if (qEnvironmentVariableIsEmpty("VILE_TEST_DOWNLOADS"))
            QSKIP("opt-in");
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        connect(&server, &QTcpServer::newConnection, &server, [&] {
            while (QTcpSocket* sock = server.nextPendingConnection()) {
                connect(sock, &QTcpSocket::readyRead, sock, [sock] {
                    sock->readAll();
                    const QByteArray body(2048, 'q');
                    sock->write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                                "Content-Disposition: attachment\r\nContent-Length: "
                                + QByteArray::number(body.size()) + "\r\n\r\n" + body);
                    sock->disconnectFromHost();
                });
            }
        });
        QTemporaryDir profileDir;
        QVERIFY(profileDir.isValid());
        QWebEngineProfile profile;
        profile.setPersistentStoragePath(profileDir.path());
        QTemporaryDir dlDir;
        QVERIFY(dlDir.isValid());
        UiSettings settings;
        const FolderRestore folderGuard(settings);
        const bool oldAsk = settings.askWhereSave();
        settings.setDownloadsFolder(dlDir.path());
        settings.setAskWhereSave(true);
        DownloadsPanel panel;
        panel.show();
        connect(&profile, &QWebEngineProfile::downloadRequested, &panel,
                [&panel](QWebEngineDownloadRequest* dl) { panel.addDownload(dl); });
        QWebEnginePage page(&profile);
        QWebEngineView view;
        view.setPage(&page);
        view.resize(800, 600);
        view.show();
        // Dialog accepter: polls for the modal and clicks Save.
        QTimer accepter;
        connect(&accepter, &QTimer::timeout, &accepter, [&] {
            if (QWidget* modal = QApplication::activeModalWidget()) {
                for (auto* b : modal->findChildren<QPushButton*>())
                    if (b->text().remove('&') == QStringLiteral("Save")) { b->click(); break; }
            }
        });
        accepter.start(200);
        view.load(QUrl(QStringLiteral("http://127.0.0.1:%1/ask.bin").arg(server.serverPort())));
        QTRY_VERIFY_WITH_TIMEOUT(panel.count() == 1, 20000);
        QTRY_VERIFY_WITH_TIMEOUT(panel.finishedCount() == 1, 20000);
        settings.setAskWhereSave(oldAsk);  // folder via folderGuard
    }

    void clearDataDialogDefaults() {
        ClearDataDialog dlg;
        QVERIFY(dlg.clearHistory());
        QVERIFY(dlg.clearSiteData());
        QCOMPARE(dlg.historyRangeHours(), 0);  // all time
        QCheckBox* history = nullptr;
        for (QCheckBox* b : dlg.findChildren<QCheckBox*>())
            if (b->text() == QStringLiteral("Browsing history")) history = b;
        QVERIFY(history != nullptr);
        auto* range = dlg.findChild<QComboBox*>();
        QVERIFY(range != nullptr);
        QVERIFY(range->isEnabled());
        history->setChecked(false);
        QVERIFY(!dlg.clearHistory());
        QVERIFY(!range->isEnabled());
    }

    // Session persistence is history by another name: with history off
    // (private browsing), saveSession must write nothing — and with it
    // on, it must write the open tabs. Both directions, against a real
    // on-disk database.
    void sessionGating() {
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        {
            Database db((dir.path() + "/off.db").toStdString());
            PrivacySettings settings;
            settings.save_history = false;
            MainWindow window(db, settings, {}, dir.path());
            window.saveSession();
            SettingsStore store(db);
            QVERIFY(store.get_or("session/tabs", "").empty());
        }
        {
            Database db((dir.path() + "/on.db").toStdString());
            PrivacySettings settings;
            settings.save_history = true;
            MainWindow window(db, settings, {}, dir.path());
            SettingsStore store(db);
            // The window's first tab starts out loading-from-blank, and
            // saveSession deliberately defers while any tab is in that
            // state (a half-restored session must not overwrite the
            // saved one). Pump events until the load lands, then the
            // save must go through.
            bool saved = false;
            for (int i = 0; i < 50 && !saved; ++i) {
                QTest::qWait(100);
                window.saveSession();
                saved = !store.get_or("session/tabs", "").empty();
            }
            QVERIFY(saved);
            // The zero-tab guarantee: a fresh window always has a tab.
            auto* tabs = window.findChild<QListWidget*>(QStringLiteral("tabList"));
            QVERIFY(tabs != nullptr);
            QVERIFY(tabs->count() >= 1);
        }
    }

    // The settings service: setters round-trip through the one store,
    // the change signal names the key, and a zoom factor of exactly 1.0
    // removes the override (the getter falls back to the default).
    void uiSettingsRoundTrip() {
        UiSettings& s = uiSettings();
        QVERIFY(!s.downloadsFolder().isEmpty());  // default is never empty
        const bool wasVertical = s.verticalTabs();
        QSignalSpy spy(&s, &UiSettings::changed);
        s.setVerticalTabs(!wasVertical);
        QCOMPARE(s.verticalTabs(), !wasVertical);
        QCOMPARE(spy.count(), 1);
        QCOMPARE(spy.at(0).at(0).toString(), QStringLiteral("ui/verticalTabs"));
        s.setVerticalTabs(wasVertical);  // restore
        QCOMPARE(s.zoomForHost(QStringLiteral("example.com")), 1.0);
        s.setZoomForHost(QStringLiteral("example.com"), 1.5);
        QCOMPARE(s.zoomForHost(QStringLiteral("example.com")), 1.5);
        s.setZoomForHost(QStringLiteral("example.com"), 1.0);
        QCOMPARE(s.zoomForHost(QStringLiteral("example.com")), 1.0);
    }

    // SessionStore at unit level: it persists the browser's tabs when
    // history is on, and a save with history off CLEARS what was stored
    // (session data is history) instead of just declining to write —
    // asserted against the raw store below, before any read path gets
    // a chance to blank the keys itself.
    void sessionStoreGating() {
        ShieldAccess access;
        access.shield.store(std::make_shared<Shield>());
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        Database db((dir.path() + "/s.db").toStdString());
        SettingsStore settings(db);
        QtEngine engine(dir.path(), &access);
        Browser browser(engine);
        browser.open_tab("https://example.com");
        browser.open_tab("https://duckduckgo.com");
        SessionStore store(settings, browser);
        store.save(true);
        int active = -1;
        const auto tabs = store.savedTabs(true, true, &active);
        QCOMPARE(tabs.size(), static_cast<size_t>(2));
        store.save(false);
        QVERIFY(settings.get_or("session/tabs", "").empty());
        QVERIFY(store.savedTabs(false, true, &active).empty());
    }

    // Tab sync coalescing: a burst of change notifications (one page
    // load fires several) collapses into a single actual sync.
    // The Settings dialog fits its height to the current page: a
    // short page (Appearance) must produce a shorter dialog than a
    // tall one (Privacy). Regression test for the stacked failures
    // that once made the fit dead code: it bailed out on scroll-area
    // pages (i.e. all of them), the stack's minimum was the tallest
    // page's natural height, and the dialog's own explicit 540px
    // minimum vetoed whatever shrink survived the first two.
    void settingsDialogFitsPages() {
        SettingsDialog dlg(vile::PrivacySettings{}, {},
                           QStringLiteral("bundled curated list (101 rules)"));
        dlg.show();
        QTest::qWait(60);  // showEvent's fit runs on a singleShot(0)
        const int appearanceH = dlg.height();
        QVERIFY2(appearanceH <= 460,
                 qPrintable(QStringLiteral("Appearance page did not shrink the dialog: %1")
                                .arg(appearanceH)));
        auto* nav = dlg.findChild<QListWidget*>();
        QVERIFY(nav != nullptr);
        nav->setCurrentRow(1);  // Privacy & Shield — the tallest page
        QTest::qWait(60);
        const int privacyH = dlg.height();
        QVERIFY2(privacyH > appearanceH + 100,
                 qPrintable(QStringLiteral("Privacy %1 should tower over Appearance %2")
                                .arg(privacyH)
                                .arg(appearanceH)));
        QVERIFY(privacyH <= 780);
        nav->setCurrentRow(4);  // Downloads — short again
        QTest::qWait(60);
        QVERIFY2(dlg.height() <= 460,
                 qPrintable(QStringLiteral("Downloads page did not shrink the dialog: %1")
                                .arg(dlg.height())));
    }

    void tabSyncCoalescing() {
        ShieldAccess access;
        access.shield.store(std::make_shared<Shield>());
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        // Hosts declared first so they die last: the engine and browser
        // must tear down (destroy_view, deferred-delete flush) while
        // the views still live inside the stack host's pages — the same
        // order MainWindow's member layout produces.
        QWidget listHost, stackHost;
        QtEngine engine(dir.path(), &access);
        Browser browser(engine);
        browser.open_tab("about:blank");  // syncNow's zero-tab path returns early by design
        TabStripController ctl(browser, engine, &listHost, &stackHost);
        QSignalSpy spy(&ctl, &TabStripController::synced);
        ctl.requestSync();
        ctl.requestSync();
        ctl.requestSync();
        QTest::qWait(50);
        QCOMPARE(spy.count(), 1);
    }

    // A pinned tab in the vertical sidebar is a full-width row, and
    // its site icon must sit at the same left inset as every other
    // row's — a centred glyph in an empty row was the design review's
    // last sidebar nit.
    void pinnedTabIconAlignsLeft() {
        QWidget listHost, stackHost;  // declared first: they die last
        ShieldAccess access;
        access.shield.store(std::make_shared<Shield>());
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        QtEngine engine(dir.path(), &access);
        Browser browser(engine);
        browser.open_tab("https://example.com");
        browser.open_tab("https://duckduckgo.com");
        browser.open_tab("https://wikipedia.org");
        const TabId pinnedId = browser.tabs().front().id;
        browser.set_pinned(pinnedId, true);
        TabStripController ctl(browser, engine, &listHost, &stackHost);
        ctl.setVertical(true);
        ctl.syncNow();
        listHost.resize(220, 400);
        listHost.show();
        QTest::qWait(60);
        QListWidget* list = ctl.list();
        QVERIFY(list != nullptr);
        QListWidgetItem* pinnedItem = nullptr;
        for (int i = 0; i < list->count(); ++i) {
            auto* it = list->item(i);
            if (static_cast<TabId>(it->data(Qt::UserRole).toULongLong()) == pinnedId)
                pinnedItem = it;
        }
        QVERIFY(pinnedItem != nullptr);
        QWidget* w = list->itemWidget(pinnedItem);
        QVERIFY(w != nullptr);
        auto* icon = w->findChild<QLabel*>(QStringLiteral("tabIcon"));
        QVERIFY(icon != nullptr);
        QVERIFY2(icon->x() <= 12,
                 qPrintable(QStringLiteral("pinned icon x=%1 (widget width %2)")
                                .arg(icon->x())
                                .arg(w->width())));
    }

    // Regression: a pinned tab in HORIZONTAL mode must collapse to
    // icon width, not occupy a full tab slot (uniform item sizes
    // silently overrode the per-item sizeHint for rounds).
    void pinnedTabHorizontalCollapses() {
        QWidget listHost, stackHost;
        ShieldAccess access;
        access.shield.store(std::make_shared<Shield>());
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        QtEngine engine(dir.path(), &access);
        Browser browser(engine);
        browser.open_tab("https://example.com");
        browser.open_tab("https://duckduckgo.com");
        browser.open_tab("https://wikipedia.org");
        const TabId pinnedId = browser.tabs().front().id;
        browser.set_pinned(pinnedId, true);
        TabStripController ctl(browser, engine, &listHost, &stackHost);
        ctl.setVertical(false);
        // The window's applyTabLayout owns the flow direction.
        ctl.list()->setFlow(QListView::LeftToRight);
        ctl.list()->setWrapping(false);
        ctl.syncNow();
        listHost.resize(700, 60);
        listHost.show();
        QTest::qWait(60);
        QListWidget* list = ctl.list();
        QVERIFY(list != nullptr);
        for (int i = 0; i < list->count(); ++i) {
            auto* it = list->item(i);
            qInfo() << "item" << i << "sizeHint" << it->sizeHint()
                    << "rect" << list->visualItemRect(it);
        }
        QListWidgetItem* pinnedItem = nullptr;
        for (int i = 0; i < list->count(); ++i) {
            auto* it = list->item(i);
            if (static_cast<TabId>(it->data(Qt::UserRole).toULongLong()) == pinnedId)
                pinnedItem = it;
        }
        QVERIFY(pinnedItem != nullptr);
        QVERIFY2(list->visualItemRect(pinnedItem).width() <= 60,
                 qPrintable(QStringLiteral("pinned horizontal width %1")
                                .arg(list->visualItemRect(pinnedItem).width())));
        // The active tab (third, opened last) must not give its title
        // LESS room than an inactive neighbour: its close button and
        // active dot are paid for with extra item width.
        auto titleWidth = [&list](int row) {
            QWidget* w = list->itemWidget(list->item(row));
            auto* title = w ? w->findChild<QLabel*>(QStringLiteral("tabTitle")) : nullptr;
            return title ? title->width() : -1;
        };
        QVERIFY2(titleWidth(2) >= titleWidth(1) - 2,
                 qPrintable(QStringLiteral("active title %1 vs inactive %2")
                                .arg(titleWidth(2)).arg(titleWidth(1))));
    }

    // The assistant's run state machine, part 1: if the page-text
    // fetch never calls back (the tab died first), the watchdog must
    // recover the panel — message shown, controls back.
    void assistantWatchdogRecoversWhenFetchNeverLands() {
        AssistantPanel panel;
        vile::PrivacySettings s;
        s.ai_enabled = true;
        s.ai_provider = "ollama";
        s.ai_model = "stub";
        panel.setSettings(s);
        AssistantPanel::PageAccess access;
        access.currentPage = [](QString& u, QString& title) {
            u = QStringLiteral("https://example.com");
            title = QStringLiteral("Example");
            return true;
        };
        access.fetchText = [](std::function<void(const QString&)>) {
            // Never calls back: the dropped-callback case.
        };
        panel.setPageAccess(access);
        panel.setFetchWatchdogMs(300);
        panel.resize(420, 520);
        panel.show();
        QPushButton* explain = nullptr;
        for (auto* b : panel.findChildren<QPushButton*>())
            if (b->text() == QStringLiteral("Explain this page")) explain = b;
        QVERIFY(explain != nullptr);
        QVERIFY(explain->isEnabled());
        explain->click();
        QVERIFY(!explain->isEnabled());  // the run is in flight
        auto* result = panel.findChild<QTextEdit*>();
        QVERIFY(result != nullptr);
        QVERIFY2(waitForPred([&] {
                     return result->toPlainText().contains(
                         QStringLiteral("Couldn't read the page"));
                 }, 4000),
                 "watchdog never recovered the panel");
        QVERIFY(explain->isEnabled());  // controls restored
    }

    // Part 2: the fetch lands promptly but the MODEL is slow (a stub
    // Ollama on its real port, answering after ~1.2 s, with the
    // watchdog shortened to 400 ms). At the 700 ms checkpoint —
    // past the watchdog point, before the answer — the panel must
    // still be mid-run: pass 8's compare-only token let the
    // watchdog fire on exactly this healthy path and flash a false
    // error over the pending answer.
    void assistantWatchdogStaysQuietDuringSlowModel() {
        QTcpServer stub;
        if (!stub.listen(QHostAddress::LocalHost, 11434))
            QSKIP("port 11434 is taken; cannot stub Ollama");
        QObject::connect(&stub, &QTcpServer::newConnection, &stub, [&stub] {
            QTcpSocket* sock = stub.nextPendingConnection();
            QObject::connect(sock, &QTcpSocket::readyRead, sock, [sock] {
                sock->readAll();
                QTimer::singleShot(1200, sock, [sock] {
                    const QByteArray body =
                        "{\"message\":{\"content\":\"stub answer\"},\"done\":true}";
                    QByteArray resp = "HTTP/1.1 200 OK\r\nContent-Type: "
                                      "application/json\r\nContent-Length: " +
                                      QByteArray::number(body.size()) +
                                      "\r\n\r\n" + body;
                    sock->write(resp);
                    sock->disconnectFromHost();
                });
            });
        });

        AssistantPanel panel;
        vile::PrivacySettings s;
        s.ai_enabled = true;
        s.ai_provider = "ollama";
        s.ai_model = "stub";
        panel.setSettings(s);
        AssistantPanel::PageAccess access;
        access.currentPage = [](QString& u, QString& title) {
            u = QStringLiteral("https://example.com");
            title = QStringLiteral("Example");
            return true;
        };
        access.fetchText = [](std::function<void(const QString&)> cb) {
            QTimer::singleShot(100, [cb] { cb(QStringLiteral("some page text")); });
        };
        panel.setPageAccess(access);
        panel.setFetchWatchdogMs(400);
        panel.resize(420, 520);
        panel.show();
        QPushButton* explain = nullptr;
        for (auto* b : panel.findChildren<QPushButton*>())
            if (b->text() == QStringLiteral("Explain this page")) explain = b;
        QVERIFY(explain != nullptr);
        explain->click();
        auto* result = panel.findChild<QTextEdit*>();
        QVERIFY(result != nullptr);
        // Past the (shortened) 400 ms watchdog, before the ~1.2 s
        // answer: still asking, controls still disabled, no false
        // error. Checked CONTINUOUSLY across the window rather than
        // at one instant (round 12: a single qWait+assert samples one
        // moment and calls it structural; this samples every 50 ms,
        // so a recovery that fires anywhere in the window fails).
        for (int waited = 0; waited < 700; waited += 50) {
            QTest::qWait(50);
            QVERIFY2(result->toPlainText().contains(QStringLiteral("Asking the on-device model")),
                     qPrintable(result->toPlainText()));
            QVERIFY(!explain->isEnabled());
        }
        // Then the answer lands and replaces the waiting text.
        QVERIFY2(waitForPred([&] {
                     return result->toPlainText().contains(QStringLiteral("stub answer"));
                 }, 5000),
                 "the slow answer never arrived");
        QVERIFY(explain->isEnabled());
    }

    // Runs last (slots execute in declaration order): no test in this
    // suite may have leaked a page past its profile's release.
    void noProfileReleaseWarnings() {
        QCOMPARE(g_profileReleaseWarnings.load(), 0);
    }
};

int main(int argc, char* argv[]) {
    // Headless WebEngine: no sandbox (tests may run as root in a
    // container), no GPU. Set before the QApplication exists.
    if (qEnvironmentVariableIsEmpty("QTWEBENGINE_CHROMIUM_FLAGS"))
        qputenv("QTWEBENGINE_CHROMIUM_FLAGS",
                "--no-sandbox --disable-dev-shm-usage --disable-gpu");
    // The whole suite's QSettings live in a throwaway directory:
    // several tests exercise UiSettings, and none of them may read or
    // mutate the developer's real VILE configuration. (Set before any
    // QSettings object exists in this process.)
    static QTemporaryDir settingsDir;
    if (settingsDir.isValid())
        QSettings::setPath(QSettings::NativeFormat, QSettings::UserScope,
                           settingsDir.path());
    QApplication app(argc, argv);
    g_previousHandler = qInstallMessageHandler(countingMessageHandler);
    UiTests tests;
    return QTest::qExec(&tests, argc, argv);
}

#include "test_ui.moc"
