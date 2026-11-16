// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Veltrix UI — GTK4 primitive widget library for Veltrix
 *
 * All components use pure GTK4 primitives + Veltrix CSS tokens.
 * No Adwaita. No resets needed.
 *
 * Usage: import { VeltrixRow, VeltrixScrolled } from "../../lib/veltrix-kit"
 */

// (VeltrixSelect and VeltrixOverlayManager were deleted 2026-08-03. The select was an
// in-window overlay list; Settings moved to VeltrixDropDown below because a real popover
// is a separate Wayland surface and therefore gets compositor blur, which an overlay
// cannot. The manager existed only to float that list, and went with it.)

// VeltrixClamp — max-width centering container (replaces Adw.Clamp)
export { VeltrixClamp } from "./clamp"

// VeltrixScrolled — scroll view whose indicator can never take a click (replaces
// Gtk.ScrolledWindow wherever rows carry a control at their right edge)
export type { VeltrixScrolledOpts, VeltrixScrolledResult } from "./scrolled"
export { VeltrixScrolled } from "./scrolled"

// VeltrixDropDown — Gtk.DropDown whose popup list carries the same bar. The native
// dropdown stays (its popover is a real Wayland popup, so it gets compositor blur);
// what goes is GTK's scrollbar inside it. attachScrollBar/adoptGtkScrolled are the
// same machinery for any other view GTK builds for us.
export { VeltrixDropDown, attachScrollBar, adoptGtkScrolled } from "./scrolled"

// VeltrixSplitView — sidebar+content with auto-collapse (replaces Adw.OverlaySplitView + Adw.Breakpoint)
export type { VeltrixSplitViewResult } from "./split-view"
export { VeltrixSplitView } from "./split-view"
export { attachWindowControls, controlsSlotWidget, normalWindowControls, readControlsSide, type ControlsFallback, type ControlsSlot, type ControlsSide, type WindowButton } from "./platform/window-controls"

// VeltrixButton — unified button component (replaces suggested-action / destructive-action / pill)
export type { VeltrixButtonVariant, VeltrixButtonOpts } from "./button"
export { VeltrixButton } from "./button"

// VeltrixCircleButton — the round glass icon button (close/remove/collapse). Moved
// here from the shell's common/IconButton.ts on 2026-08-26, with its CSS; that file
// is now a wrapper adding the shell-only tooltip and capture-click.
export type { VeltrixCircleVariant, VeltrixCircleButtonOpts } from "./button"
export { VeltrixCircleButton } from "./button"

// VeltrixFontButton — pill font picker (replaces Gtk.FontButton)
export type { VeltrixFontButtonOpts } from "./fontbutton"
export { VeltrixFontButton } from "./fontbutton"

// VeltrixRow / VeltrixList — universal list row + boxed list card (the one place
// a row/list is built; used by Settings, Control Center and any future surface)
export { VeltrixRow, VeltrixStackedRow, VeltrixFieldRow, VeltrixEmptyRow, ROW_H_SINGLE, ROW_H_DOUBLE } from "./row"
export type { VeltrixRowResult, VeltrixFieldRowResult, VeltrixValidationState } from "./row"
export { VeltrixList, VeltrixPickList, VeltrixListActions } from "./list"
export type { VeltrixListResult } from "./list"

// VeltrixTable — the same card and the same rows, in aligned columns under
// headings. The one thing a row cannot say: several values per line, each named.
export { VeltrixTable } from "./table"
export type { VeltrixTableColumn, VeltrixTableResult, VeltrixTableRow } from "./table"
export { VeltrixSelectionCheck } from "./check"

// VeltrixSidebar — universal navigation list (icon+label rows, single-select)
export { VeltrixSidebar } from "./sidebar"
export type { VeltrixSidebarItem, VeltrixSidebarResult } from "./sidebar"

// VeltrixWindow — THE window of this desktop: undecorated glass card, draggable
// header, one close path, its own app-id, and a sidebar + split view IF you pass
// one. The sidebar is an option, not a second component — see the note on the
// function. `app-window.ts` is the layer underneath and is deliberately not
// exported: there is one name to choose.
export { VeltrixWindow, VELTRIX_WINDOW_RADIUS, VELTRIX_CARD_RADIUS } from "./window"
export type {
  VeltrixWindowOpts, VeltrixWindowResult, VeltrixWindowSidebar, VeltrixWindowHeaderSlots,
} from "./window"
export type { VeltrixCloseMode } from "./app-window"

// makeSlider — the ONE slider (Cairo, horizontal/vertical; there is no Gtk.Scale
// anywhere in Veltrix). makeHSlider is the horizontal wrapper, makeVolumeSlider binds
// one to an audio endpoint, makeVerticalFillTile is the 1×2 CC gauge tile.
export type { SliderOpts, SliderOrientation } from "./slider"
export { makeSlider, makeHSlider, makeVerticalFillTile, makeVolumeSlider, sliderKeyHandler } from "./slider"

// The appearance seam the slider paints through — every BUNDLE registers its own
// source once, in app.ts. Cairo cannot read CSS tokens, so the accent and the
// surface's mode have to be handed to the kit. See appearance.ts.
export type { KitAppearance } from "./appearance"
export { setKitAppearance, kitAppearance } from "./appearance"

// The COMPOSED rows — "label + subtitle + the control that edits it", which is what a
// preferences pane is made of. They take the row BUILDER as a parameter (`mkRow`,
// default `plainRow`) so that composing a row and registering it somewhere are two
// different jobs: Settings passes its own `createRow`, everyone else does not. See
// rows.ts for why that is a parameter and not a module-level seam.
export type { VeltrixRowBuilder, VeltrixSliderRowOpts } from "./rows"
export { VeltrixToggleRow, VeltrixDropDownRow, VeltrixSliderRow, plainRow } from "./rows"

// bindWhileRealized — bind a subscription to a widget's REALIZED lifetime, not to a
// one-shot unrealize. Required by anything that caches widgets instead of rebuilding
// them; the composed rows re-arm their external sync through it.
export { bindWhileRealized } from "./lifetime"

// showVeltrixAlert — modal confirmation dialog (replaces Adw.AlertDialog)
export type { AlertResponse, AlertHandle, AlertChoice } from "./alert-dialog"
export { showVeltrixAlert } from "./alert-dialog"

// VeltrixBadge — a neutral status pill ("Isolated", "custom"); never a control.
export { VeltrixBadge } from "./badge"
export { setTransientForExported } from "./wayland-parent"

// showVeltrixFormDialog — modal form dialog with floating glass styling
export type { FormResponse, FormDialogHandle, VeltrixFormDialogOpts } from "./form-dialog"
export { showVeltrixFormDialog } from "./form-dialog"

// attachTooltip — the one Veltrix tooltip (Cairo glass bubble with pointer arrow)
export type { VeltrixTooltipOpts, VeltrixTooltipHandle, VeltrixTooltipText } from "./tooltip"
export { attachTooltip } from "./tooltip"

// GlassBubbleMenu / VeltrixMenu — universal Cairo glass bubble context menu popover
export type { GlassBubbleMenuOpts } from "./menu"
export { GlassBubbleMenu, VeltrixMenu } from "./menu"

// Fluid Crystal — the kit's backend-neutral material contract. Rendering is supplied by the
// active bundle/platform; these presets are the public vocabulary apps build against.
export type {
  FluidCrystalVariant, FluidCrystalProfile, FluidCrystalInk, FluidCrystalElevation,
  FluidCrystalSpec, FluidCrystalPreset, FluidCrystalSelection,
} from "./platform/fluid-crystal"
export { FLUID_CRYSTAL_PRESETS } from "./platform/fluid-crystal"
export { trackFluidCrystal } from "./platform/material"

