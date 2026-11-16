// iPad Mode — the twelve home-screen apps.
//
// One curated set, in the order the concept shows them (Launchpad render):
// six system apps, then the four Islamic apps, then Notes and Photos. The
// icons are REAL files shipped with the shell (`ui/shell/assets/apps/`):
// the four drawn SVGs (Quran/Prayer/Dhikr/Dua) and the Papirus SVGs for
// the rest — never emoji tiles, never AI-generated icons. Two exceptions
// drawn here, not Papirus (fix pass #1, Nov 13 2026): `terminal.svg` is
// a plain `>_` window (the Papirus cat is banned — an animal in an
// icon), and `browser.svg` is a TEMPORARY neutral globe glyph (the
// Papirus fox is banned; Adnan's own browser, being built with other
// agents, will replace it — see ATTRIBUTION.md).
//
// Icon history (Adnan, Nov 12): drawn SVGs + Papirus (v1) → dark AI
// (v2) → colorful AI (v3, rejected as "really bad") → dark AI restored
// (v4) → drawn SVGs + Papirus restored (v5, 19:28 EST, final). Both AI
// sets (`*-ai.webp`, `*-color.webp` in concept/icons/) are SUPERSEDED —
// do not reintroduce them. Every icon sits on a black tile (v5, eye
// protection): the tile background is in _ipad-mode.scss / _app-grid.scss,
// not in the icon files — the SVGs themselves keep their own colours.
//
// ── Launch ─────────────────────────────────────────────────────────────────
// A tile launches by desktop id through AppService, exactly the way the app
// grid does (`getLaunchArgv`, Exec= fallback). The candidates are tried in
// order; the first one `getAppInfo` resolves wins, so a tile follows what
// is actually installed (Helium before Firefox, Photos before Loupe).
//
// A tile that is NOT an unbuilt Islamic app and NOT Settings, and whose
// desktop ids NONE resolve on this machine (GNOME Calendar/Clocks are
// not installed on the Dell), renders dimmed and inert instead of
// dead-ending on the "coming soon" hint — see `isIPadTileUnavailable`
// below and IPadMode.tsx. The hint stays reserved for the four Islamic
// tiles, by design.
//
// The four Islamic apps (Quran, Prayer, Dhikr, Dua) do NOT exist as
// programs yet — no .desktop entry, no reader/prayer/dhikr/dua surface in
// this fork (Phase 6/10 work). Their tiles carry the drawn SVG icons and
// the `veltrix-*` desktop ids they will launch when the apps land; until
// then a tap shows an honest inline hint ("coming in a later phase")
// instead of fake-launching. Do NOT invent a .desktop entry that points
// at nothing.

import { SHELL_ROOT } from "../../core/Paths"

export interface IPadApp {
    /** Stable id, also the i18n suffix (`ipad.app.<id>`). */
    id: string
    /** Icon file under `ui/shell/assets/apps/`. */
    iconFile: string
    /** Desktop ids to launch, in order. Empty = no app exists yet. */
    desktopIds: readonly string[]
    /** Opens the shell's own Settings instead of launching an app. */
    settings?: boolean
    /** True while no program exists behind the tile. */
    unbuilt?: boolean
}

export const IPAD_APPS: readonly IPadApp[] = [
    { id: "files",    iconFile: "files.svg",    desktopIds: ["org.gnome.Nautilus", "nautilus", "thunar"] },
    { id: "terminal", iconFile: "terminal.svg", desktopIds: ["kitty", "org.gnome.Console", "gnome-terminal"] },
    { id: "browser",  iconFile: "browser.svg",  desktopIds: ["helium", "helium-browser", "firefox", "org.mozilla.firefox", "chromium"] },
    { id: "settings", iconFile: "settings.svg", desktopIds: [], settings: true },
    { id: "calendar", iconFile: "calendar.svg", desktopIds: ["org.gnome.Calendar", "gnome-calendar"] },
    { id: "clock",    iconFile: "clock.svg",    desktopIds: ["org.gnome.Clocks", "gnome-clocks"] },
    { id: "quran",    iconFile: "quran.svg",    desktopIds: ["veltrix-quran"], unbuilt: true },
    { id: "prayer",   iconFile: "prayer.svg",   desktopIds: ["veltrix-prayer"], unbuilt: true },
    { id: "dhikr",    iconFile: "dhikr.svg",    desktopIds: ["veltrix-dhikr"], unbuilt: true },
    { id: "dua",      iconFile: "dua.svg",      desktopIds: ["veltrix-dua"], unbuilt: true },
    { id: "notes",    iconFile: "org.gnome.Notes.svg", desktopIds: ["org.gnome.Notes", "bijiben", "gnote"] },
    { id: "photos",   iconFile: "org.gnome.Photos.svg", desktopIds: ["org.gnome.Photos", "org.gnome.Loupe", "eog"] },
]

/** Absolute path of a shipped icon file. */
export function ipadIconPath(app: IPadApp): string {
    return `${SHELL_ROOT}/assets/apps/${app.iconFile}`
}

/**
 * First desktop id that resolves on this machine, or null.
 * `hasAppInfo` is `AppService.getAppInfo` in the shell; a predicate
 * here so the decision is probeable without GTK — the launch path in
 * IPadMode.tsx calls this with the real registry, so there is one
 * resolver, not two.
 */
export function resolveLaunchId(
    app: IPadApp,
    hasAppInfo: (id: string) => boolean,
): string | null {
    for (const id of app.desktopIds) {
        if (hasAppInfo(id)) return id
    }
    return null
}

/**
 * Whether the tile renders dimmed and inert: not an unbuilt Islamic
 * app, not Settings, and none of its desktop ids resolves on this
 * machine (e.g. GNOME Calendar/Clocks are not installed). Unbuilt
 * tiles keep their own "Soon" badge + hint by design; Settings
 * always launches.
 */
export function isIPadTileUnavailable(
    app: IPadApp,
    hasAppInfo: (id: string) => boolean,
): boolean {
    if (app.unbuilt || app.settings) return false
    return resolveLaunchId(app, hasAppInfo) === null
}
