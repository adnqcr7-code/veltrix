// SPDX-License-Identifier: LGPL-3.0-or-later
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Graphene from "gi://Graphene"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { kitAppearance } from "../appearance"

/**
 * The client half of veltrix-window-controls-v1 (`protocols/` at the repository root, #708
 * point 5): on a compositor of our own (Hyalo) a window's controls — close, minimize,
 * maximize — are the compositor's. It draws them, the same in every window, over the app's
 * own header, and takes their clicks; the app only leaves room for them. The compositor
 * says how big the room is and on which side it goes (the user's setting); the window has
 * SLOTS — places that can hold it, each saying for which side and in which state of the
 * layout it is the one — and the first slot that applies gets the room, and its position is
 * sent with every frame that moves it (the frame clock's layout phase, so it lands with the
 * buffer that left the room).
 *
 * Where the compositor draws none (Hyprland), nothing changes: the slots stay hidden and the
 * window's own controls (its FALLBACK) are shown, as before — plain, normal buttons
 * (`normalWindowControls` below): the standard symbolic icons, always visible, no
 * colours, no circles. Their actions are the standard ones:
 *
 *   - CLOSE = close the window (`win.close()` → the close policy: for every window
 *     shipped on the desktop that IS the immediate close — Settings quits on close;
 *     About is destroyed). The installer's deliberate mid-install refusal is the one
 *     exception and is kept on purpose: killing a live disk install with one stray
 *     click would corrupt it.
 *   - MINIMIZE = hide the window (`win.hide()` — the window goes away but the app
 *     keeps running in the background; reopening the app (dock, launcher)
 *     presents the hidden window again). NOT a kill.
 *   - MAXIMIZE = standard maximize (`win.maximize()` / `win.unmaximize()` — the
 *     window fills the working area WITHOUT covering the bar, so its header
 *     controls stay reachable. NOT fullscreen: fullscreen is entered deliberately
 *     (Super+Shift+F, the app's own F11, the bar's window menu) and left through
 *     the bar's Exit fullscreen button, because a fullscreen window's own header
 *     sits under the bar when the bar is revealed over it (2026-11-13).
 *
 * The fallback sits on the side the user's `button-layout` says (read live, and
 * re-read when the key changes), the same side the compositor's controls would
 * take. Third-party GTK apps (Files, etc.) are NOT covered: they draw their own
 * title-bar buttons from the same `button-layout` key, with GTK's default look
 * and GTK's built-in actions — the shell does not paint or rewire them.
 *
 * Loaded lazily and tolerated missing, like the material: a checkout updated without
 * reinstalling libveltrix-wl keeps its own buttons.
 */

export type ControlsSide = "right" | "left"

/** A window's buttons. Close is always there; the compositor also leaves out what the user did
 *  not choose and what the window cannot do (no maximize when it cannot change size). */
export type WindowButton = "close" | "minimize" | "maximize"

/** The protocol's `button` bits. */
const BUTTON_BIT: Record<WindowButton, number> = { close: 1, minimize: 2, maximize: 4 }

export type ControlsSlot = {
    widget: Gtk.Widget
    /** Whether this slot holds the controls now, for the user's side. */
    when: (side: ControlsSide) => boolean
}

/**
 * A fallback widget, shown where the compositor draws no controls — a plain widget,
 * or one that only shows while `when` holds (a normal-buttons row that lives in
 * the sidebar's top while the sidebar is docked, and in the header otherwise: the
 * same two places, the same conditions, as the slots).
 */
export type ControlsFallback = Gtk.Widget | { widget: Gtk.Widget, when: () => boolean }

type NormalizedFallback = { widget: Gtk.Widget, when: (() => boolean) | null }

function asFallback(f: ControlsFallback): NormalizedFallback {
    return f instanceof Gtk.Widget ? { widget: f, when: null } : { widget: f.widget, when: f.when }
}

/** The standard window-control icons (GTK's own symbolic names — the same ones GTK's
 *  header bars use, so they resolve in any icon theme). Always visible: no
 *  hover-reveal, no colours, no circles. */
const BUTTON_ICON: Record<WindowButton, string> = {
    close: "window-close-symbolic",
    minimize: "window-minimize-symbolic",
    maximize: "window-maximize-symbolic",
}
/** The accessible names (plain strings, as the kit's other labels are). */
const BUTTON_LABEL: Record<WindowButton, string> = { close: "Close", minimize: "Minimize", maximize: "Maximize" }

/**
 * Normal window buttons: plain `veltrix-icon-btn` buttons with the standard symbolic
 * icons, always visible. The FALLBACK where the compositor draws no controls — it never
 * shows where the protocol is offered, so it never sits beside the compositor's own
 * controls. Actions are the standard ones: close runs the window's close policy,
 * minimize hides the window (the app keeps running; reopening it presents the hidden
 * window), maximize toggles standard maximize — the window fills the working area
 * WITHOUT covering the bar, so the header stays reachable (unlike fullscreen).
 * `buttons` mirrors what the caller offers the compositor (an About window:
 * `["close"]`); every one if left out.
 */
export function normalWindowControls(win: Gtk.Window, buttons: WindowButton[] = ["close", "minimize", "maximize"]): Gtk.Widget {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 4,
        valign: Gtk.Align.CENTER,
        css_classes: ["veltrix-window-controls"],
        can_target: false,
    })
    for (const b of buttons) {
        const btn = new Gtk.Button({ css_classes: ["veltrix-icon-btn", "veltrix-window-control"] })
        const icon = new Gtk.Image({ icon_name: BUTTON_ICON[b], pixel_size: 16, css_classes: ["nd-icon"] })
        btn.set_child(icon)
        btn.update_property([Gtk.AccessibleProperty.LABEL], [BUTTON_LABEL[b]])
        if (b === "close") {
            btn.connect("clicked", () => win.close())
        } else if (b === "minimize") {
            // Hide: the window goes away, the app keeps running in the background.
            // Reopening the app presents the hidden window again (Settings' open
            // handler calls `window.present()`). NOT a kill.
            btn.connect("clicked", () => win.hide())
        } else {
            // Maximize (standard): fills the working area, bar stays visible, so the
            // header — and this button — stay reachable. The icon follows the state.
            const updateIcon = () => {
                const maximized = win.is_maximized()
                icon.set_from_icon_name(maximized ? "window-restore-symbolic" : "window-maximize-symbolic")
                btn.update_property([Gtk.AccessibleProperty.LABEL], [maximized ? "Restore" : "Maximize"])
            }
            btn.connect("clicked", () => {
                if (win.is_maximized()) win.unmaximize()
                else win.maximize()
                updateIcon()
            })
            win.connect("notify::maximized", updateIcon)
            updateIcon()
        }
        row.append(btn)
    }
    return row
}

/** The side the user's window buttons go on, from the one key every app that draws its
 *  own title bar reads (`org.gnome.desktop.wm.preferences button-layout`): the half
 *  `close` is in. The fallback's placement follows it, the same side the compositor's
 *  controls would take. */
export function readControlsSide(): ControlsSide {
    try {
        const layout = wmSettings().get_string("button-layout") ?? ""
        const [left = ""] = layout.split(":")
        return left.split(",").map(s => s.trim()).includes("close") ? "left" : "right"
    } catch {
        return "right"
    }
}

let wmPrefs: InstanceType<typeof Gio.Settings> | null = null
function wmSettings(): InstanceType<typeof Gio.Settings> {
    // Held for the life of the process: an unreferenced Gio.Settings is collected
    // with its handlers.
    wmPrefs ??= new Gio.Settings({ schema_id: "org.gnome.desktop.wm.preferences" })
    return wmPrefs
}

type Shim = {
    init(): boolean
    has_window_controls?(): boolean
    window_controls_set_layout_func?(f: (surface: Gdk.Surface, side: number, w: number, h: number) => void): void
    window_controls_request?(surface: Gdk.Surface): boolean
    window_controls_set_position?(surface: Gdk.Surface, x: number, y: number): boolean
    window_controls_unset_position?(surface: Gdk.Surface): void
    window_controls_set_buttons?(surface: Gdk.Surface, buttons: number): boolean
    window_controls_set_ink?(surface: Gdk.Surface, dark: boolean): boolean
}

const SHIM_MODULE = "gi://VeltrixWl"   // in a variable on purpose: see VisibleRegion.ts

type Layout = { side: ControlsSide, width: number, height: number }

class Controller {
    layout: Layout | null = null
    /** The position last sent, or "" for none. */
    sent = "\u0000"
    surface: Gdk.Surface | null = null
    tick = 0
    /** The ink last sent (null: none yet), and the appearance subscription that resends it. */
    ink: boolean | null = null
    offAppearance: (() => void) | null = null

    constructor(
        readonly win: Gtk.Window,
        readonly slots: ControlsSlot[],
        fallbacks: ControlsFallback[],
        readonly buttons: WindowButton[] | null,
    ) {
        this.fallbacks = fallbacks.map(asFallback)
    }

    readonly fallbacks: NormalizedFallback[]

    /** The compositor's layout (or none): which widgets show. Out of the frame clock. */
    refresh() {
        const l = this.layout
        for (const f of this.fallbacks) f.widget.visible = !l && (!f.when || f.when())
        let taken = false
        for (const s of this.slots) {
            const on = !!l && !taken && s.when(l.side)
            if (on) taken = true
            s.widget.visible = on
            if (l) s.widget.set_size_request(Math.ceil(l.width), Math.ceil(l.height))
        }
        this.win.queue_allocate()
    }

    /** Where the active slot is, surface-local: sent when it moved. In the layout phase. */
    place() {
        const surface = this.surface
        if (!surface || !shim || !this.layout) return
        const slot = this.slots.find(s => s.widget.visible && s.widget.get_mapped())
        let key = ""
        let x = 0, y = 0
        if (slot) {
            const [ok, p] = slot.widget.compute_point(this.win, new Graphene.Point({ x: 0, y: 0 }))
            if (ok) {
                const [tx, ty] = this.win.get_surface_transform()
                x = p.x + tx
                y = p.y + ty
                key = `${x.toFixed(2)},${y.toFixed(2)}`
            }
        }
        if (key === this.sent) return
        this.sent = key
        if (key) shim.window_controls_set_position?.(surface, x, y)
        else shim.window_controls_unset_position?.(surface)
    }

    /** The controls' ink follows the window's own appearance: dark over a light header (owner,
     *  2026-10-08 — white glyphs on Settings' light header were invisible). */
    sendInk() {
        const surface = this.surface
        if (!surface || !shim) return
        const dark = !kitAppearance().surfaceIsDark(this.win)
        if (dark === this.ink) return
        this.ink = dark
        shim.window_controls_set_ink?.(surface, dark)
    }

    attach() {
        const surface = this.win.get_surface()
        if (!surface || !shim?.window_controls_request?.(surface)) return
        this.surface = surface
        controllers.set(surface, this)
        // Before its first position: the box the compositor answers with is already this one's.
        if (this.buttons)
            shim.window_controls_set_buttons?.(surface, this.buttons.reduce((m, b) => m | BUTTON_BIT[b], 0))
        this.sendInk()
        this.offAppearance ??= kitAppearance().onChange(() => this.sendInk())
        const clock = surface.get_frame_clock()
        if (clock && !this.tick) this.tick = clock.connect_after("layout", () => this.place())
    }

    detach() {
        if (this.surface) {
            controllers.delete(this.surface)
            if (this.tick) this.surface.get_frame_clock()?.disconnect(this.tick)
        }
        this.offAppearance?.()
        this.offAppearance = null
        this.ink = null
        this.tick = 0
        this.surface = null
        this.sent = "\u0000"
    }
}

let shim: Shim | null = null
let loadStarted = false
const pending: Controller[] = []
const controllers = new Map<Gdk.Surface, Controller>()

function load() {
    if (shim || loadStarted) return
    loadStarted = true
    import(SHIM_MODULE)
        .then(mod => {
            const wl = (mod.default ?? mod) as unknown as Shim
            if (!wl.init() || !wl.has_window_controls?.()) return
            shim = wl
            wl.window_controls_set_layout_func?.((surface, side, width, height) => {
                const c = controllers.get(surface)
                if (!c) return
                c.layout = { side: side === 1 ? "left" : "right", width, height }
                c.sent = "\u0000"
                c.refresh()
            })
            for (const c of pending.splice(0)) if (c.win.get_realized()) c.attach()
        })
        .catch(e => console.log(`[WindowControls] unavailable: ${e}`))
}

/**
 * Lets the compositor draw `win`'s controls in one of `slots` — or, where it draws none,
 * leaves `fallbacks` (the window's own normal buttons) as they are. The slots start hidden.
 * Call `refresh` when the layout a slot's `when` reads changes (a sidebar shown or hidden).
 * `buttons`: the only ones this window has (an About window: `["close"]`); every one if left out.
 *
 * The fallback's side follows the user's `button-layout`: a fallback whose `when` reads
 * `readControlsSide()` is re-read here whenever the key changes (Settings → Appearance →
 * Windows, or anywhere else), so the normal buttons move from one end of the header to
 * the other live. (The compositor's own controls follow it through the layout func; the
 * fallback has no layout on Hyprland, so it needs its own subscription.) The subscription
 * is disconnected when the window is destroyed.
 */
export function attachWindowControls(
    win: Gtk.Window,
    slots: ControlsSlot[],
    fallbacks: ControlsFallback[],
    buttons?: WindowButton[],
): { refresh: () => void } {
    for (const s of slots) s.widget.visible = false
    const c = new Controller(win, slots, fallbacks, buttons ?? null)
    if (GLib.getenv("VELTRIX_WINDOW_CONTROLS") === "0") return { refresh: () => {} }
    win.connect("realize", () => { if (shim) c.attach(); else pending.push(c) })
    win.connect("unrealize", () => { c.detach(); c.layout = null; c.refresh() })
    if (win.get_realized()) pending.push(c)
    load()
    let sideSub = 0
    try {
        sideSub = wmSettings().connect("changed::button-layout", () => c.refresh())
        win.connect("destroy", () => { if (sideSub) wmSettings().disconnect(sideSub); sideSub = 0 })
    } catch {
        // No wm preferences schema (a bare test env): the fallback keeps the side it
        // was built with, and nothing else breaks.
    }
    // No `if (c.layout)` guard: a fallback's `when` (a normal-buttons row moving
    // between the sidebar's top and the header) has to be re-read when the sidebar
    // presents or collapses, and on a compositor that draws no controls there is
    // never a layout — the guard made `refresh` a no-op exactly where it matters.
    return { refresh: () => c.refresh() }
}

/** An empty slot: the room the controls take, with its alignment in the row. */
export function controlsSlotWidget(halign: Gtk.Align = Gtk.Align.CENTER): Gtk.Box {
    return new Gtk.Box({ name: "veltrix-window-controls-slot", valign: Gtk.Align.CENTER, halign, can_target: false })
}
