#pragma once
// Entry points for the scripted screenshot demo. Implemented in
// demo_harness.cpp and linked ONLY into the vile-demo target; main.cpp
// references them under #ifdef VILE_DEMO.
#include <QString>

class QApplication;
class MainWindow;
class OnboardingDialog;

namespace vile_demo {

// Show the onboarding wizard and script its two screenshots, ending in
// acceptWithDefaults() (so the caller's exec() returns Accepted).
void prepareOnboarding(OnboardingDialog& dlg, const QString& shotDir);

// Session-restore proof: screenshot the freshly restored window, quit.
int runRestoreShot(QApplication& app, MainWindow& window, const QString& shotDir);

// The full screenshot chain. Runs the event loop; returns its result.
int runDemoShots(QApplication& app, MainWindow& window, const QString& shotDir);

}  // namespace vile_demo
