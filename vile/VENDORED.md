# Vile browser — vendored source

Adnan's own privacy browser (C++/Qt, Qt WebEngine), v48. The installer
offers it as an opt-in extra app (number 10) and builds it from this
tree when picked — never by default, never forced.

## Source

- Origin: `~/workspace/user/files/vile-v48-everything.zip`, sent by Adnan
  2026-11-14 (SHA-256
  `8cdbe881fffe31f2883b764428c4d6e713eb0d1d0bb9aee9e34772529295d040`).
  The zip holds `vile-v48/vile/` (the source) and `vile-v48/screenshots/`
  (design-review screenshots, NOT vendored).
- Upstream version: `0.1.0` (`project(vile VERSION 0.1.0)` in
  `CMakeLists.txt`); "v48" is the iteration count in the zip's name.
- Vendored 2026-11-14, verbatim except for the exclusions and the one
  Veltrix patch below. Verify with: extract the zip, delete `.github/`,
  `tools/` and `screenshots/`, apply the patch, and `diff -r` against
  this directory — the only difference must be the patch.

## Excluded (not needed to build or run the browser)

- `.github/workflows/ci.yml` — the Vile repo's own CI.
- `tools/drip_server.py` — a throttled local file server used only by
  the scripted screenshot demo.
- `screenshots/` — design-review screenshots, outside `vile/` in the zip.

## Kept (the build needs them even when not built)

- `qt/demo/` and `qt/tests/` — `qt/CMakeLists.txt` lists them in the
  `vile-demo` and `vile_ui_tests` targets, so the files must exist for
  `cmake` configure to succeed. The installer builds only the `vile-qt`
  target; the demo binary is never built or installed.
- `qt/assets/` (1.1 MB, mostly `ntp-art.png` and the logos) — bundled
  into the binary through `resources.qrc`; `logo-256.png` is also
  installed as the desktop icon.

## Veltrix patch (one line, `qt/main.cpp`)

`app.setDesktopFileName(QStringLiteral("vile"));` after
`setApplicationVersion` — upstream sets no desktop file name, so Qt
would announce the Wayland app-id "VILE" and the desktop could not match
the running window to `vile.desktop` (dock, app grid, overview). With
the patch the app-id is "vile", matching the desktop file the installer
writes.

## Build (what the installer does — `install.sh`, `apps_vile`)

- Build deps, installed on demand only when Vile is picked:
  `cmake sqlite qt6-base qt6-webengine` (`base-devel` is already an
  installer dependency, so gcc/make are present). Qt WebEngine is the
  big one (~100 MB+ download); the prompt says the install builds from
  source and takes a few minutes.
- `cmake -S <this dir> -B <build dir> -DCMAKE_BUILD_TYPE=Release`
  then `cmake --build <build dir> --target vile-qt -j$(nproc)`.
  Only the `vile-qt` target is built — never `vile-demo`.
- Installed: the binary to `/usr/local/bin/vile`, the icon
  (`qt/assets/logo-256.png`) to
  `/usr/share/icons/hicolor/256x256/apps/vile.png`, and a `vile.desktop`
  file (written by the installer; upstream ships none).
- The engine is Qt WebEngine (`qt/qt_engine.cpp` adapts it to the
  `Engine` interface in `INTEGRATION.md`); the fake engine in
  `include/vile/fake_engine.hpp` is tests-only and never ships.
- A failed build is recorded in `apps.json`'s `failed` list like any
  other extra app and never blocks the install.

## Size impact

This directory is 1.9 MB on disk. The release tarball grows by roughly
that much uncompressed (less compressed — the PNG assets barely
compress, the C++ sources compress well).
