// iPad Mode — the whole-screen iPad-style home screen.
//
// The macOS bar stays on top and the macOS dock at the bottom; the middle
// of the screen becomes a big app grid with widgets, still a computer with
// a mouse and a keyboard — no phone frame (Adnan, 2026-11-12 18:51,
// correcting the 18:44 phone-frame idea the same day).
//
// ── Where it lives ────────────────────────────────────────────────────────
// A panel of the Bar's window (commandment 5), like the app grid: Bar
// constructs it, adds it to masterOverlay, and shows it while the mode
// is on AND no overlay is open (see Bar's syncIPad).
//
// THE HOME SCREEN IS THE DESKTOP (Adnan, 2026-11-13, from his photo —
// this replaces fix pass #1's "stays up with windows open"): the home
// screen shows ONLY while no app window is focused, and hides the moment
// one is. The panel lives in the Bar's window, a TOP-layer surface, so it
// paints ABOVE every normal app window — the old rule (show whenever the
// focused window was merely not fullscreen) put it ON TOP of a windowed
// app (Settings, in the photo: sidebar visible at the left, home screen
// covering the main content), and its full-screen input region ate the
// app's clicks. That was a layering bug, not the iPad model. Now: an app
// opened from a tile opens FULL SCREEN on top of the home screen, like an
// iPad — Bar fullscreens the window the launch produces (via AppService's
// launch signal, which every launch path arms, not just tiles) — and a
// windowed app, or one the handoff missed (a slow starter like
// Sober/Wine), is IN FRONT and usable, because focusing it hides the home
// screen. The home screen returns when no window is focused again (apps
// closed or hidden) or the user opens Launchpad. The fullscreen layering
// itself is Dell-gated: it has to be seen on Hyprland/Hyalo, not assumed
// from the layer order.
//
// Two limits survive from v1, for real reasons:
//   · While an overlay (CC, NC, Prism, app grid…) is open the bar holds a
//     focus grab, and a press outside the panel must land OUTSIDE our
//     surface for the compositor to dismiss it. A full-screen home screen
//     in the input region would swallow that press, so the home screen
//     hides while anything is open (see Bar's syncIPad).
//   · While a window is focused the home screen hides (see above) — and
//     while a window is fullscreen the bar hides, and the home screen with
//     it, since it lives in this window. That is the covered state, not a
//     second hiding rule: the app is on top either way.
//
// Pointer-only by design: tiles are Gtk.Buttons, which need no keyboard,
// and there is NO search box — search lives in Prism (Super+Space) and
// the app grid. The bar window's keyboard mode is NONE and modality comes
// from the focus grab, which this surface never takes.
//
// ── Backdrop blur ───────────────────────────────────────────────────────
// GTK has no backdrop-filter: the frosted look of the widget cards and
// the checklist bar comes from the COMPOSITOR's blur on the bar surface
// (hyprland.lua: `layer_rule({ match = { namespace = "veltrix-bar" },
// blur = true, … })`), not from CSS. Under Xvfb there is no compositor
// blur, so the cards render as flat dark tint there — a sandbox
// artifact, not the product. A Dell photo is the proof that the blur
// lands; until then this is a recorded accepted deviation in the
// sandbox, not a claim that Xvfb shows glass.
//
// ── Data ──────────────────────────────────────────────────────────────────
// Next prayer: `veltrix-prayer-times --next`, the same helper the
// prayer-lock scheduler polls, re-read every minute — a failed read
// shows "unavailable", never a stale or invented time. Hijri date:
// HijriService (real Umm al-Qura date or nothing, never faked), shown
// on the prayer card. Verse of the Day: one verse per weekday
// (VerseOfDay.ts) — the full Tanzil Uthmani Arabic plus the Yusuf Ali
// English, with the verse's own reference, so the card is never a
// fragment presented as a verse (the concept's first clause of 24:30
// is a fragment; the whole ayah is shown instead).
//
// There is deliberately NO clock card: the concept shows two cards
// (next prayer, verse) and the date, Hijri date and weather already
// live in the bar at the top of the screen. A third card would
// duplicate the bar.
//
// ── Icons ─────────────────────────────────────────────────────────────────
// Real files from `ui/shell/assets/apps/` (IPadApps.ts): the four drawn
// SVGs (Quran/Prayer/Dhikr/Dua) and the Papirus SVGs for the rest.
// No emoji tiles, no AI-generated icons (both AI sets superseded,
// 2026-11-12 19:28). Every icon sits on a black tile (eye protection,
// same date) — see _ipad-mode.scss.

import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { execAsync } from "../../../lib/process"
import { formatDatePart, foldEasternDigits } from "../../../lib/date-names"
import appService from "../../core/AppService"
import shellActions from "../../core/ShellActions"
import { t } from "../../core/i18n"
import regionConfig from "../../core/RegionConfig"
import hijriService from "../../core/HijriService"
import { IPAD_APPS, ipadIconPath, isIPadTileUnavailable, resolveLaunchId, type IPadApp } from "./IPadApps"
import { createPrayerChecklistBar } from "./PrayerChecklist"
import { verseOfDay, verseReference } from "./VerseOfDay"

const PRAYER_TIMEOUT_MS = 10_000
const PRAYER_POLL_MS = 60_000
const HINT_MS = 4_000

/** Icon pixels on a full-size monitor; the compact size below 1400×800. */
const ICON_LARGE = 84
const ICON_SMALL = 64

export interface IPadModePanelHandle {
    widget: Gtk.Widget
    setVisible: (visible: boolean) => void
    /** Re-read the prayer, Hijri and verse now. */
    refresh: () => void
    /** Re-pick the icon size for this monitor geometry. */
    relayout: (monitorWidth: number, monitorHeight: number) => void
}

function loadIcon(path: string, size: number): GdkPixbuf.Pixbuf | null {
    try {
        return GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, true)
    } catch {
        return null
    }
}

/**
 * One icon path for the panel and Launchpad (code review §3.6): the
 * shipped file first, falling back to AppService's override store so a
 * user icon override shows on the home screen too — and so a missing
 * shipped file (wrong SHELL_ROOT, the exact failure the sibling hit)
 * degrades to the override instead of a black tile.
 */
function resolveIconPath(app: IPadApp): string | null {
    const direct = ipadIconPath(app)
    if (GLib.file_test(direct, GLib.FileTest.EXISTS)) return direct
    // The override store is keyed by icon name: try the shipped file's
    // stem first, then the desktop ids (a seed under an app's own name).
    const stem = app.iconFile.replace(/\.(svg|png)$/, "")
    for (const key of [stem, ...app.desktopIds]) {
        const override = appService.getIconOverridePath(key)
        if (override) return override
    }
    return direct
}

export default function IPadModePanel(_monitor: Gdk.Monitor): IPadModePanelHandle {
    // (No options: the launch → fullscreen handoff used to ride an
    // `onLaunch` callback here (fix pass #1); it now rides AppService's
    // launch signal, which every launch path arms — see Bar's syncIPad.)
    let iconSize = ICON_LARGE
    let visible = false
    let hintTimer = 0
    let prayerTimer = 0

    // ── Tiles ────────────────────────────────────────────────────────────
    const tileImages = new Map<string, Gtk.Image>()
    const tileButtons = new Map<string, Gtk.Button>()
    // The registry lookup, as a predicate the pure helpers in
    // IPadApps.ts take — one resolver for launch and for the
    // dimmed-tile decision, not two. (Unbound `getAppInfo` would lose
    // its `this`; the closure keeps the singleton.)
    const hasAppInfo = (id: string) => appService.getAppInfo(id) != null

    /**
     * Dim + disarm the tiles whose program is not installed on this
     * machine. Runs at build and on every refresh (the home screen
     * re-checks whenever it shows, so an app installed or removed
     * since boot is picked up without a shell reload — AppService
     * watches the applications dirs and reloads its registry).
     */
    const updateTileAvailability = () => {
        for (const app of IPAD_APPS) {
            const button = tileButtons.get(app.id)
            if (!button) continue
            const unavailable = isIPadTileUnavailable(app, hasAppInfo)
            if (unavailable) button.add_css_class("ipad-tile-unavailable")
            else button.remove_css_class("ipad-tile-unavailable")
            button.sensitive = !unavailable
        }
    }
    const grid = new Gtk.Grid({
        css_classes: ["ipad-grid"],
        column_spacing: 28,
        row_spacing: 36,
        halign: Gtk.Align.CENTER,
    })

    const hint = new Gtk.Label({
        css_classes: ["ipad-hint"],
        halign: Gtk.Align.CENTER,
        wrap: true,
    })
    // Always laid out (opacity 0 when empty) so showing a hint never pushes
    // the grid and the widgets down a row.
    hint.opacity = 0

    const showHint = (text: string) => {
        hint.label = text
        hint.opacity = 1
        if (hintTimer) GLib.source_remove(hintTimer)
        hintTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HINT_MS, () => {
            hintTimer = 0
            hint.opacity = 0
            return GLib.SOURCE_REMOVE
        })
    }

    const launch = (app: IPadApp) => {
        if (app.settings) {
            shellActions.openSettings?.()
            return
        }
        // The `unbuilt` field is the source of truth for "no program
        // behind this tile yet" (code review §3.8) — not the registry
        // lookup in `resolveLaunchId`, which a stale .desktop could
        // satisfy by accident. An unbuilt tile never launches; it says so.
        if (app.unbuilt) {
            showHint(t("ipad.app.coming-soon").replace("{app}", t(`ipad.app.${app.id}` as any)))
            return
        }
        // One resolver for launch and for the dimmed-tile decision
        // (IPadApps.ts): the first desktop id this machine resolves
        // wins, so a tile follows what is actually installed.
        const id = resolveLaunchId(app, hasAppInfo)
        // No program behind this tile on this machine: the tile is
        // dimmed and insensitive, so a tap never reaches here in
        // practice — but if it does (an uninstall racing the tap),
        // stay silent instead of dead-ending on the "coming soon"
        // hint. That hint belongs to the four Islamic tiles only.
        if (!id) return
        // Origin-aware command (gtk-launch / flatpak run) — the app
        // grid's launch path, copied, not reinvented.
        appService.recordLaunch(id)
        execAsync(appService.getLaunchArgv(id)).catch(() => {
            console.warn(`[iPadMode] launch failed for ${id}; launching Exec= directly`)
            appService.getResolvedApp(id)?.launch()
        })
        // The app opens full screen ON TOP of the home screen
        // (Adnan, fix pass #1) — Bar fullscreens the window this
        // launch produces, via AppService's launch signal (every
        // launch path arms it); without it the app would open behind
        // the panel and tapping a tile would visibly do nothing.
        // (`recordLaunch` above is what arms it.)
    }

    IPAD_APPS.forEach((app, i) => {
        // pixel_size is what sizes a pixbuf-backed Gtk.Image in GTK4: a
        // bare image requests the 16px default icon size and paints the
        // 84px pixbuf shrunk into it (caught in the first Xvfb render).
        // The app grid does the same (pixel_size: 72, AppGrid.tsx).
        const image = new Gtk.Image({ css_classes: ["ipad-tile-icon"], pixel_size: ICON_LARGE })
        tileImages.set(app.id, image)
        const label = new Gtk.Label({
            label: t(`ipad.app.${app.id}` as any),
            css_classes: ["ipad-tile-label"],
        })
        // Unbuilt tiles carry a permanent "Soon" badge on the icon
        // corner (UI review must-fix #2): the 4-second transient hint
        // alone left the tiles looking launchable. The badge never
        // disappears; the tile is also dimmed (see _ipad-mode.scss).
        let iconWidget: Gtk.Widget = image
        if (app.unbuilt) {
            const badge = new Gtk.Label({
                label: t("ipad.app.soon"),
                css_classes: ["ipad-tile-soon"],
                halign: Gtk.Align.END,
                valign: Gtk.Align.START,
            })
            const overlay = new Gtk.Overlay({ css_classes: ["ipad-tile-soon-wrap"] })
            overlay.set_child(image)
            overlay.add_overlay(badge)
            iconWidget = overlay
        }
        const cell = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
        })
        cell.append(iconWidget)
        cell.append(label)
        const button = new Gtk.Button({
            css_classes: app.unbuilt ? ["ipad-tile", "ipad-tile-unbuilt"] : ["ipad-tile"],
            child: cell,
        })
        tileButtons.set(app.id, button)
        button.connect("clicked", () => launch(app))
        grid.attach(button, i % 6, Math.floor(i / 6), 1, 1)
    })

    // First paint of availability: tiles with no program behind them
    // on this machine start dimmed and inert, never looking launchable.
    updateTileAvailability()

    // ── Widgets ──────────────────────────────────────────────────────────
    // Next prayer card: name + time (32px, the `.ipad-widget-time` class
    // the v1 panel defined but never used), countdown + date + Hijri.
    const prayerHead = new Gtk.Label({
        label: t("ipad.next-prayer"),
        css_classes: ["ipad-widget-head"],
        halign: Gtk.Align.START,
        xalign: 0,
    })
    const prayerMain = new Gtk.Label({ css_classes: ["ipad-widget-time"], halign: Gtk.Align.START, xalign: 0 })
    const prayerSub = new Gtk.Label({ css_classes: ["ipad-widget-sub"], halign: Gtk.Align.START, xalign: 0, wrap: true })
    const prayerCard = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        css_classes: ["ipad-widget-card"],
    })
    prayerCard.append(prayerHead)
    prayerCard.append(prayerMain)
    prayerCard.append(prayerSub)

    // Verse of the Day card: the label, the full Arabic verse, its
    // English meaning, then its reference. The label is restored (fix
    // pass #1, fidelity #4): v1 showed a block of scripture with no
    // frame, and a first-time user could not tell what the card was.
    const verseHead = new Gtk.Label({
        label: t("ipad.verse-of-day"),
        css_classes: ["ipad-widget-head"],
        halign: Gtk.Align.START,
        xalign: 0,
    })
    // verseText / verseEnglish wrap, but a wrapping label's NATURAL
    // width is still the whole unwrapped line — and the widgets row is
    // homogeneous + FILL, so on a long-verse day (Monday's 24:30, 145
    // chars) the row's natural width blew out to the full 1920px and
    // the panel stopped being the concept's centred ~1040px column.
    // max_width_chars caps the natural width so both cards stay ~512px
    // and long verses wrap to two lines inside the card instead.
    const verseText = new Gtk.Label({
        css_classes: ["ipad-widget-verse"],
        wrap: true,
        max_width_chars: 52,
    })
    // The verse is Arabic in every locale, so its direction is explicit —
    // the same rule rtl.ts states for Quranic text anywhere in the shell.
    verseText.set_direction(Gtk.TextDirection.RTL)
    const verseEnglish = new Gtk.Label({
        css_classes: ["ipad-widget-sub"],
        halign: Gtk.Align.START,
        xalign: 0,
        wrap: true,
        max_width_chars: 52,
    })
    const verseRef = new Gtk.Label({
        css_classes: ["ipad-widget-sub"],
        halign: Gtk.Align.END,
        xalign: 1,
    })
    const verseCard = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        css_classes: ["ipad-widget-card"],
    })
    verseCard.append(verseHead)
    verseCard.append(verseText)
    verseCard.append(verseEnglish)
    verseCard.append(verseRef)

    const widgets = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 16,
        // FILL, not CENTER: halign CENTER would pin the row to its
        // natural width and ignore hexpand, leaving the two cards
        // narrow while the checklist bar below spans the panel. FILL
        // + hexpand stretches the row to the panel width (set by the
        // widest child), so the cards match the concept's full-width
        // row and the homogeneous split makes them equal.
        halign: Gtk.Align.FILL,
        hexpand: true,
        homogeneous: true,
        css_classes: ["ipad-widgets"],
    })
    widgets.append(prayerCard)
    widgets.append(verseCard)

    // Top pill: the mode label, as the concept draws it — a centred
    // translucent pill above the widgets.
    const pill = new Gtk.Label({
        label: t("ipad.pill"),
        css_classes: ["ipad-pill"],
        halign: Gtk.Align.CENTER,
    })

    // Prayer checklist row (private, today only — see PrayerChecklist.ts).
    const checklist = createPrayerChecklistBar()

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 36,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        css_classes: ["ipad-home"],
    })
    root.append(pill)
    root.append(widgets)
    root.append(grid)
    root.append(hint)
    root.append(checklist.widget)

    // ── Live data ────────────────────────────────────────────────────────
    const refreshPrayer = async () => {
        try {
            const out = await execAsync(["veltrix-prayer-times", "--next"], { timeoutMs: PRAYER_TIMEOUT_MS })
            const m = /^([A-Za-z]+) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})$/.exec(out.trim())
            if (!m) throw new Error(`unexpected --next output: ${JSON.stringify(out)}`)
            const name = m[1].toLowerCase()
            const when = GLib.DateTime.new_from_iso8601(m[2], null)
            if (!when) throw new Error(`unparseable --next time: ${m[2]}`)
            const now = GLib.DateTime.new_now_local()
            const nameLabel = t(`prayerlock.prayer.${name}` as any)
            // Main line is name + TIME only (the date moves to the sub):
            // "Fajr · Fri Nov 13 5:53 AM" at 32px shrank the prayer
            // name's presence and crowded the card (fidelity #8).
            const timeFmt = regionConfig.timeFormat === "12h" ? "%I:%M %p" : "%H:%M"
            let timeOnly = when.format(timeFmt) ?? ""
            if (regionConfig.timeFormat === "12h") timeOnly = timeOnly.replace(/^0/, "")
            prayerMain.label = `${nameLabel} · ${foldEasternDigits(timeOnly)}`
            const mins = Math.max(0, Math.round((when.to_unix() - now.to_unix()) / 60))
            const inLabel = mins <= 1
                ? t("ipad.next-prayer.in-one-minute")
                : mins === 2
                    ? t("ipad.next-prayer.in-two-minutes")
                    : mins < 120
                        ? t("ipad.next-prayer.in-minutes").replace("{minutes}", String(mins))
                        : t("ipad.next-prayer.in-hours").replace("{hours}", String(Math.floor(mins / 60))).replace("{minutes}", String(mins % 60))
            const isTomorrow = when.format("%Y-%m-%d") !== now.format("%Y-%m-%d")
            const sub = [isTomorrow ? t("ipad.next-prayer.tomorrow") : inLabel]
            sub.push(foldEasternDigits(formatDatePart(regionConfig.dateFormat, when)))
            const hijri = hijriService.hijri
            if (hijri) sub.push(hijri)
            prayerSub.label = sub.join(" · ")
        } catch (e) {
            // Real data or nothing: a failed read never shows a stale time.
            console.warn("[iPadMode] next prayer unavailable:", e)
            prayerMain.label = t("ipad.next-prayer.unavailable")
            prayerSub.label = ""
        }
    }

    const refreshVerse = () => {
        const verse = verseOfDay()
        verseText.label = verse.arabic
        verseEnglish.label = verse.english
        verseRef.label = verseReference(verse)
    }

    const refresh = () => {
        void refreshPrayer()
        refreshVerse()
        checklist.refresh()
        updateTileAvailability()
    }

    // The prayer card reads the Hijri date from the service; the service
    // is started here so the card has it even if the bar has not
    // started it yet (the bar starts it too — start() is idempotent).
    hijriService.start()

    const setVisible = (v: boolean) => {
        if (visible === v) return
        visible = v
        root.visible = v
        if (v) {
            refresh()
            if (!prayerTimer) {
                prayerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRAYER_POLL_MS, () => {
                    void refreshPrayer()
                    return GLib.SOURCE_CONTINUE
                })
            }
        } else {
            if (prayerTimer) { GLib.source_remove(prayerTimer); prayerTimer = 0 }
        }
    }

    const relayout = (monitorWidth: number, monitorHeight: number) => {
        const size = monitorWidth < 1400 || monitorHeight < 800 ? ICON_SMALL : ICON_LARGE
        if (size === iconSize) return
        iconSize = size
        for (const app of IPAD_APPS) {
            const image = tileImages.get(app.id)
            if (!image) continue
            const path = resolveIconPath(app)
            const pb = path ? loadIcon(path, iconSize) : null
            if (pb) image.set_from_pixbuf(pb)
            image.pixel_size = iconSize
        }
        grid.column_spacing = size === ICON_LARGE ? 28 : 20
        grid.row_spacing = size === ICON_LARGE ? 36 : 24
    }

    // First paint of the icons, at the large size; Bar calls relayout() with
    // the real geometry right after construction.
    for (const app of IPAD_APPS) {
        const image = tileImages.get(app.id)
        const path = resolveIconPath(app)
        const pb = path ? loadIcon(path, ICON_LARGE) : null
        if (image && pb) image.set_from_pixbuf(pb)
    }

    root.visible = false
    return { widget: root, setVisible, refresh, relayout }
}
