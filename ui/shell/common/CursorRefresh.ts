import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import compositor from "../core/CompositorState"
import { safeDisconnect } from "../core/signals"

/**
 * A new cursor theme or size does not reach the cursor already on screen — the
 * setting appears to arrive only when the pointer leaves the window it was changed
 * from. This puts it on screen immediately.
 *
 * 🔑 **The one law behind all of it: Hyprland redraws the cursor only when it sees a
 * different shape NAME.** Not when the theme is reloaded, not when the cursor is
 * hidden and shown again. `IHyprRenderer::setCursorFromName` (0.56.2, and identical on
 * `main`) opens with `if (name == m_lastCursorData.name && !force) return;`, and
 * `changeTheme()` only reloads the theme and schedules frames — so those frames
 * repaint the OLD picture. Measured, pointer parked and never moved:
 *
 *     Adwaita on screen                  →  112 cursor px
 *     hyprctl setcursor Qogir-Dark       →  112   (the bug)
 *     toggle cursor:invisible off and on →  112   (does NOT repaint)
 *     a crossing that changes the NAME   →  147   (the only thing that does)
 *
 * A name is what `wp_cursor_shape_v1` carries, so this is not a trick: naming the
 * shape again is the protocol's own way of saying "draw the pointer". We bounce
 * through a different shape and straight back, in one main-loop iteration — the
 * compositor applies both in one pass, so the intermediate is never composited and
 * nothing flickers. GDK compares cursors by EQUALITY, so it has to be a different
 * shape; a fresh `Gdk.Cursor` with the same name puts nothing on the wire.
 *
 * ⚠️ **Scope.** Only the client holding pointer focus may name a shape
 * (`InputManager.cpp:68-72`), so this reaches Veltrix's surfaces, not third-party apps.
 * The case where nobody holds it — right after a dropdown's popover closes — is handled
 * by `refreshAfterRefocus`; read it, it is the subtlest part of this file.
 *
 * ⚠️ **The same scope is why a change made in Settings can look dead.** Settings is
 * its own process, so the pointer is over the Settings window — not a shell surface —
 * while the user drags the cursor-size slider, and `refreshShellCursor` below finds
 * nothing to bump, however long it waits. The repaint therefore has two more legs,
 * both in this file:
 *
 *   - `bindSettingsCursorRefresh(win)` — the Settings process bumps the shape on its
 *     OWN window, once the shell's `hyprctl setcursor` has landed (a short settle,
 *     then a backstop). That is the leg that makes a slider drag repaint in place.
 *   - a pending repaint (`bindCursorRepaintOnEnter`) — when a change fires while the
 *     pointer is over a third-party app (or the desktop at login), the shell remembers
 *     it and bumps the shape the next time the pointer enters the bar or the dock.
 *     Without it the change waits for a chance shape-changing crossing that may
 *     never come, and the new size reads as "does nothing".
 *
 * ⚠️ **Never verify this with a screenshot.** See the cursor section of
 * `references/dev-workflow.md`: `grim -c` only refreshes its copy on the pointer-focus
 * path, which is exactly what this avoids needing.
 */
function bump(w: Gtk.Widget) {
    const had = w.get_cursor()
    const via = had?.get_name() === "crosshair" ? "text" : "crosshair"
    w.set_cursor(Gdk.Cursor.new_from_name(via, null))
    w.set_cursor(had)
}

/** Re-issue the cursor on the widget under the pointer within `native`.
 *  Surface coordinates are not widget coordinates — a native's widget origin is
 *  inset by its shadow, and `pick` wants the latter. Returns false when there
 *  was nothing to re-issue it on. */
function bumpAt(native: Gtk.Native, sx: number, sy: number): boolean {
    const [tx, ty] = native.get_surface_transform()
    const root = native as unknown as Gtk.Widget

    // GTK resolves a surface's cursor from the widget under the pointer upwards, so
    // bump whichever widget actually owns it — several Settings rows set their own.
    let owner: Gtk.Widget | null = root.pick(sx - tx, sy - ty, Gtk.PickFlags.DEFAULT)
    while (owner && !owner.get_cursor()) owner = owner.get_parent()
    bump(owner ?? root)
    // One line per cursor setting change. Worth it: this mechanism is invisible by
    // construction — when it does not run there is simply nothing to see.
    console.log(`[CursorRefresh] re-issued on ${root.name || root.constructor?.name}`)
    return true
}

/** Re-issue the cursor on whichever of our surfaces the pointer is in.
 *  Returns false when there was nothing to re-issue it on — see `refreshAfterRefocus`. */
export function refreshShellCursor(): boolean {
    try {
        const pointer = Gdk.Display.get_default()?.get_default_seat()?.get_pointer()
        const [surface, sx, sy] = pointer?.get_surface_at_position() ?? []
        if (!surface) return false

        const native = Gtk.Native.get_for_surface(surface)
        if (!native) return false
        // A dead popover: GDK keeps naming it long after the popup is destroyed, and
        // setting a cursor on an unmapped widget puts nothing on the wire.
        if (!(native as unknown as Gtk.Widget).get_mapped()) return false

        return bumpAt(native, sx, sy)
    } catch (e) {
        console.error("[CursorRefresh]", e)
        return false
    }
}

/**
 * Re-issue the cursor on ONE window — the Settings window, in the Settings process.
 * The shell's `refreshShellCursor` cannot see it (another process owns the surface),
 * so Settings bumps its own. Returns false when the pointer is not over `win` at all.
 */
export function refreshCursorOn(win: Gtk.Window): boolean {
    try {
        const pointer = Gdk.Display.get_default()?.get_default_seat()?.get_pointer()
        const [surface, sx, sy] = pointer?.get_surface_at_position() ?? []
        if (!surface) return false

        const native = Gtk.Native.get_for_surface(surface)
        if (!native) return false
        // Only this window: a popover of another app, or a shell surface, is not
        // ours to name — and naming it would put nothing on the wire anyway.
        if ((native as unknown as Gtk.Widget) !== (win as unknown as Gtk.Widget)) return false
        if (!win.get_mapped()) return false

        return bumpAt(native, sx, sy)
    } catch (e) {
        console.error("[CursorRefresh]", e)
        return false
    }
}

// A cursor change whose repaint never ran — the pointer was over a third-party app
// (or the desktop at login) when it fired, so there was no shell surface to bump on.
// It stays set until a bump succeeds; see `bindCursorRepaintOnEnter`.
let repaintPending = false

/**
 * Re-issue the cursor the next time the pointer enters a shell surface, if a
 * repaint is still pending. Attach to each bar/dock window at creation (and to a
 * rebuilt dock — a new window gets a new controller). The enter is the moment the
 * bump CAN run: the pointer is over a surface of ours, which is the precondition
 * `refreshShellCursor` needs and the change itself could not wait for.
 */
export function bindCursorRepaintOnEnter(win: Gtk.Window): () => void {
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
        if (!repaintPending) return
        if (refreshShellCursor()) repaintPending = false
    })
    win.add_controller(motion)
    return () => win.remove_controller(motion)
}

/**
 * Close the one state nothing else can: nobody holds pointer focus.
 *
 * Picking the cursor THEME goes through a `Gtk.DropDown`, and choosing an item
 * destroys its popover — the surface the pointer was in. Hyprland does not hand the
 * focus to the window underneath, because it only re-runs that pass on pointer motion
 * and the pointer has not moved. Two facts then hold at once, and neither is fixable
 * alone:
 *
 *   - Nobody holds pointer focus, so there is no surface on which to name a shape.
 *     Verified on the wire across three selections with no human input: no `enter`
 *     ever arrives while the mouse is still. ⛔ A settling timer finds nothing however
 *     long it waits — that was tried and measured.
 *   - When the pointer does come back, GTK names `default`, which is the name Hyprland
 *     already has, and its dedupe throws a repeat away. So the focus returning does not
 *     repaint either.
 *
 * So ask the compositor to re-decide what is under the pointer (`reevaluatePointerFocus`
 * — a warp to where the pointer already is; it does not move and no input is
 * synthesised), and re-issue once it has. Measured end to end: `leave(dead popover)` →
 * `enter(parent window)` → our `set_shape(crosshair)` → `set_shape(default)`.
 *
 * ⚠️ Pointer focus cannot be requested by a client. There is no Wayland protocol for
 * it — the compositor assigns it by pointer position alone, which is why this has to
 * go through the compositor at all. `common/FocusGrab.ts` grabs the KEYBOARD, a
 * different seat capability, and is no help here.
 */
const SETTLE_MS = 120

async function refreshAfterRefocus(): Promise<boolean> {
    await compositor.reevaluatePointerFocus()
    // The `enter` is on the wire by now; give the main loop one turn to read it before
    // asking GDK where the pointer is.
    return new Promise<boolean>((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            resolve(refreshShellCursor())
            return GLib.SOURCE_REMOVE
        })
    })
}

/**
 * Bind it to the moment the compositor has the new theme.
 *
 * `cursor-applied` fires only once `hyprctl setcursor` has resolved: a refresh issued
 * before that faithfully re-issues the OLD picture. `Gtk.Settings` is bound too, for a
 * `gsettings set` from a terminal that ThemeManager never sees.
 */
export function bindCursorThemeRefresh(theme: any): () => void {
    const refresh = () => {
        if (refreshShellCursor()) { repaintPending = false; return }
        // Nothing of ours under the pointer right now: remember it, so the next
        // enter into the bar or the dock (bindCursorRepaintOnEnter) still repaints.
        repaintPending = true
        void refreshAfterRefocus().then((ok) => { if (ok) repaintPending = false })
    }
    const id = theme.connect("cursor-applied", refresh)

    const settings = Gtk.Settings.get_default()
    const ids = settings
        ? (["notify::gtk-cursor-theme-size", "notify::gtk-cursor-theme-name"] as const)
              .map((sig) => settings.connect(sig, refresh))
        : []

    return () => {
        safeDisconnect(theme, id)
        if (settings) ids.forEach((i) => safeDisconnect(settings, i))
    }
}

/**
 * The Settings process's half of the repaint — call once with the Settings window.
 *
 * The shell owns applying the theme/size (`hyprctl setcursor`, AppearanceSync), but
 * it cannot name a shape on the Settings window: another process owns that surface,
 * and only the client holding pointer focus may name one. So when the user drags the
 * cursor-size slider, the shell's refresh finds nothing to bump on — the pointer is
 * here, in Settings — and the new size never reaches the live cursor until the
 * pointer happens to cross a widget with a different shape. This bumps the shape on
 * Settings' own window instead.
 *
 * Timing: the bump must land AFTER the shell's `hyprctl setcursor` has resolved — a
 * bump issued before that faithfully re-issues the OLD picture (the same trap the
 * shell's `cursor-applied` signal exists to avoid). Settings cannot see that signal
 * (another process), so it waits: the shell applies on the next main-loop turn after
 * the gsettings write, a local `hyprctl` call that resolves in tens of milliseconds,
 * so 400 ms covers it with margin and the 1500 ms backstop covers a loaded machine.
 * An enter into the window while a change is pending bumps at once as well — by then
 * the setcursor is certainly in force. Both bumps are the same invisible same-turn
 * shape bounce as `bump` above; a bump that lands early is a no-op, never a wrong size.
 */
const SETTINGS_SETTLE_MS = 400
const SETTINGS_BACKSTOP_MS = 1500

export function bindSettingsCursorRefresh(win: Gtk.Window): () => void {
    let pending = false
    let timers: number[] = []
    const bump = () => { refreshCursorOn(win) }
    const arm = () => {
        pending = true
        timers.forEach((t) => GLib.source_remove(t))
        timers = [
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTINGS_SETTLE_MS, () => { bump(); return GLib.SOURCE_REMOVE }),
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTINGS_BACKSTOP_MS, () => { pending = false; bump(); return GLib.SOURCE_REMOVE }),
        ]
    }

    const settings = Gtk.Settings.get_default()
    const ids = settings
        ? (["notify::gtk-cursor-theme-size", "notify::gtk-cursor-theme-name"] as const)
              .map((sig) => settings.connect(sig, arm))
        : []

    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => { if (pending) bump() })
    win.add_controller(motion)

    return () => {
        timers.forEach((t) => GLib.source_remove(t))
        timers = []
        if (settings) ids.forEach((i) => safeDisconnect(settings, i))
        win.remove_controller(motion)
    }
}
