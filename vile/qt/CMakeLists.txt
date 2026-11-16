# VILE Qt UI: window, tabs, AI side panel, Settings, onboarding.
# Needs Qt6 Widgets + WebEngineWidgets + Network + Concurrent.
#
# Two executables share the UI sources:
#   vile-qt   — the production browser. No demo code is compiled or
#               linked into it (no --demo-shots option, no demo hooks).
#   vile-demo — the same UI plus the scripted screenshot harness
#               (demo/demo_harness.cpp + mainwindow_demo.cpp, built
#               with VILE_DEMO defined). Used to produce the screenshot
#               set the design reviews judge; never shipped.
cmake_minimum_required(VERSION 3.20)

find_package(Qt6 REQUIRED COMPONENTS Widgets WebEngineWidgets Network Concurrent Test)

set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

set(VILE_UI_SOURCES
  main.cpp
  mainwindow.cpp
    ntppage.cpp
  addressbar.cpp
  findbar.cpp
  qt_engine.cpp
  faviconstore.cpp
  settingsdialog.cpp
  onboardingdialog.cpp
  cleardatadialog.cpp
  blocklist.cpp
  icons.cpp
  theme.cpp
  uisettings.cpp
  sessionstore.cpp
  assistantpanel.cpp
  downloadspanel.cpp
  privacypanel.cpp
  historypanel.cpp
  bookmarkspanel.cpp
  tabstripcontroller.cpp
  resources.qrc)

add_executable(vile-qt ${VILE_UI_SOURCES})
target_link_libraries(vile-qt PRIVATE vile_backend
  Qt6::Widgets Qt6::WebEngineWidgets Qt6::Network Qt6::Concurrent)
target_compile_options(vile-qt PRIVATE -Wall -Wextra -Wpedantic)

add_executable(vile-demo ${VILE_UI_SOURCES}
  mainwindow_demo.cpp
  demo/demo_harness.cpp)
# The app's version has ONE source: the CMake project version.
# main.cpp stamps it into QCoreApplication; nothing else restates it.
target_compile_definitions(vile-qt PRIVATE VILE_APP_VERSION="${PROJECT_VERSION}")
target_compile_definitions(vile-demo PRIVATE VILE_DEMO VILE_APP_VERSION="${PROJECT_VERSION}")
target_link_libraries(vile-demo PRIVATE vile_backend
  Qt6::Widgets Qt6::WebEngineWidgets Qt6::Network Qt6::Concurrent)
target_compile_options(vile-demo PRIVATE -Wall -Wextra -Wpedantic)

# Qt-layer tests (offscreen): the OTR profile migration, the clear-data
# dialog's contract, and session-restore gating — behaviour the
# screenshot demo drives but cannot assert. Same UI sources as the
# product, minus main.cpp.
add_executable(vile_ui_tests
  tests/test_ui.cpp
  mainwindow.cpp
  faviconstore.cpp
    ntppage.cpp
  addressbar.cpp
  findbar.cpp
  qt_engine.cpp
  settingsdialog.cpp
  onboardingdialog.cpp
  cleardatadialog.cpp
  blocklist.cpp
  icons.cpp
  theme.cpp
  uisettings.cpp
  sessionstore.cpp
  assistantpanel.cpp
  downloadspanel.cpp
  privacypanel.cpp
  historypanel.cpp
  bookmarkspanel.cpp
  tabstripcontroller.cpp
  resources.qrc)
target_link_libraries(vile_ui_tests PRIVATE vile_backend
  Qt6::Widgets Qt6::WebEngineWidgets Qt6::Network Qt6::Concurrent Qt6::Test)
target_compile_options(vile_ui_tests PRIVATE -Wall -Wextra -Wpedantic)
# The UI suite drives real WebEngine processes, including loopback
# downloads. Under the offscreen platform on some sandboxed hosts
# Chromium's network service never completes a download (and teardown
# then wedges); under a virtual X server — the same conditions the
# screenshot demo runs in — it is reliable. Prefer xvfb-run when it
# exists; fall back to offscreen elsewhere.
find_program(VILE_XVFB_RUN NAMES xvfb-run)
if(VILE_XVFB_RUN)
    add_test(NAME vile_ui COMMAND ${VILE_XVFB_RUN} -a $<TARGET_FILE:vile_ui_tests>)
    set_tests_properties(vile_ui PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=xcb"
        FAIL_REGULAR_EXPRESSION "Release of profile requested" TIMEOUT 120)
else()
    add_test(NAME vile_ui COMMAND vile_ui_tests)
    set_tests_properties(vile_ui PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
        FAIL_REGULAR_EXPRESSION "Release of profile requested" TIMEOUT 120)
endif()
