// SPDX-License-Identifier: GPL-3.0-or-later
// Which hidden window a dock click restores — pure, no imports, so a
// probe can exercise it without the shell.
//
// A dock click on an app with NO shown window restores one of its hidden
// windows. Which one? The LONGEST-hidden one (smallest hide order), not
// the most recently hidden — and the reason is the toggle underneath it:
//
//   Hide A, then B. Click restores the most recently hidden (B); B is now
//   shown and focused, so the next click HIDES it again (click-to-minimize);
//   the click after that restores the most recently hidden — B again.
//   A is never restored: the click oscillates on the newest window
//   forever (Nov 14 sweep #7).
//
// Longest-hidden-first breaks the trap: hide A, B, C → the clicks restore
// A, then B, then C, then A again — every hidden window is reachable by
// repeated clicking. The single-hidden-window case is unchanged (there is
// only one candidate either way), and the choice is the same on both
// compositors: Hyalo orders by its `minimizedOrder`, Hyprland by the
// dock's own hide order (DockItem's dockHiddenOrder).
//
// `orderOf` gives each hidden window its hide order (a number; smaller
// hid first). Ties keep the earliest in the array — the order is stable,
// so a tie can never flip the pick between clicks.

export function pickRestoreTarget<T>(hidden: readonly T[], orderOf: (c: T) => number): T | undefined {
    let best: T | undefined
    let bestOrder = Infinity
    for (const c of hidden) {
        const o = orderOf(c)
        if (o < bestOrder) {
            bestOrder = o
            best = c
        }
    }
    return best
}
