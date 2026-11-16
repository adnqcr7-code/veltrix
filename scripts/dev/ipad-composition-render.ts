// Dev-only COMPOSITION render harness — NOT shipped, no bundle references this file.
//
// Paints the full iPad Mode screen at 1920×1080 under Xvfb: the macOS bar
// strip on top, the REAL iPad home panel in the middle, the macOS dock
// strip at the bottom — the one frame the v1 fidelity review said had
// never been seen (bar + grid + dock together).
//
// Honesty note, read before citing this render: the PANEL is the real
// panel code (ui/shell/surfaces/ipad-mode/IPadMode.tsx, real icons, real
// widgets, real CSS). The bar and dock STRIPS are simplified harness
// stand-ins, not the real Bar/Dock surfaces — the full shell cannot start
// in this VM (no Gtk4LayerShell typelib), so the real bar window and the
// real dock window are never built here. The strips use the shell's own
// CSS classes where they exist (.bar-strip, .bar-widget-label under the
// veltrix-bar-window scope) plus a small harness-only glass style for the
// dock pill, and show real data (live clock, live Hijri date from the
// same HijriService the panel uses, real app icons from assets/apps).
// Label any screenshot from it "Xvfb render — not a Dell screenshot;
// bar/dock strips are harness stand-ins, panel is the real panel", never
// "the shell" and never a Dell photo. The Dell photo is still the real
// composition proof.
//
//   VELTRIX_SHELL_ROOT=~/workspace/veltrix/fork/ui/shell \
//   GSETTINGS_SCHEMA_DIR=/tmp/veltrix-schemas \
//   PATH=~/workspace/veltrix/fork/bin:$PATH \
//   DISPLAY=:99 gjs -m /tmp/ipad-composition.js
//
// Monday verse: run the same command under faketime to render Monday's
// card (24:30, the longest verse, 145 chars):
//   faketime '2026-11-16 12:00:00' gjs -m /tmp/ipad-composition.js
// (the panel picks the verse by weekday, so the fake date is the seam).
//
// The var() flattening is the same VM-only workaround as
// scripts/dev/ipad-panel-render.ts (this VM's GTK is 4.14.5; var() needs
// 4.16 — see that file's comment for the full proof). The cursor is
// hidden on the window (fix pass #1: the Xvfb X cursor marred two v1
// renders as a stray ×).

import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { veltrixVars, DEFAULT_CONFIG } from "../../ui/lib/veltrix-kit/platform/theme-tokens"

// NOTE: the panel is imported DYNAMICALLY inside "activate", not at the
// top level — same display reason as the panel harness (a static import
// runs before the application has a display).

const SHELL_ROOT = GLib.getenv("VELTRIX_SHELL_ROOT")
if (!SHELL_ROOT) throw new Error("VELTRIX_SHELL_ROOT is required (ui/shell)")

function loadCss(path: string): void {
    const provider = new Gtk.CssProvider()
    provider.load_from_path(path)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )
}

const app = new Gtk.Application({ application_id: "org.veltrix.ipad-composition" })
app.connect("activate", async () => {
    print("RENDER: activate")
    const win = new Gtk.ApplicationWindow({ application: app })
    win.set_default_size(1920, 1080)
    win.set_title("iPad Mode — full-screen composition (Xvfb)")
    // The panel's styles are scoped to the bar window's identity
    // (`#veltrix-bar,.veltrix-bar-window` in _ipad-mode.scss): without it
    // the widget cards, tile labels and checklist chips render unstyled.
    win.set_name("veltrix-bar")
    win.add_css_class("veltrix-bar-window")
    // Cursor hidden (fix pass #1): the Xvfb default X cursor sat in the
    // middle of the v1 renders and read as a close/delete affordance.
    win.set_cursor(Gdk.Cursor.new_from_name("none", null))
    const overlay = new Gtk.Overlay()
    print("RENDER: window built")
    const { default: IPadModePanel } = await import("../../ui/shell/surfaces/ipad-mode/IPadMode")
    const hijriService = (await import("../../ui/shell/core/HijriService")).default
    print("RENDER: panel imported")

    // ── Tokens, flattened (VM-only workaround — see the header) ────────
    const tokenLines = veltrixVars(DEFAULT_CONFIG, true)
    const tokens = new Map<string, string>()
    for (const line of tokenLines) {
        const m = /--([a-z0-9-]+):\s*([^;]+);/.exec(line)
        if (m) tokens.set(m[1], m[2].trim())
    }
    print(`RENDER: tokens parsed (${tokens.size})`)
    const readText = (path: string): string => {
        const [ok, bytes] = GLib.file_get_contents(path)
        if (!ok || !bytes) throw new Error(`cannot read ${path}`)
        return new TextDecoder().decode(bytes)
    }
    const kitText = readText(`${SHELL_ROOT}/../lib/veltrix-kit/kit.css`)
    const styleText = readText(`${SHELL_ROOT}/style.css`)
    for (const text of [kitText, styleText]) {
        for (const m of text.matchAll(/--([a-z0-9-]+):\s*([^;{}]+);/g)) {
            if (!tokens.has(m[1])) tokens.set(m[1], m[2].trim())
        }
    }
    print(`RENDER: tokens total (${tokens.size})`)
    let unresolved = 0
    const flattenText = (text: string, outName: string): string => {
        let out = ""
        let i = 0
        while (true) {
            const v = text.indexOf("var(", i)
            if (v === -1) { out += text.slice(i); break }
            out += text.slice(i, v)
            const m = /--([a-z0-9-]+)/.exec(text.slice(v + 4))
            if (!m) { out += "var("; i = v + 4; continue }
            let depth = 1
            let j = v + 4
            while (j < text.length && depth > 0) {
                if (text[j] === "(") depth++
                else if (text[j] === ")") depth--
                j++
            }
            const inner = text.slice(v + 4, j - 1)
            const comma = inner.indexOf(",")
            const name = (comma === -1 ? inner : inner.slice(0, comma)).trim().slice(2)
            const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim()
            const value = tokens.get(name)
            if (value !== undefined) out += value
            else if (fallback !== undefined) out += fallback
            else { unresolved++; out += text.slice(v, j) }
            i = j
        }
        const flat = out.replace(/^\s*--[a-z0-9-]+:\s*[^;{}]+;\s*(?:\/\*.*\*\/\s*)?$/gm, "")
        const outPath = `${GLib.getenv("XDG_RUNTIME_DIR") ?? "/tmp"}/${outName}`
        GLib.file_set_contents(outPath, flat)
        return outPath
    }
    loadCss(flattenText(kitText, "veltrix-render-flat-kit.css"))
    print("RENDER: kit.css done (flattened)")
    loadCss(flattenText(styleText, "veltrix-render-flat-style.css"))
    print("RENDER: style.css done (flattened)")
    if (unresolved > 0) print(`RENDER: WARNING ${unresolved} var() left unresolved`)
    // Harness-only glass for the dock stand-in pill (the real dock's
    // pill is painted by DockCore; this stand-in is a plain box, so it
    // needs its own background — values copied from the concept dock).
    const dockCss = new Gtk.CssProvider()
    const dockCssPath = `${GLib.getenv("XDG_RUNTIME_DIR") ?? "/tmp"}/veltrix-render-dock-standin.css`
    GLib.file_set_contents(dockCssPath, `.ipad-comp-dock { background: rgba(10, 12, 18, 0.55); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 24px; padding: 8px 14px; }`)
    dockCss.load_from_path(dockCssPath)
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), dockCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    print("RENDER: css done")

    // ── Wallpaper ─────────────────────────────────────────────────────
    const bg = Gtk.Picture.new_for_filename(`${SHELL_ROOT}/../../defaults/wallpaper/wallpaper.jpg`)
    bg.set_content_fit(Gtk.ContentFit.COVER)
    overlay.set_child(bg)

    // ── Full-screen column: bar strip / real panel / dock strip ──────
    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true })

    // Bar strip stand-in (36px, the shell's .bar-strip class): workspace
    // left, live clock + Hijri right. Real data, simplified chrome.
    const barStrip = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, css_classes: ["bar-strip"] })
    barStrip.set_size_request(-1, 36)
    barStrip.set_margin_start(16)
    barStrip.set_margin_end(16)
    const barLeft = new Gtk.Label({ label: "Workspace 1", css_classes: ["bar-widget-label"], halign: Gtk.Align.START })
    const barSpacer = new Gtk.Box({ hexpand: true })
    hijriService.start()
    const now = GLib.DateTime.new_now_local()
    const clockText = now.format("%a %d %b %I:%M %p")?.replace(/ 0(\d:\d\d)/, " $1") ?? ""
    const barRight = new Gtk.Label({
        label: clockText,
        css_classes: ["bar-widget-label"],
        halign: Gtk.Align.END,
    })
    barStrip.append(barLeft)
    barStrip.append(barSpacer)
    barStrip.append(barRight)
    // The strip sits over the wallpaper with side margins like the real bar.
    const barMargin = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL })
    barMargin.append(barStrip)
    barStrip.set_hexpand(true)
    column.append(barMargin)

    // Real panel.
    const display = Gdk.Display.get_default()
    const monitor = display.get_monitors().get_item(0) as Gdk.Monitor
    const panel = IPadModePanel(monitor)
    print("RENDER: panel constructed")
    panel.widget.set_hexpand(true)
    panel.widget.set_vexpand(true)
    column.append(panel.widget)

    // Dock strip stand-in: the real app icons in a glass pill, centred,
    // with a bottom margin like the real dock. Stand-in, not the DockCore
    // surface — see the header.
    const dockRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 14, css_classes: ["ipad-comp-dock"] })
    const dockApps = ["files", "terminal", "browser", "settings", "calendar", "clock", "org.gnome.Notes", "org.gnome.Photos"]
    for (const name of dockApps) {
        const path = `${SHELL_ROOT}/assets/apps/${name}.svg`
        try {
            const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 48, 48, true)
            const img = Gtk.Image.new_from_pixbuf(pb)
            img.pixel_size = 48
            dockRow.append(img)
        } catch (e) {
            print(`RENDER: dock icon missing: ${path}`)
        }
    }
    const dockCenter = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, halign: Gtk.Align.CENTER })
    dockCenter.append(dockRow)
    const dockMargin = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    dockMargin.append(dockCenter)
    dockMargin.set_margin_bottom(10)
    column.append(dockMargin)

    overlay.add_overlay(column)
    win.set_child(overlay)
    win.present()
    win.fullscreen()
    print("RENDER: presented")
    panel.relayout(1920, 1080)
    panel.setVisible(true)
    panel.refresh()
    print("RENDER: visible + refreshed")
    // The bar clock line is updated on a 5s timer, not here: the
    // panel's refreshPrayer() is async (it awaits the prayer-times
    // helper) and the Hijri service only has its date after that
    // completes — reading it synchronously here is still empty.
    // The screenshot is taken at ~7s, so 5s is safely before it.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5_000, () => {
        const hijriText = hijriService.hijri ?? ""
        if (hijriText) barRight.label = `${clockText}  ·  ${hijriText}`
        print(`RENDER: bar right now "${barRight.label}"`)
        return GLib.SOURCE_REMOVE
    })

    // Stay up long enough for the screenshot, then quit: the render
    // script screenshots at ~10s and this exits at 15s.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15_000, () => {
        app.quit()
        return GLib.SOURCE_REMOVE
    })
})
app.run([])
