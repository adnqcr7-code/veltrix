import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import { cairoDraw } from "../../../../lib/veltrix-kit/platform/cairo-draw"
import { hexToFloatRgb, makeCoverFit } from "../../../common/DrawingUtils"
import { kitAppearance } from "../../../../lib/veltrix-kit/appearance"
import {
    layoutSlantedPanels, hitSlantedPanel, slantedGalleryHeight, slantedRowWidth,
    type SlantedPanel,
} from "./slantedGeometry"

// The slanted-panel wallpaper gallery (Appearance → Wallpaper).
//
// One Cairo-painted DrawingArea, not a row of buttons: the panels overlap,
// so no row of rectangular buttons could own the clicks — only a single
// widget with a point-in-parallelogram hit test can tell which panel a
// click landed on. Each wallpaper is cover-fit into its parallelogram;
// every panel gets a dark separator edge, and the active one an accent ring
// (the accent, the only colour a selected state ever takes).
//
// Pixbufs decode lazily, once per path, at 2× the panel size — the same
// pattern as CoverArt: a 220×124 JPEG decode is cheap, and it happens once,
// not per frame. The cover-fit copy is cached by makeCoverFit and only
// recomputed when the box actually changes.

const DECODE_W = 220
const DECODE_H = 124

export interface SlantedGallery {
    widget: Gtk.DrawingArea
    /** Mark a new wallpaper active (repaints the accent ring). */
    refresh: (currentPath: string) => void
}

/** Two paths name the same wallpaper when their basenames agree: the
 *  bundled list can point at the dev repo while Wallpaper.current points at
 *  /usr/share/veltrix/wallpapers, or the other way round. */
function sameWallpaper(a: string, b: string): boolean {
    if (!a || !b) return false
    if (a === b) return true
    return (a.split("/").pop() ?? a) === (b.split("/").pop() ?? b)
}

export function createSlantedWallpaperGallery(
    paths: string[],
    currentPath: string,
    onSelect: (path: string) => void,
): SlantedGallery {
    let current = currentPath
    const pixbufs = new Map<string, any | null>()
    const coverFit = makeCoverFit()
    // The live accent, read at draw time from the kit's appearance seam
    // (this gallery runs in the Settings process, which paints through the
    // portal — there is no ThemeManager here). A const captured at creation
    // would freeze the ring on the accent the gallery opened with.

    const da = new Gtk.DrawingArea({
        width_request: Math.max(1, slantedRowWidth(Math.ceil(paths.length / 2))),
        height_request: slantedGalleryHeight(paths.length),
        css_classes: ["wallpaper-slanted-gallery"],
    })
    da.set_cursor(Gdk.Cursor.new_from_name("pointer", null))

    const loadPixbuf = (path: string): any | null => {
        const hit = pixbufs.get(path)
        if (hit !== undefined) return hit
        let pb: any = null
        try { pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, DECODE_W, DECODE_H, false) }
        catch { pb = null }
        pixbufs.set(path, pb)
        return pb
    }

    const parallelogram = (cr: any, p: SlantedPanel) => {
        cr.move_to(p.x + p.slant, p.y)
        cr.line_to(p.x + p.w + p.slant, p.y)
        cr.line_to(p.x + p.w, p.y + p.h)
        cr.line_to(p.x, p.y + p.h)
        cr.close_path()
    }

    da.set_draw_func(cairoDraw((_area: any, cr: any, dw: number, dh: number) => {
        if (dw <= 0 || dh <= 0 || paths.length === 0) return
        const panels = layoutSlantedPanels(paths.length, dw)
        for (const p of panels) {
            const path = paths[p.index]
            const pb = loadPixbuf(path)
            cr.save()
            parallelogram(cr, p)
            cr.clip()
            if (pb) {
                // Cover the parallelogram's bounding box (panel + slant).
                const fit = coverFit(pb, p.w + p.slant, p.h)
                Gdk.cairo_set_source_pixbuf(cr, fit.pixbuf, p.x + fit.x, p.y + fit.y)
                cr.paint()
            } else {
                // An undecodable file still draws its panel, dimmed, instead
                // of leaving a hole in the strip.
                cr.setSourceRGBA(1, 1, 1, 0.08)
                cr.paint()
            }
            cr.restore()
            // Separator: a dark edge so neighbouring panels read apart.
            cr.save()
            parallelogram(cr, p)
            cr.setSourceRGBA(0, 0, 0, 0.55)
            cr.setLineWidth(2)
            cr.stroke()
            cr.restore()
            if (sameWallpaper(path, current)) {
                cr.save()
                parallelogram(cr, p)
                const accent = hexToFloatRgb(kitAppearance().accent())
                cr.setSourceRGBA(accent.r, accent.g, accent.b, 1)
                cr.setLineWidth(2)
                cr.stroke()
                cr.restore()
            }
        }
    }))

    const click = new Gtk.GestureClick({ button: 1 })
    click.connect("pressed", (_g: any, _n: number, x: number, y: number) => {
        const panels = layoutSlantedPanels(paths.length, da.get_allocated_width())
        const hit = hitSlantedPanel(panels, x, y)
        if (hit >= 0 && !sameWallpaper(paths[hit], current)) onSelect(paths[hit])
    })
    da.add_controller(click)

    return {
        widget: da,
        refresh: (next: string) => {
            if (sameWallpaper(next, current)) return
            current = next
            da.queue_draw()
        },
    }
}
