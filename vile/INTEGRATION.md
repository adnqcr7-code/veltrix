# Connecting an engine to VILE

The backend never talks to Chromium directly. It only knows the `Engine` interface
(`include/vile/engine.hpp`). To connect Chromium (CEF or Qt WebEngine), implement that
interface in a new file, e.g. `src/engine/cef_engine.cpp`, and pass an instance to `Browser`.

Reference implementation: `include/vile/fake_engine.hpp` (in-memory, used by the tests).

## 1. Implement `Engine`
- `create_view / destroy_view / load_url / go_back / go_forward / reload / stop`
- `can_go_back / can_go_forward`
- `clear_site_data()` wipes cookies, the HTTP cache, visited links, and —
  because Qt 6.4 has no API for them — the profile's on-disk storage
  subtrees (local storage, IndexedDB, service workers, …), plus the whole
  cache directory (used by "clear on exit" and the clear-data dialog)
- `set_private_mode(bool)` is part of the Engine interface and is driven
  by the core (`Browser::set_private_mode` forwards it, so the wiring is
  structural and FakeEngine-testable): the Qt adapter runs views on an
  off-the-record profile — memory-only cookies, cache, local storage and
  IndexedDB — and moves live views onto it, reloading them. When history
  is on, views use the persistent profile. Session restore also persists
  nothing while history is off — tab URLs are history by another name.
  Tab drag-reorder is real: the strip forwards drops to
  `Browser::move_tab`, which clamps them out of the pinned region.
- Settings → "Clear browsing data…" opens a dialog (history and/or site
  data; history can be ranged — last hour / 24 hours / all time, backed by
  `HistoryStore::clear_since`, tested — while site data is always wiped in
  full and the dialog says so)
- Call the `EngineEvents` listener (set via `set_listener`) when something changes:
  `on_url_changed`, `on_title_changed`, `on_loading_changed(false)` when a page finishes.
  History is recorded from `on_loading_changed(false)`.

## 2. Start-up order
1. `Database db(path)`: use a file in the user's data dir (it is created owner-only, 0600).
2. If `!Onboarding::is_complete(SettingsStore(db))`: run first-run setup (section 4).
3. `PrivacySettings s = PrivacySettings::load(SettingsStore(db))`
4. `Shield shield(s)`; `Browser browser(engine, &history)`
5. `browser.set_private_mode(!s.save_history)`
6. `browser.set_search_engine(*find_search_engine(s.search_engine_id))`
7. On quit: `browser.close_session(s.clear_on_exit, !s.save_history)`

## 3. Wire the Shield into the engine (nothing is blocked until this is done)
- **Every network request** (CEF: `CefResourceRequestHandler::OnBeforeResourceLoad`;
  Qt: `QWebEngineUrlRequestInterceptor`): call
  `shield.check_request(request_url, top_level_url)`.
  `Block` -> cancel. `UpgradeToHttps` -> redirect to `upgrade_to_https(url)`.
  Add the headers from `shield.request_headers()` to every request.
- **Every cookie** (CEF: `CefCookieAccessFilter`; Qt: cookie filter): call
  `shield.check_cookie(cookie_url, top_level_url)`; refuse on `Block`.
- Load a maintained blocklist (e.g. EasyPrivacy/hosts format) with
  `shield.add_rules_from_text(text)` at start-up. The built-in list is only a small starter set.
- The checks are **const**: a built Shield is immutable. Engines hold it as an
  atomic snapshot (`std::atomic<std::shared_ptr<const Shield>>` in
  `ShieldAccess`) — settings/blocklist changes build a new Shield and swap it
  in, so the checking thread never locks and never sees a half-updated rule
  set. Blocked requests are recorded by the CALLER into a `vile::BlockLog`
  (see the interceptor in `qt/qt_engine.cpp`); the privacy dashboard reads
  `blockLog.recent()` / `blockLog.total()` and `shield->rule_count()`.
- Known gap: `registrable_domain()` is an approximation. Replace it with the Public
  Suffix List before relying on third-party cookie decisions.

## 4. First-run setup UI
- Detect AI: `detect_local_ai(http)` with `LoopbackHttp http;` (takes under a second when
  nothing is running). Run it once, before showing questions.
- `Onboarding::questions_for(detected)` returns the questions in order: six privacy
  questions, plus `local_ai` and `ai_model` only if AI was found.
- Show the `ai_model` question only if the user answered `local_ai = yes`.
- Each option has `label`, `summary` (short card text) and `promise` / `downside` /
  `source_url` for a "more info" view.
- Submit with `Onboarding::apply(db, answers, detected)`. It throws `std::invalid_argument`
  on bad answers and saves nothing in that case. Unanswered questions get the private default.
- Search engines should be shown in random order (as in the Helium setup screen). Not
  done yet. The default is Brave Search (the user's call, 2026-11-12 — it was DuckDuckGo before).

## 5. The page assistant (the "extension-like" AI helper)
- Build `LocalAssistant assistant(http, settings)` only when `settings.ai_ready()`.
- Add a side panel button "Explain this page". Get the page's visible text from the engine
  (CEF: a `CefStringVisitor` over the main frame; Qt: `page()->toPlainText()`), then call
  `assistant.explain_page({url, title, text})` or `ask_about_page(page, question)`.
- **Both block for up to ~2 minutes. Call them on a worker thread, never the UI thread.**
- The assistant is read-only. It cannot click, navigate or run anything.
- It only talks to `127.0.0.1` (`LoopbackHttp` refuses any other host) and only for
  `http(s)` pages.
- Show `assistant.activity()` to the user (URL, model, how many characters were sent).
- Page text is untrusted: `sanitize_page_text` already defuses the page delimiter. Keep
  the assistant read-only even if the model's answer asks for actions.

## 6. Build and test
```
cmake -S . -B build && cmake --build build && ctest --test-dir build --output-on-failure
```
Requires CMake 3.20+, a C++20 compiler and SQLite3 dev headers (Arch: `pacman -S sqlite`).

## 7. The Qt UI (`qt/`, binary `vile-qt`)
Window, tabs, AI side panel, Settings page and onboarding — see `qt/README.md`.
`QtEngine` (`qt/qt_engine.cpp`) implements the `Engine` interface over
`QWebEngineView`; the Shield is wired in via a `QWebEngineUrlRequestInterceptor`
and the profile's cookie filter, as section 3 describes for Qt. Search engines
are shown in random order in Settings and in onboarding; the default stays
Brave. The blocklist is a curated ~100-domain bundled list with an
optional download of the maintained StevenBlack unified hosts file — the
14-domain seed set is only the last-resort fallback now. Helium-style
features: `!bangs` in the address bar (resolved locally in `vile/url.cpp`,
e.g. `!w`, `!gh`, `!yt`, `!so`, `!mdn`, `!r`, `!g`), vertical tabs (View menu,
persisted in QSettings, a list on the left instead of a tab bar), and a local
new tab page (search box, quick links, `!bang` hints; shown for blank tabs,
no network until the user searches or clicks). The address bar shows
suggestions as you type — history matches, `!bangs`, and a search row — in a
popup card; history suggestions only exist when the user opts into saving
history (off by default). Tabs are pill-shaped with a dot on the active one,
and in vertical mode the sidebar groups quick site tiles under FAVORITES and
the tabs under TABS. The new tab page is a bento layout: a time-of-day
greeting, a live clock and date, a pill search box, a tile grid for the
`!bang` sites, and a trackers-blocked count for the session. Icons are one
consistent hand-drawn line set (`qt/icons.h` / `qt/icons.cpp`, 1.7 px strokes
on a 24 px grid, rendered at 2x): the rail, the navigation buttons, the
address-bar Shield badge (green while protection is on, amber when off) and
the Settings nav all use it, so no stock Qt icons remain. The window title
follows the active tab's page title. The Privacy tab in the side panel leads
with a status card ("● Protected" / "○ Shield off" in the semantic colours,
with the blocked count and rule count), and tab close buttons appear only on
the hovered or active tab. Keyboard shortcuts: Ctrl+T / Ctrl+W live on the
File menu, Ctrl+L focuses the address bar (View menu), Ctrl+R reloads the
current tab, and Ctrl+Tab / Ctrl+Shift+Tab cycle tabs. While a tab loads, its
icon is a spinning violet arc (100 ms timer, `icons::spinnerPixmap`); the
letter or favicon returns when the load finishes. A History tab in the side
panel lists the last 50 visits — one card per visit (schema v2 keeps a
per-visit table next to the per-URL aggregate that backs counts and
most-visited), newest first — with a search box and a Clear history
button; double-clicking a row reopens it. Bookmarks
live in a fourth panel tab (star on the rail) with a star button at the end
of the address bar — outline when the page is not saved, filled violet when
it is; Ctrl+D toggles it, double-click reopens a bookmark, and a Remove
button deletes the selected one. The panel's four tabs all stay visible
(scroll buttons off, elide instead). Session restore: the open tabs' addresses
and the active index are saved to the SettingsStore (`session/tabs`,
`session/active`) whenever they change and on every quit path, and reopened
on the next launch when the "Reopen tabs from last time" toggle in Settings →
Privacy & Shield is on (default); only addresses are saved, never cookies or
site data. Downloads: a fifth panel tab (download icon on the rail) fed by the
profile's `downloadRequested` — files save to the folder from Settings →
Downloads (`downloads/folder`, defaulting to the system Downloads folder)
with a unique name when one already exists ("file (1).pdf"), the panel opens
itself when a download starts, and each row shows a live progress bar,
"X of Y" sizes, Pause/Resume while active, Cancel, Open when finished, and a
"Clear finished" button empties completed rows. The Downloads settings
section also has "Ask where to save each file" (`downloads/askEachTime`):
when on, a native save dialog picks the target (prefilled with the folder +
suggested name) and cancelling it cancels the download before any row appears. PDFs download
instead of opening in Chromium's viewer (`PdfViewerEnabled` off). Page zoom: Ctrl + / − / 0
(View menu, `QKeySequence::ZoomIn` / `ZoomOut`) steps through a standard ladder
(25%–500%), remembered per site (host) in QSettings (`zoom/<host>`, cleared at 100%);
a percentage button appears next to the address bar only while the page is zoomed
and clicking it resets to 100%. The stored factor is re-applied on every URL change
(`applyZoomForUrl`, keyed by host per view), so a new tab to the same site opens at
the stored zoom. The UI tracks its own factor (`trackedZoom`) because the renderer's
reported `zoomFactor()` can lag a step behind `setZoomFactor`. Brand assets live in
`qt/assets/` (compiled into `resources.qrc`): a shield-and-V logo (window icon, rail,
onboarding header, and a 256 px copy inlined as a data URI on the new tab page) and a
near-black violet aurora artwork (onboarding banner). A design-audit pass quieted the
chrome: borderless text tabs with an accent underline in the side panel, transparent
in-dock lists, a raised Privacy status card, themed checkbox/radio indicators, surface
tiles with brand-coloured letters for favorites (sidebar + new tab page), content-width
ghost buttons for panel actions, Reload/Stop sharing one toolbar slot, and the
Assistant icon redrawn as a speech bubble. The new tab page also has a "Most
visited" section (`ntp/showVisited`, on by default): up to 8 tiles from
`HistoryStore::most_visited` (visit count, then recency — covered by a backend
test), rendered only when history actually has entries, with page-controlled
titles/URLs HTML-escaped. Tab pinning: right-click a tab for Pin/Unpin,
Duplicate tab, Close tab, or Close other tabs, and middle-clicking a tab
closes it. `Browser::set_pinned` moves the tab to the end of the pinned
region at the front (first unpinned slot when unpinning) and
`Browser::duplicate_tab` opens a copy of the page right after the original —
both covered by backend tests; pinned tabs render icon-only with no close
button in both layouts. When the strip's order diverges from the Browser's,
syncTabs rebuilds the items (`tabList_->clear()` + recreation) instead of
moving them: QListWidget owns the item widgets, and takeItem/insertItem
leaves the view holding a deleted widget (a segfault in the next layout
pass). Reopen closed tab: the last 10 closed tabs (address + position)
are kept in memory, Ctrl+Shift+T (File menu) reopens the newest at its old
position — `Browser::open_tab` takes an optional insert index, covered by a
backend test. Find in page: Ctrl+F opens a slim bar at the bottom of the tab
area (FindBackward via chevron-up / Shift+Enter, "N / M" match count from the
async `findText` callback, Esc closes and clears the highlights). The visual
system lives in
`qt/theme.h` / `qt/theme.cpp`: semantic colour roles (background, surface,
accent, green = protected, amber = a protection is off, red = destructive
only) and four user-chosen accents (violet, green, blue, neutral). Settings
(`qt/settingsdialog.*`) is a two-pane window — Appearance (accent, vertical
tabs), Privacy & Shield, Search (engines in random order, suggestions
toggle), New Tab (clock / tiles / stats toggles), Downloads (save folder),
Local AI — with a one-line
explanation under every control; appearance, suggestions and new-tab changes
apply immediately, privacy/search/AI changes apply on OK.

## Build layout & tests
- `vile-qt` is the production binary. The scripted screenshot demo lives
  in a separate `vile-demo` target (`qt/mainwindow_demo.cpp` +
  `qt/demo/demo_harness.cpp`, built with `VILE_DEMO`): the production
  binary contains no demo options, hooks or screenshot code.
- Tests: `vile_tests` (backend, `tests/`) and `vile_ui_tests`
  (Qt layer, `qt/tests/`, run offscreen by ctest: OTR profile migration,
  downloads index stability across ten sequential downloads (opt-in via
  `VILE_TEST_DOWNLOADS=1`, set in CI — sandboxed hosts can wedge inside
  the first attachment navigation itself), clear-data dialog contract,
  session-restore gating, pinned-tab alignment, and a hard
  failure if Qt's "Release of profile requested" warning ever appears
  in the output). CI (`.github/workflows/ci.yml`) builds both
  configurations — the full UI and the deliberate
  `-DVILE_BUILD_QT_UI=OFF` backend-only build.
- The Qt layer's structure (MainWindow was once the whole application):
  `TabStripController` owns the tab list, page stack and tab sync
  (items hash-indexed; sync is a set-diff orchestration over
  prune/rebuild/create/refresh phases; the window hears `synced()` and
  updates the chrome); `DownloadsPanel` owns the downloads page, its
  requests (QPointer-guarded, indexed by a per-item id into heap
  items owned by a deque of unique_ptr, so an entry can neither dangle
  nor re-point at a neighbouring download) and the destination policy;
  `AssistantPanel` owns the Assistant dock page — its widgets, the
  future watcher and the run/finish flow (the window pushes settings
  and detected providers, and gives it page access — url/title plus
  an async text fetch — wired to the core, never a widget);
  `AddressBar` owns the address edit, its Shield badge and bookmark
  star, and the whole suggestions cluster (popup, bang completion,
  keyboard navigation; history matches arrive through a provider so
  the guarded store read stays in the window); `FindBar` owns the
  find-in-page strip and its keyboard behaviour, while the search
  itself runs through the Engine port; `PrivacyPanel`, `HistoryPanel` and `BookmarksPanel` own
  the other dock pages the same way (the window keeps the stores and
  the Shield, pushes snapshots/entries in, and hears navigation,
  clear, remove and update requests back; History and Bookmarks rows
  are cards — site letter, title, host · time — matching Downloads);
  `SessionStore`
  owns session save/restore (guarded, transactional, history-gated);
  the History/Bookmarks card rows are built by one shared helper
  (`entryrow.h`); the constructor's remaining assembly runs as three
  named phases (buildMenus / buildRail / buildSidePanel); `NtpPage`
  builds the new-tab page's HTML from inputs the window assembles
  (search template, accent, section toggles, blocked count,
  most-visited entries).
  `UiSettings` is the single owner of the QSettings UI preferences —
  one defaults table, cached hot-path values, a `changed(key)` signal
  (the downloads panel refreshes its empty-state note from it). No
  other file constructs a QSettings. Page operations — find, zoom
  and page text — live on the `vile::Engine` interface itself
  (implemented by both the Qt adapter, which owns the per-view zoom
  factors, and the FakeEngine), reached through `Browser`
  passthroughs; the tab strip depends only on a narrow view-source
  interface, not the concrete engine. Pages a private-mode swap
  replaces are deleted by the engine, which tracks the page it
  attached to each view; engine shutdown flushes deferred deletions
  and deletes remaining views before its profiles are released.

## Not built yet
VILE Spaces, CLI/IPC, automatic security updates, NPU/GPU detection
(detection only finds running Ollama / LM Studio / llama.cpp servers), and
streaming AI replies.
