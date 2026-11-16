// Dev-only render harness — NOT shipped, no bundle references this file.
//
// Paints the real iPad Mode home panel (ui/shell/surfaces/ipad-mode/)
// in a plain fullscreen GTK window under Xvfb, over the default
// wallpaper, with the shell's own CSS. It exists because the full shell
// cannot start in this VM: app.ts hard-requires the Gtk4LayerShell
// typelib, which is not installed here, and the bar window the panel
// normally lives in never gets built. The panel itself never touches
// layer-shell (only app.ts and Bar.tsx do), so this renders the real
// panel code — the real icons, the real widgets, the real CSS —
// without the bar, the dock, or the compositor. Label any screenshot
// from it "standalone panel render under Xvfb", never "the shell".
//
//   VELTRIX_SHELL_ROOT=~/workspace/veltrix/fork/ui/shell \
//   GSETTINGS_SCHEMA_DIR=/tmp/veltrix-schemas \
//   PATH=~/workspace/veltrix/fork/bin:$PATH \
//   DISPLAY=:99 gjs -m /tmp/ipad-panel.js
//
// VELTRIX_SHELL_ROOT must point at the checkout's ui/shell (for
// style.css and the wallpaper path); the kit CSS is resolved next to it.

import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import { veltrixVars, DEFAULT_CONFIG } from "../../ui/lib/veltrix-kit/platform/theme-tokens"

// NOTE: the panel is imported DYNAMICALLY inside "activate", not at the
// top level. Its module constructs the AppService singleton at import
// time, and AppService calls Gtk.IconTheme.get_for_display() — which
// needs the default display to exist. At top-level import time there is
// no display yet (the application has not started), so a static import
// crashes with "Argument display may not be null". Inside "activate"
// the display is up.

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

const app = new Gtk.Application({ application_id: "org.veltrix.ipad-render" })
app.connect("activate", async () => {
  print("RENDER: activate")
  // The window is built BEFORE the panel import: if construction still
  // crashes here, the panel's import chain is exonerated.
  const win = new Gtk.ApplicationWindow({ application: app })
  win.set_default_size(1920, 1080)
  win.set_title("iPad Mode — standalone panel render (Xvfb)")
  // The panel's styles are scoped to the bar window's identity
  // (`#veltrix-bar,.veltrix-bar-window` in _ipad-mode.scss): without it the
  // widget cards, tile labels and checklist chips render unstyled. The
  // real bar window carries this name and class; the harness mimics it
  // so the render shows the panel as the shell styles it.
  win.set_name("veltrix-bar")
  win.add_css_class("veltrix-bar-window")
  // Cursor hidden (fix pass #1): the Xvfb default X cursor sat in the
  // middle of the v1 renders and read as a close/delete affordance.
  win.set_cursor(Gdk.Cursor.new_from_name("none", null))
  const overlay = new Gtk.Overlay()
  print("RENDER: window built")
  const { default: IPadModePanel } = await import("../../ui/shell/surfaces/ipad-mode/IPadMode")
  print("RENDER: panel imported")
  // Env gates for bisecting a crash (dev harness only):
  // IPAD_RENDER_NO_CSS=1 skips the token block + stylesheets;
  // IPAD_RENDER_NO_WALLPAPER=1 skips the wallpaper picture;
  // IPAD_RENDER_NO_PANEL=1 skips constructing the panel.
  const noCss = GLib.getenv("IPAD_RENDER_NO_CSS") === "1"
  const noTokens = GLib.getenv("IPAD_RENDER_NO_TOKENS") === "1"
  const noFiles = GLib.getenv("IPAD_RENDER_NO_FILES") === "1"
  const noWallpaper = GLib.getenv("IPAD_RENDER_NO_WALLPAPER") === "1"
  const noPanel = GLib.getenv("IPAD_RENDER_NO_PANEL") === "1"
  if (!noCss) {
    // ── Tokens, flattened (VM-only workaround) ────────────────────────
    // The `--veltrix-*` custom properties are generated at runtime by the
    // token engine (theme-tokens.ts) and loaded as a `* {…}` block by the
    // real shell — kit.css/style.css only REFERENCE them via var().
    //
    // THIS VM's GTK is 4.14.5, and GTK only supports custom properties
    // and var() from 4.16 (docs.gtk.org/gtk4/css-properties.html:
    // "Starting with 4.16, GTK supports custom properties"). Proven
    // 2026-11-13 with a minimal app: the tokens file is rejected with
    // "No property named --veltrix-accent" (×63 in the render log) and
    // `background: var(--veltrix-accent)` fails with "Junk at end of
    // value". So on this VM every var() declaration is dropped: text
    // renders dark-on-dark and the accent never appears. That is a
    // VM artifact, NOT a product bug — Arch ships GTK 4.20, where the
    // same sheets resolve (Phase 0 shipped on them, UI 9.6).
    //
    // The harness therefore FLATTENS var() before loading: it takes
    // the token values from the same veltrixVars() call the shell uses
    // and substitutes them literally into kit.css/style.css, writing
    // the result to $XDG_RUNTIME_DIR. The render then shows what Arch
    // shows. The substitution is textual and exact — no value is
    // invented, and the flattened files are dev-only (never shipped).
    // The tokens provider itself is NOT loaded here: on this GTK it
    // would only emit 63 parser errors and define nothing. (Separately,
    // load_from_data() segfaults this VM's GTK when the data defines
    // custom properties — bisected 2026-11-13 — so even on a newer GTK
    // a file-based load is the safe shape here; the real shell uses
    // load_from_data on Arch and it works there.)
    const tokenLines = veltrixVars(DEFAULT_CONFIG, true)
    const tokens = new Map<string, string>()
    for (const line of tokenLines) {
      const m = /--([a-z0-9-]+):\s*([^;]+);/.exec(line)
      if (m) tokens.set(m[1], m[2].trim())
    }
    print(`RENDER: tokens parsed (${tokens.size})`)
    let unresolved = 0
    // Static tokens live in the sheets themselves (radius and border
    // are defined in style.css's * block, not by veltrixVars, and
    // kit.css USES them without defining them): harvest every
    // `--veltrix-*: value;` definition from BOTH sheets first, so uses
    // in either file resolve.
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
    const flattenText = (text: string, outName: string): string => {
      // Substitute var() by hand, not by regex: a fallback may itself
      // contain parens (`var(--veltrix-popover-bg, rgba(22, 22, 34, 0.85))`)
      // and a regex stops at the first `)`, leaving a stray paren
      // behind (caught 2026-11-13: `rgba(22, 22, 34, 1.00))`).
      let out = ""
      let i = 0
      while (true) {
        const v = text.indexOf("var(", i)
        if (v === -1) { out += text.slice(i); break }
        out += text.slice(i, v)
        const m = /--([a-z0-9-]+)/.exec(text.slice(v + 4))
        if (!m) { out += "var("; i = v + 4; continue }
        // Find the matching close paren, counting nesting.
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
      // Drop the definition lines themselves: this GTK rejects
      // custom-property declarations, and every use is already
      // substituted — leaving them would only spam parser errors.
      const flat = out.replace(/^\s*--[a-z0-9-]+:\s*[^;{}]+;\s*(?:\/\*.*\*\/\s*)?$/gm, "")
      const outPath = `${GLib.getenv("XDG_RUNTIME_DIR") ?? "/tmp"}/${outName}`
      GLib.file_set_contents(outPath, flat)
      return outPath
    }
    if (!noTokens && !noFiles) {
      const kitFlat = flattenText(kitText, "veltrix-render-flat-kit.css")
      loadCss(kitFlat)
      print("RENDER: kit.css done (flattened)")
      const styleFlat = flattenText(styleText, "veltrix-render-flat-style.css")
      loadCss(styleFlat)
      print("RENDER: style.css done (flattened)")
      if (unresolved > 0) print(`RENDER: WARNING ${unresolved} var() left unresolved`)
    } else if (!noFiles) {
      loadCss(`${SHELL_ROOT}/../lib/veltrix-kit/kit.css`)
      print("RENDER: kit.css done")
      loadCss(`${SHELL_ROOT}/style.css`)
      print("RENDER: style.css done")
    }
  }
  print("RENDER: css done")

  if (!noWallpaper) {
    const bg = Gtk.Picture.new_for_filename(`${SHELL_ROOT}/../../defaults/wallpaper/wallpaper.jpg`)
    bg.set_content_fit(Gtk.ContentFit.COVER)
    overlay.set_child(bg)
  }

  const display = Gdk.Display.get_default()
  const monitor = display.get_monitors().get_item(0) as Gdk.Monitor
  if (!noPanel) {
    const panel = IPadModePanel(monitor)
    print("RENDER: panel constructed")
    panel.widget.set_hexpand(true)
    panel.widget.set_vexpand(true)
    overlay.add_overlay(panel.widget)

    win.set_child(overlay)
    win.present()
    win.fullscreen()
    print("RENDER: presented")
    panel.relayout(1920, 1080)
    panel.setVisible(true)
    panel.refresh()
    print("RENDER: visible + refreshed")
  } else {
    win.set_child(overlay)
    win.present()
    win.fullscreen()
    print("RENDER: presented (no panel)")
  }

  // Stay up long enough for the screenshot, then quit: the render
  // script screenshots at ~7s and this exits at 12s.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 12_000, () => {
    app.quit()
    return GLib.SOURCE_REMOVE
  })
})
app.run([])
