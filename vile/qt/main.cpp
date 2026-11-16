// VILE Qt UI entry point.
//
// Start-up order (INTEGRATION.md §2):
//   Database -> detect local AI -> onboarding (if needed) -> PrivacySettings
//   -> Shield (+ blocklist) -> Browser(QtEngine, history) -> MainWindow.
//
// (The scripted screenshot demo — --demo-shots and friends — exists only
// in the vile-demo target; see qt/demo/demo_harness.cpp. This binary has
// no demo mode.)
#include <QApplication>
#include <QCommandLineParser>
#include <QIcon>
#include <QDebug>
#include <QDir>
#include <QPushButton>
#include <QKeyEvent>
#include <QListWidget>
#include <QScreen>
#include <QScrollArea>
#include <QScrollBar>
#include <QStackedWidget>
#include "uisettings.h"
#include <QTabWidget>
#include <QToolButton>
#include <QFutureWatcher>
#include <QMessageBox>
#include <QtConcurrent>
#include <QStandardPaths>
#include <QTimer>

#include <memory>
#include <unistd.h>

#include "mainwindow.h"
#ifdef VILE_DEMO
#include "demo/demo_harness.h"
#endif
#include "onboardingdialog.h"
#include "settingsdialog.h"
#include "theme.h"
#include "vile/http.hpp"
#include "vile/local_ai.hpp"
#include "vile/onboarding.hpp"
#include "vile/privacy.hpp"
#include "vile/storage.hpp"

using namespace vile;

int main(int argc, char* argv[]) {
    // Chromium refuses to start as root without --no-sandbox, so scope
    // that exception to root (dev containers): a normal user launch keeps
    // the sandbox — this is a privacy browser, and the sandbox is part of
    // the product. An operator-provided QTWEBENGINE_CHROMIUM_FLAGS always
    // wins (e.g. --ignore-certificate-errors for a screenshot run behind a
    // MITM egress proxy — never a default).
    if (!qEnvironmentVariableIsSet("QTWEBENGINE_CHROMIUM_FLAGS") && ::geteuid() == 0)
        qputenv("QTWEBENGINE_CHROMIUM_FLAGS",
                "--no-sandbox --disable-dev-shm-usage --disable-gpu");
    // Dark-leaning web content (Settings -> Appearance, on by
    // default): --force-dark-mode makes prefers-color-scheme: dark
    // true for every page (probe-verified against a local test
    // page), so sites WITH a native dark theme use it, and
    // Chromium's own surfaces (scrollbars, form controls) go dark.
    // What it does NOT do in Qt 6.4's WebEngine (Chromium 102):
    // auto-darken light pages. That path was tried exhaustively —
    // --enable-features=WebContentsForceDark, --enable-force-dark,
    // both combined — and page content stayed white in every probe
    // run, so no flag is shipped on a promise it can't keep, and
    // VILE doesn't repaint pages with filter tricks either (they
    // break pages and are trivially fingerprintable). The setting's
    // label in Settings says exactly this. Appended to whatever
    // flags are already set, never replacing them.
    if (uiSettings().forceDarkPages()) {
        QByteArray flags = qgetenv("QTWEBENGINE_CHROMIUM_FLAGS");
        if (!flags.contains("--force-dark-mode")) {
            if (!flags.isEmpty()) flags += ' ';
            flags += "--force-dark-mode";
        }
        qputenv("QTWEBENGINE_CHROMIUM_FLAGS", flags);
    }
    QApplication app(argc, argv);
    app.setWindowIcon(QIcon(QStringLiteral(":/assets/logo.png")));
    app.setOrganizationName(QStringLiteral("VILE"));
    app.setApplicationName(QStringLiteral("VILE"));
    app.setApplicationVersion(QStringLiteral(VILE_APP_VERSION));
    // VELTRIX PATCH: announce the Wayland app-id "vile" so the desktop
    // matches the window to vile.desktop (dock, app grid, overview).
    // Upstream sets no desktop file name, so Qt would announce "VILE".
    app.setDesktopFileName(QStringLiteral("vile"));
    // One visual system (qt/theme.h): the accent is the user's choice, the
    // rest of the palette is fixed.
    app.setStyleSheet(appStyleSheet(accentById(uiSettings().accent()), activePalette()));

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("VILE — a private browser"));
    parser.addHelpOption();
#ifdef VILE_DEMO
    // Demo options exist only in the vile-demo target. The production
    // binary has no screenshot mode and no synthetic-input surface.
    QCommandLineOption demoOpt(QStringLiteral("demo-shots"),
                               QStringLiteral("Scripted demo: save UI screenshots to DIR, then quit."),
                               QStringLiteral("DIR"));
    parser.addOption(demoOpt);
    QCommandLineOption keepDataOpt(
        QStringLiteral("demo-keep-data"),
        QStringLiteral("Demo: keep the demo profile instead of wiping it (for the restore test)."));
    parser.addOption(keepDataOpt);
    QCommandLineOption restoreOpt(
        QStringLiteral("demo-restore"),
        QStringLiteral("Restore test: open the window with the saved session, save one screenshot to DIR, then quit."),
        QStringLiteral("DIR"));
    parser.addOption(restoreOpt);
#endif
    parser.process(app);
#ifdef VILE_DEMO
    const bool demo = parser.isSet(demoOpt);
    const QString shotDir = parser.value(demoOpt);
    const bool restoreDemo = parser.isSet(restoreOpt);
    const QString restoreShotDir = parser.value(restoreOpt);
#else
    [[maybe_unused]] const bool demo = false;
    [[maybe_unused]] const QString shotDir;
    [[maybe_unused]] const bool restoreDemo = false;
    [[maybe_unused]] const QString restoreShotDir;
#endif

    QString dataDir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
#ifdef VILE_DEMO
    if (demo || restoreDemo) {
        // Demo profile, so onboarding always shows on a fresh run.
        dataDir = QDir::tempPath() + QStringLiteral("/vile-demo-data");
        if (demo && !parser.isSet(keepDataOpt)) QDir(dataDir).removeRecursively();
        if (demo) QDir().mkpath(shotDir);
        if (restoreDemo) QDir().mkpath(restoreShotDir);
    }
#endif
    QDir().mkpath(dataDir);

    // Open the database behind an error boundary: a corrupt file (or one
    // written by a newer VILE) must not abort the browser with no way
    // back — offer to move it aside and start fresh instead.
    const QString dbPath = dataDir + QStringLiteral("/vile.db");
    std::unique_ptr<Database> dbPtr;
    try {
        dbPtr = std::make_unique<Database>(dbPath.toStdString());
    } catch (const std::exception& e) {
        QMessageBox box;
        box.setIcon(QMessageBox::Critical);
        box.setWindowTitle(QStringLiteral("VILE"));
        box.setText(QStringLiteral("VILE couldn't open its database."));
        box.setInformativeText(
            QString::fromUtf8(e.what()) +
            QStringLiteral("\n\nMove the damaged file aside (kept as vile.db.broken) "
                           "and start with a fresh database? Your browser settings, "
                           "history and bookmarks in the old file will not be carried over."));
        auto* fresh = box.addButton(QStringLiteral("Move aside & start fresh"),
                                    QMessageBox::AcceptRole);
        box.addButton(QStringLiteral("Quit"), QMessageBox::RejectRole);
        box.exec();
        if (box.clickedButton() != fresh) return 1;
        const QString broken = dbPath + QStringLiteral(".broken");
        QFile::remove(broken);
        QFile::rename(dbPath, broken);
        QFile::remove(broken + QStringLiteral("-wal"));
        QFile::rename(dbPath + QStringLiteral("-wal"), broken + QStringLiteral("-wal"));
        QFile::remove(broken + QStringLiteral("-shm"));
        QFile::rename(dbPath + QStringLiteral("-shm"), broken + QStringLiteral("-shm"));
        try {
            dbPtr = std::make_unique<Database>(dbPath.toStdString());
        } catch (const std::exception& e2) {
            QMessageBox::critical(nullptr, QStringLiteral("VILE"),
                                  QStringLiteral("Still couldn't create a database: ") +
                                      QString::fromUtf8(e2.what()));
            return 1;
        }
    }
    Database& db = *dbPtr;
    SettingsStore store(db);

    // Detect local AI once, before any questions are shown (INTEGRATION.md §4).
    // Local-AI detection probes three loopback endpoints with real
    // timeouts. When onboarding still has to run, its questions depend on
    // the answer, so probe synchronously here. Otherwise the probe moves
    // off the startup path (below) — a local server that accepts and
    // hangs must not delay the first window.
    LoopbackHttp http;
    std::vector<LocalAiProvider> detected;
    const bool onboardingDone = Onboarding::is_complete(store);
    if (!onboardingDone) detected = detect_local_ai(http);

    PrivacySettings settings;
    if (!Onboarding::is_complete(store)) {
        OnboardingDialog dlg(db, detected);
#ifdef VILE_DEMO
        if (demo) vile_demo::prepareOnboarding(dlg, shotDir);
#endif
        if (dlg.exec() != QDialog::Accepted) return 1;
        settings = dlg.appliedSettings();
    } else {
        settings = PrivacySettings::load(store);
    }

    MainWindow window(db, settings, detected, dataDir);
    if (onboardingDone) {
        // Async local-AI probe (see above): results land in the window
        // when they land; the Assistant panel updates itself.
        auto* aiWatcher = new QFutureWatcher<std::vector<LocalAiProvider>>(&window);
        QObject::connect(aiWatcher,
                         &QFutureWatcher<std::vector<LocalAiProvider>>::finished, &window,
                         [aiWatcher, &window] {
                             window.setLocalAiProviders(aiWatcher->result());
                         });
        aiWatcher->setFuture(QtConcurrent::run([] {
            LoopbackHttp probe;
            return detect_local_ai(probe);
        }));
    }
    window.show();

    if (!demo) return app.exec();

#ifdef VILE_DEMO
    if (restoreDemo) return vile_demo::runRestoreShot(app, window, restoreShotDir);
    if (demo) return vile_demo::runDemoShots(app, window, shotDir);
#endif
    return app.exec();
}
