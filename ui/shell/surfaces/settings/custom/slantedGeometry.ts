// Pure geometry for the slanted-panel wallpaper gallery.
//
// The picker shows the bundled wallpapers inside overlapping slanted
// parallelogram frames — the shape language of the reference picker Adnan
// sent (three white slanted panels on black; a wallpaper strip of misty
// mountains / dark forest / white dune / hexagons inside the same slanted
// frames). Panels lean right at the top: each panel's top edge is shifted
// right by SLANT_SHIFT vs its bottom edge, and each panel overlaps the
// previous one's right edge by SLANT_OVERLAP, so the strip reads as one
// continuous slanted band, not a row of separate rectangles.
//
// No imports at all: this module is pure math, so a probe can drive it
// without GTK, GJS or a display.

export const SLANT_PANEL_W = 110
export const SLANT_PANEL_H = 62
export const SLANT_SHIFT = 25
export const SLANT_OVERLAP = 28
export const SLANT_ROW_GAP = 8

export interface SlantedPanel {
    /** Index into the paths array. */
    index: number
    /** 0 = top row, 1 = bottom row. */
    row: number
    /** Panel origin: the TOP edge's left corner x, within the widget. */
    x: number
    /** Panel origin: the TOP edge y, within the widget. */
    y: number
    w: number
    h: number
    slant: number
}

/** Width one row of `n` panels occupies, slant included. */
export function slantedRowWidth(n: number): number {
    if (n <= 0) return 0
    return SLANT_PANEL_W + (n - 1) * (SLANT_PANEL_W - SLANT_OVERLAP) + SLANT_SHIFT
}

/** Height the whole gallery needs: one row, or two with a gap. */
export function slantedGalleryHeight(count: number): number {
    if (count <= 0) return 0
    return count === 1 ? SLANT_PANEL_H : 2 * SLANT_PANEL_H + SLANT_ROW_GAP
}

/** Lay out `count` panels in two rows (first row takes the ceiling half),
 *  centred in `width`. Panels come back in draw order (left to right, top
 *  row first) — a later panel paints over the previous one's right edge. */
export function layoutSlantedPanels(count: number, width: number): SlantedPanel[] {
    const panels: SlantedPanel[] = []
    if (count <= 0) return panels
    const first = Math.ceil(count / 2)
    const rows = [first, count - first]
    rows.forEach((n, row) => {
        if (n <= 0) return
        const y = row * (SLANT_PANEL_H + SLANT_ROW_GAP)
        const x0 = Math.max(0, (width - slantedRowWidth(n)) / 2)
        for (let i = 0; i < n; i++) {
            panels.push({
                index: row === 0 ? i : first + i,
                row,
                x: x0 + i * (SLANT_PANEL_W - SLANT_OVERLAP),
                y,
                w: SLANT_PANEL_W,
                h: SLANT_PANEL_H,
                slant: SLANT_SHIFT,
            })
        }
    })
    return panels
}

/** The panel the point (px, py) falls in, or -1. Reverse draw order, so a
 *  click on an overlap lands on the panel painted on top — the one the user
 *  actually sees there. */
export function hitSlantedPanel(panels: SlantedPanel[], px: number, py: number): number {
    for (let i = panels.length - 1; i >= 0; i--) {
        const p = panels[i]
        if (py < p.y || py > p.y + p.h) continue
        // y grows down: frac 0 at the top edge, 1 at the bottom. The left and
        // right edges slide left as frac grows (the top is shifted right).
        const frac = (py - p.y) / p.h
        const left = p.x + p.slant * (1 - frac)
        const right = p.x + p.w + p.slant * (1 - frac)
        if (px >= left && px <= right) return p.index
    }
    return -1
}
