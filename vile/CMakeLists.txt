cmake_minimum_required(VERSION 3.20)
project(vile VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(SQLite3 REQUIRED)
find_package(Threads REQUIRED)

add_library(vile_backend STATIC
  src/url.cpp
  src/search_engines.cpp
  src/storage.cpp
  src/privacy.cpp
  src/onboarding.cpp
  src/json.cpp
  src/http.cpp
  src/local_ai.cpp
  src/browser.cpp)
target_include_directories(vile_backend PUBLIC include)
target_link_libraries(vile_backend PUBLIC SQLite::SQLite3)
target_compile_options(vile_backend PRIVATE -Wall -Wextra -Wpedantic -Wshadow)

enable_testing()
add_executable(vile_tests tests/test_main.cpp)
target_link_libraries(vile_tests PRIVATE vile_backend Threads::Threads)
target_compile_options(vile_tests PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME vile_tests COMMAND vile_tests)

# Qt UI (window, tabs, AI side panel, Settings, onboarding) — the product.
# The UI is ON by default and a missing Qt6 is a BUILD FAILURE, not a
# green build of a backend nobody shipped: a silent skip is how a release
# ends up without its own window. Configure with -DVILE_BUILD_QT_UI=OFF
# to build the backend and its tests alone, deliberately.
option(VILE_BUILD_QT_UI "Build the Qt window UI (needs Qt6 Widgets + WebEngine)" ON)
if(VILE_BUILD_QT_UI)
  find_package(Qt6 QUIET COMPONENTS Widgets WebEngineWidgets Network Concurrent)
  if(Qt6_FOUND)
    add_subdirectory(qt)
  else()
    message(FATAL_ERROR "Qt6 not found, but VILE_BUILD_QT_UI is ON: the UI is the product. "
      "Install qt6-base-dev + qt6-webengine-dev, or pass -DVILE_BUILD_QT_UI=OFF for a backend-only build.")
  endif()
endif()
