// ipad-tile-availability-probe — the resolve-or-dim decision for iPad Mode tiles.
//
//   ./scripts/bundle.sh --js scripts/dev/ipad-tile-availability-probe.ts /tmp/ipad-tile-availability-probe.js \
//     && gjs -m /tmp/ipad-tile-availability-probe.js
//
// No window, no GTK, no display: it calls `resolveLaunchId()` and
// `isIPadTileUnavailable()` (ui/shell/surfaces/ipad-mode/IPadApps.ts)
// with fake app registries — a Set of desktop ids "installed" on the
// fake machine — standing in for `AppService.getAppInfo`.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// On the Dell (v1.2.2) the Calendar and Clock tiles looked launchable
// but dead-ended: GNOME Calendar/Clocks are not installed, no desktop
// id resolved, and the tap fell through to the "coming in a later
// phase" hint. The fix dims such tiles and makes the tap a no-op —
// and the hint stays reserved for the four Islamic tiles, whose
// "Soon" badge + hint is by design. This probe pins that decision:
// which tiles dim under which registry, so a later change to the
// tile list or the resolver cannot silently reintroduce a dead-end
// tile or dim a tile that should launch.
//
// Three properties are checked:
//
//   · resolveLaunchId returns the FIRST resolving id, in list order
//     (a tile follows what is actually installed), or null.
//   · isIPadTileUnavailable is true exactly for the tiles that are
//     not unbuilt, not Settings, and have no resolving id — under
//     an empty registry that is seven tiles, never the four Islamic
//     ones and never Settings.
//   · under a registry holding every id, no tile is unavailable —
//     the control that catches the rule being deleted or inverted
//     (tiles always "available" would fail the empty-registry cases;
//     tiles always "unavailable" would fail these).

import { IPAD_APPS, isIPadTileUnavailable, resolveLaunchId, type IPadApp } from "../../ui/shell/surfaces/ipad-mode/IPadApps"

let failures = 0
const fail = (name: string, why: string) => {
    failures++
    print(`FAIL ${name}: ${why}`)
}
const check = (name: string, cond: boolean, why = "") => {
    if (cond) print(`   ok ${name}`)
    else fail(name, why || "expected true")
}

/** A fake registry: the desktop ids "installed" on the fake machine. */
const registry = (...ids: string[]) => {
    const set = new Set(ids)
    return (id: string) => set.has(id)
}

const byId = (id: string): IPadApp => {
    const app = IPAD_APPS.find((a) => a.id === id)
    if (!app) throw new Error(`no iPad tile ${id}`)
    return app
}

print("── resolveLaunchId: first resolving id wins, in list order")
check(
    "calendar resolves org.gnome.Calendar when installed",
    resolveLaunchId(byId("calendar"), registry("org.gnome.Calendar", "gnome-calendar")) === "org.gnome.Calendar",
)
check(
    "calendar falls back to gnome-calendar (second candidate)",
    resolveLaunchId(byId("calendar"), registry("gnome-calendar")) === "gnome-calendar",
)
check(
    "clock falls back to gnome-clocks (second candidate)",
    resolveLaunchId(byId("clock"), registry("gnome-clocks")) === "gnome-clocks",
)
check(
    "calendar resolves null when nothing installed",
    resolveLaunchId(byId("calendar"), registry()) === null,
)
check(
    "photos prefers org.gnome.Photos over Loupe over eog",
    resolveLaunchId(byId("photos"), registry("eog", "org.gnome.Loupe", "org.gnome.Photos")) === "org.gnome.Photos",
)
check(
    "photos falls back to Loupe, then eog",
    resolveLaunchId(byId("photos"), registry("org.gnome.Loupe")) === "org.gnome.Loupe"
        && resolveLaunchId(byId("photos"), registry("eog")) === "eog",
)

print("")
print("── isIPadTileUnavailable: the Dell registry (no GNOME Calendar/Clocks/Notes/Photos)")
// The Dell's shape: Files/Terminal/Browser present, the four GNOME
// apps absent. What the Dell actually has beyond that is unproven
// from here — the probe covers the shape, not the machine.
const dell = registry("org.gnome.Nautilus", "kitty", "firefox")
for (const id of ["calendar", "clock", "notes", "photos"]) {
    check(`${id} is unavailable on the Dell registry`, isIPadTileUnavailable(byId(id), dell))
}
for (const id of ["files", "terminal", "browser"]) {
    check(`${id} stays available on the Dell registry`, !isIPadTileUnavailable(byId(id), dell))
}
check("settings is never unavailable (no desktop ids, launches Settings)", !isIPadTileUnavailable(byId("settings"), registry()))
for (const id of ["quran", "prayer", "dhikr", "dua"]) {
    check(
        `${id} is NOT unavailable — unbuilt tiles keep Soon badge + hint`,
        !isIPadTileUnavailable(byId(id), registry()),
        "an unbuilt Islamic tile must never take the dimmed/inert path",
    )
    check(
        `${id} still resolves no launch id (no program exists yet)`,
        resolveLaunchId(byId(id), registry()) === null,
    )
}

print("")
print("── every tile, empty registry vs full registry (the controls)")
const allIds = IPAD_APPS.flatMap((a) => [...a.desktopIds])
const full = registry(...allIds)
const unavailableEmpty = IPAD_APPS.filter((a) => isIPadTileUnavailable(a, registry())).map((a) => a.id)
const unavailableFull = IPAD_APPS.filter((a) => isIPadTileUnavailable(a, full)).map((a) => a.id)
print(`   unavailable under an empty registry: ${unavailableEmpty.join(", ")}`)
check(
    "empty registry dims exactly the seven launchable-but-absent tiles",
    unavailableEmpty.length === 7
        && ["files", "terminal", "browser", "calendar", "clock", "notes", "photos"].every((id) => unavailableEmpty.includes(id)),
    `got ${JSON.stringify(unavailableEmpty)}`,
)
check(
    "full registry dims nothing (the rule is not inverted)",
    unavailableFull.length === 0,
    `got ${JSON.stringify(unavailableFull)}`,
)
check("the home screen still has twelve tiles", IPAD_APPS.length === 12, `got ${IPAD_APPS.length}`)

print(failures === 0 ? "\nALL RULES HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)
