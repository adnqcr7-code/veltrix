# VILE Qt UI (`vile-qt`)

The window for the VILE backend: tabs, address bar, AI side panel, Settings
page and first-run onboarding, wired to the backend exactly as
`INTEGRATION.md` describes.

## What it is

- **Window + tabs** — `QTabWidget` over Qt WebEngine views. Each tab is a
  `vile::Browser` tab; the engine is `QtEngine` (`qt_engine.cpp`), which
  implements the `vile::Engine` interface over `QWebEngineView`. The core
  never talks to Chromium directly.
- **Shield, wired in** — every request passes a `QWebEngineUrlRequestInterceptor`
  that calls `Shield::check_request` (block / upgrade to https / add the
  Sec-GPC header). Third-party cookies go through the profile's cookie filter.
  Blocked count and recent blocks show in the side panel's Privacy tab.
- **AI side panel** — "Explain this page" and "Ask about this page" run the
  backend's `LocalAssistant` on a worker thread (it can block for up to ~2
  minutes). Read-only, on-device only, loopback-only. Disabled unless local AI
  is enabled in Settings. The activity list shows what was sent (URL, model,
  characters) — never the page text.
- **Settings page** — privacy toggles, the tracker blocklist (with Update),
  and the search-engine picker. Engines are shown in **random order** every
  time the dialog opens; the default is Brave Search.
- **Onboarding** — first-run wizard: the six privacy questions, plus local-AI
  questions only when a server is detected. Search-engine options are shuffled;
  unanswered questions get the private default.
- **Blocklist** — the 14-domain starter set is gone as the main list. The app
  ships a curated ~100-domain list (`blocklists/trackers.txt`) as the offline
  fallback, and Settings can download the maintained StevenBlack unified hosts
  file, which then takes over. Both hosts-format and EasyPrivacy-style
  (`||domain^`) lines are accepted.

## Build

```sh
# Ubuntu 24.04:
sudo apt install qt6-base-dev qt6-webengine-dev
cmake -S . -B build && cmake --build build
# The Qt UI builds automatically when Qt6 is found; the backend tests are unaffected.
```

## Run

```sh
./build/qt/vile-qt            # normal run; first launch shows onboarding
./build/qt/vile-qt --demo-shots /tmp/vile-shots   # scripted demo + screenshots, then quits
```

The demo saves twenty-nine screenshots: onboarding (`00`), onboarding page 2 after
a Right-arrow keypress (`00b`, proving the keyboard navigation), the main
window with a real search results page (`01`, with the address bar focused
and its URL selected, as Ctrl+L does — driven directly in the demo because
Xvfb never activates the window, so the key event never reaches the shortcut
map; the Example tab is pinned first, so it sits at the front of the strip
as a compact icon-only tab), a loading tab with its spinner (`01b`, grabbed while the
demo tabs are still fetching), Settings Appearance + Downloads (`02`,
`02b`, the demo folder) + Search (`03`) + Privacy (`03b`), with the
"Clear browsing data" dialog opened and cancelled (`03c` — cancelled
because the demo still needs its history), the
utility rail driving the side panel (`04` assistant, `05` privacy, `05b`
history, `05c` bookmarks — the current tab bookmarked first, so the star in
the address bar shows filled), vertical tabs (`06`), the new tab page (`07`),
a `!w` bang resolving to a Wikipedia search (`08`), Find in page on that
article (`08b`, searching for "Vile"), the address-bar suggestions popup, for
bangs (`09`) and for a history match (`10`), the tab bar after a Ctrl+Tab
cycle (`11`, driven directly for the same Xvfb reason as Ctrl+L), a tab
closed and reopened (`12`, `12b`), the reopened tab duplicated and the copy
then closed with a synthesized middle-click (`12c`, `12d` — the download
started on the copy keeps running, since downloads belong to the profile),
and a download that starts with the
"Ask where to save" save dialog (`13a`, accepted at the suggested path),
is paused mid-transfer, then resumed to completion (`13b`, `13`; the file
comes from a local throttled test server, `tools/drip_server.py`, so the
pause is visible, and lands in the demo download folder).

Session restore is verified separately, in two runs against the same demo
profile: `./build/qt/vile-qt --demo-shots /tmp/vile-shots --demo-keep-data`
(leaves `/tmp/vile-demo-data` in place), then
`./build/qt/vile-qt --demo-restore /tmp/vile-restore`, which opens the
window with the saved session and saves `restore.png`.

Data (SQLite DB, WebEngine profile, downloaded blocklist) lives in the
standard app-data dir (`~/.local/share/VILE/VILE` on Linux).
