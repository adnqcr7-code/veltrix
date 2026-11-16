import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import GLib from "gi://GLib"
import { barItem, barOpen, isBarCustomAnchor, setBarItemKey } from "./capsule"
import compositor, { type CompositorWindow } from "../../core/CompositorState"
import appService from "../../core/AppService"
import { t } from "../../core/i18n"
import status from "../../core/Status"
import shellActions from "../../core/ShellActions"
import buildWindowMenu from "./WindowMenu"
import { BAR_TEXT_PAD } from "../../common/widget-kit"

// openMenu: opens arbitrary content in the bar's shared expansion capsule,
// anchored under the given widget. Injected by Bar (same pattern as Tray).
type OpenMenu = (anchor: Gtk.Widget, build: (onClose: () => void) => Gtk.Widget, align?: "center" | "start") => void

// Bar-left item (the left group, beside the system menu) naming the focused window's APP, as
// the app grid names it — never the window's title, which every window carries in its own
// title bar. Clicking it (any button) opens the window-options menu (WindowMenu.ts).
export interface AppTitleHandle {
  widget: Gtk.Widget
  /** Re-derive the label's cap after a resolution change. */
  setMonitorWidth: (px: number) => void
  /** Dynamically constrain the label's maximum allocated width in pixels so it never collides with the island. */
  /** `immediate` skips the ~180ms approach: for when something else is about to
   *  take the space in the same frame (the bar's overflow unfolding in line). */
  setMaxWidth: (px: number, immediate?: boolean) => void
}

const PAD_PX = 2 * BAR_TEXT_PAD // margin_start + margin_end

/**
 * What the capsule says. A window: its app's name (`appNameForWindow`). No window: the
 * desktop — "Desktop", never a number (Phase 1 fix: "Desktop 3" leaked the workspace
 * number into the bar, the single most visible "this is Linux" tell after the Apple
 * menu. The dots already show which desktop you are on; the name does not repeat it).
 */
export function appTitleText(client: CompositorWindow | null): string {
  if (client) return appService.appNameForWindow(client)
  return t("overview.workspace")
}

/**
 * Uses Pango layout to measure the exact rendered width in pixels of the text,
 * finding the maximal substring that fits inside maxPx with an ellipsis.
 */
function fitTextToPixels(widget: Gtk.Widget, text: string, maxPx: number): string {
  if (!text || maxPx <= 0) return ""
  const layout = widget.create_pango_layout(text)
  if (!layout) return text
  const [fullW] = layout.get_pixel_size()
  if (fullW <= maxPx) return text

  const ellipsis = "…"
  let low = 1
  let high = text.length
  let best = text.slice(0, 1) + ellipsis

  while (low <= high) {
    const mid = (low + high) >> 1
    const candidate = text.slice(0, mid) + ellipsis
    layout.set_text(candidate, -1)
    const [w] = layout.get_pixel_size()
    if (w <= maxPx) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

export function AppTitle(monitorWidth: number, openMenu?: OpenMenu): AppTitleHandle {
  let targetBudgetPx = Math.max(100, (monitorWidth / 2) - 200)
  let currentBudgetPx = targetBudgetPx
  let rawTitle = "—"
  let animTickId: number | null = null

  const appName = new Gtk.Label({
    label: "—",
    css_classes: ["bar-app-name"],
    margin_start: BAR_TEXT_PAD,
    margin_end: BAR_TEXT_PAD,
  })

  const updateLabel = () => {
    const maxTextPx = Math.max(20, currentBudgetPx - PAD_PX)
    const fitted = fitTextToPixels(appName, rawTitle, maxTextPx)
    if (appName.label !== fitted) appName.label = fitted
  }

  // Open while the window menu it anchors is down (the item IS the anchor).
  const capsule: Gtk.Widget = barItem({ child: appName, ...barOpen(() => isBarCustomAnchor(capsule)) })

  // ── The pill is the window's drag handle on Hyprland ──────────────────────
  // kitty has no title bar to grab on the shipped session: Hyprland answers
  // "server-side" to its decoration request and then draws nothing (see
  // hyalo/compositor/src/shell/decoration.rs — "which draws none"), and no
  // kitty.conf value can make kitty draw its own bar there (its CSD appears
  // only where the compositor does NOT answer server-side). So the drag handle
  // lives here, on the pill that already names the focused window: dragging it
  // moves that window, through `compositor.moveWindowTo` — absolute pixels, from
  // the position the drag STARTED at, never the live one mid-drag (the
  // compositor's own clamping does the rest). On Hyalo the pill does NOT drag
  // (`caps.pixelMove` is false there): Hyalo draws its own draggable title bar
  // over the window, kitty included, and a second handle would be a duplicate.
  // Super+drag anywhere on the window still works on both compositors.
  //
  // The tooltip names the drag, but ONLY when one would actually work — a
  // tooltip promising a drag on a tiled window, or on Hyalo, would be a lie
  // the user discovers by trying. (It used to carry the window's whole title;
  // the label is the app's name now and the title is in the window's own bar,
  // so a title tooltip would only repeat one or the other.)
  let dragMoved = false
  let dragAddr = ""
  let dragStartX = 0
  let dragStartY = 0
  let dragLastX = 0
  let dragLastY = 0

  const dragGesture = new Gtk.GestureDrag()
  dragGesture.connect("drag-begin", () => {
    if (status.cc_edit_mode) { dragGesture.set_state(Gtk.EventSequenceState.DENIED); return }
    const client = compositor.focusedClient
    // Only a floating, non-fullscreen window on a compositor that moves by
    // pixels: a tiled window stays put until it is floated, and a maximized or
    // fullscreen one is not a thing you drag.
    if (!client || !compositor.caps.pixelMove || !client.floating || client.fullscreen !== 0) {
      dragGesture.set_state(Gtk.EventSequenceState.DENIED)
      return
    }
    dragAddr = client.address
    dragStartX = client.x
    dragStartY = client.y
    dragLastX = client.x
    dragLastY = client.y
    dragMoved = true
  })
  dragGesture.connect("drag-update", () => {
    if (!dragMoved) return
    const [ok, offX, offY] = dragGesture.get_offset()
    if (!ok) return
    const tx = Math.round(dragStartX + offX)
    const ty = Math.round(dragStartY + offY)
    // One dispatch per pixel the target actually moved: motion events arrive
    // per frame, and a dispatch is a hyprctl spawn — identical targets would
    // be a storm of no-ops.
    if (tx === dragLastX && ty === dragLastY) return
    dragLastX = tx
    dragLastY = ty
    compositor.moveWindowTo(dragAddr, tx, ty)
  })
  dragGesture.connect("drag-end", () => {
    if (!dragMoved) return
    // Defer the flag reset so the click gesture's released (which fires in the
    // same event batch) still sees dragMoved and skips opening the menu — the
    // DockItem pattern for drag-vs-click on one widget.
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { dragMoved = false; return GLib.SOURCE_REMOVE })
  })
  capsule.add_controller(dragGesture)

  const startBudgetAnimation = (targetPx: number) => {
    targetBudgetPx = targetPx
    if (Math.abs(currentBudgetPx - targetBudgetPx) < 1) {
      currentBudgetPx = targetBudgetPx
      updateLabel()
      return
    }

    if (animTickId !== null) return

    let lastTimeUs = 0
    animTickId = capsule.add_tick_callback((_, clock) => {
      const now = clock.get_frame_time()
      if (lastTimeUs === 0) {
        lastTimeUs = now
        return GLib.SOURCE_CONTINUE
      }
      const dt = Math.min(0.05, (now - lastTimeUs) / 1_000_000)
      lastTimeUs = now

      const diff = targetBudgetPx - currentBudgetPx
      if (Math.abs(diff) < 1) {
        currentBudgetPx = targetBudgetPx
        updateLabel()
        animTickId = null
        return GLib.SOURCE_REMOVE
      }

      // Smooth exponential approach (~180ms settling)
      currentBudgetPx += diff * (1 - Math.exp(-16 * dt))
      updateLabel()
      return GLib.SOURCE_CONTINUE
    })
  }

  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    const sync = () => {
      const label = appTitleText(compositor.focusedClient) || "—"
      if (label !== rawTitle) {
        rawTitle = label
        updateLabel()
      }
      // The drag tooltip follows the window the pill would move: only a floating,
      // non-fullscreen window on a pixel-moving compositor is draggable.
      const client = compositor.focusedClient
      const draggable = !!client && compositor.caps.pixelMove && client.floating && client.fullscreen === 0
      capsule.set_tooltip_text(draggable ? t("bar.app-title.drag-hint") : null)
    }

    // "changed" alone: it fires when focus, the workspace or a window's class moves.
    // A window's TITLE is not what this says any more, so "title-changed" (a terminal
    // running a command, a browser tab) is no reason to look again. The registry is:
    // an app installed while its window is up gets its entry's name when it lands.
    compositor.connect("changed", sync)
    appService.connect(sync)
    sync()
    return GLib.SOURCE_REMOVE
  })

  if (openMenu) {
    let menuOpen = false
    // The open path, shared by the click gesture and the IPC hook.
    const openWindowMenu = () => {
      if (status.cc_edit_mode) return   // same guard as the other bar capsules
      // Every row acts on a window; with none, there is no menu to open. (The desktop's
      // mode is in the overview the dots open — #513 — not here.)
      if (!compositor.focusedClient) return
      menuOpen = true
      // Left-align the menu with the capsule's left edge: it sits near the left
      // screen edge, so a centered panel would spill off the left.
      openMenu(capsule, (onClose) => buildWindowMenu(() => { menuOpen = false; onClose() }), "start")
    }
    const gesture = new Gtk.GestureClick()
    gesture.set_button(0)   // 0 = any button: left and right click both open
    gesture.connect("released", () => {
      if (status.cc_edit_mode) return
      // A drag just ended on this pill: the release belongs to the drag, not to
      // a click — opening the menu here would punish every window move with a
      // menu to dismiss. dragMoved is still set: drag-end defers its reset to
      // an idle so this handler, in the same batch, still sees it.
      if (dragMoved) return
      // Light toggle: a second click while our menu is up closes it. "__custom"
      // is the bar's shared transient-expansion id; outside-click dismissal
      // resets it, so a stale menuOpen just falls through to re-open.
      if (menuOpen && status.bar_expanded_id === "__custom") {
        menuOpen = false
        status.bar_expanded_id = ""
        return
      }
      openWindowMenu()
    })
    capsule.add_controller(gesture)
    // Deterministic interaction hook for verification/automation: open the menu
    // without a synthetic click, then assert with `queryUI .veltrix-menu-label`.
    // Last bar wins on multi-monitor — fine, the menu is global (focused window).
    shellActions.openWindowMenu = openWindowMenu
    setBarItemKey(capsule, openWindowMenu)
  }

  return {
    widget: capsule,
    setMonitorWidth: (px) => { startBudgetAnimation(Math.max(100, (px / 2) - 200)) },
    setMaxWidth: (px, immediate = false) => {
      if (!immediate) { startBudgetAnimation(px); return }
      if (animTickId !== null) { capsule.remove_tick_callback(animTickId); animTickId = null }
      targetBudgetPx = currentBudgetPx = px
      updateLabel()
    },
  }
}

export default AppTitle
