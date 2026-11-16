// Dev-only render harness — NOT shipped, no bundle references this file.
//
// Paints the REAL Halal Audio Settings page (buildPreferencePage("halal-audio"))
// in a plain GTK window under Xvfb, with the shell's own CSS. It exists
// because the full shell cannot start in this VM: app.ts hard-requires
// the Gtk4LayerShell typelib, which is not installed here, and the
// Settings app needs the native host. The page itself never touches
// layer-shell, so this renders the real page code — the real rows, the
// real toggle, the real status line, the real CSS — without the sidebar,
// the shell, or the compositor. Label any screenshot from it
// "standalone Settings page render under Xvfb", never "the shell" and
// never "Settings".
//
//   glib-compile-schemas config/gsettings --targetdir /tmp/veltrix-schemas
//   VELTRIX_SHELL_ROOT=~/workspace/veltrix/fork/ui/shell \
//   GSETTINGS_SCHEMA_DIR=/tmp/veltrix-schemas \
//   PATH=~/workspace/veltrix/fork/bin:$PATH \
//   DISPLAY=:99 gjs -m /tmp/halal-audio-page.js
//
// VELTRIX_SHELL_ROOT must point at the checkout's ui/shell (for
// style.css); the kit CSS is resolved next to it. GSettings schemas must
// be compiled first: the page's store reads org.veltrix.halal-audio, and
// an uncompiled schema makes GSettings refuse the key.

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

const app = new Gtk.Application({ application_id: "org.veltrix.halal-audio-render" })
app.connect("activate", async () => {
  try {
  print("RENDER: activate")
  // The window is built BEFORE the panel import: if construction still
  // crashes here, the panel's import chain is exonerated.
  const win = new Gtk.ApplicationWindow({ application: app })
  win.set_default_size(1000, 700)
  win.set_title("Halal Audio — standalone Settings page render (Xvfb)")
  // The Settings page's styles are scoped to the Settings window's
  // identity (`window.veltrix-settings-window` in _settings.scss). The
  // real Settings window carries this name and class; the harness mimics
  // it so the render shows the page as the shell styles it.
  win.set_name("veltrix-settings-window")
  win.add_css_class("veltrix-settings-window")
  // Cursor hidden (fix pass #1): the Xvfb default X cursor sat in the
  // middle of the v1 renders and read as a close/delete affordance.
  win.set_cursor(Gdk.Cursor.new_from_name("none", null))
  const overlay = new Gtk.Overlay()
  print("RENDER: window built")
  const { buildPreferencePage } = await import("../../ui/shell/surfaces/settings/PreferencePage")
  print("RENDER: PreferencePage imported")

  // The app entry (ui/settings/app.ts, ui/shell/app.ts) normally calls
  // registerConfigEntries() at startup, but a standalone harness on THIS
  // VM cannot import config-entries.ts: its import chain spawns `hyprctl`
  // (HyprlandState getoption), which does not exist without Hyprland —
  // proven 2026-11-13 (GLib.SpawnError, render 2). That is a pre-existing
  // VM limitation, not a Halal Audio bug. This page needs exactly one key,
  // so the harness registers it directly, mirroring config-entries.ts
  // (the "Halal Audio" block) verbatim. The real registration is still
  // validated statically by settings-data-check + the typechecks.
  const { registerConfig } = await import("../../ui/shell/core/ConfigRegistry")
  const { halalAudioConfig } = await import("../../ui/shell/core/HalalAudioConfig")
  registerConfig("halalAudio.enabled", {
    desc: "Halal Audio filter (harness mirror of config-entries.ts).",
    type: "boolean",
    get: () => halalAudioConfig.enabled,
    set: (v: unknown) => halalAudioConfig.setEnabled(v as boolean),
    subscribe: (apply: () => void) => {
      apply()
      return halalAudioConfig.subscribe("enabled", apply)
    },
    ui: { i18n: "settings.halalAudio.enable" },
  })
  print("RENDER: halalAudio.enabled registered (harness mirror)")
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

  if (!noPanel) {
    const page = buildPreferencePage("halal-audio")
    print("RENDER: page constructed")
    // Dev probe (HALAL_RENDER_DEBUG_SENSITIVITY=1): walk the page tree and
    // print every button's label + sensitive flag + parent-row sensitive
    // flag, so a review can tell a truly-enabled button from a button that
    // is insensitive but merely PAINTED bright by the VM's flattened CSS.
    if (GLib.getenv("HALAL_RENDER_DEBUG_SENSITIVITY") === "1") {
      const walk = (w: any, depth: number): void => {
        const name = w.constructor?.name ?? "?"
        let extra = ""
        try {
          if (typeof w.get_label === "function") extra = ` label=${JSON.stringify(w.get_label())}`
        } catch { /* not a labelled widget */ }
        try {
          if (typeof w.get_active === "function") extra += ` active=${w.get_active()}`
        } catch { /* not a switch */ }
        try {
          const sc = w.get_style_context?.()
          if (sc) {
            const st = sc.get_state()
            const CHECKED = (Gtk as any).StateFlags?.CHECKED ?? 0
            extra += ` state=${st} checked=${CHECKED !== 0 ? Boolean(st & CHECKED) : "?"}`
          }
        } catch { /* no style context */ }
        print(`RENDER: TREE d=${depth} ${name} sensitive=${w.get_sensitive?.() ?? "?"}${extra}`)
        let child = w.get_first_child?.() ?? null
        while (child) {
          walk(child, depth + 1)
          child = child.get_next_sibling?.() ?? null
        }
      }
      walk(page, 0)
    }
    page.set_hexpand(true)
    page.set_vexpand(true)
    win.set_child(page)
    win.present()
    print("RENDER: presented")
    // Dev probe (HALAL_RENDER_FLIP_SWITCH=1): flip the config off then on
    // after present. If the knob slides right after the post-present
    // set_active(true), frame ticks work and only the construction-time
    // paint is wrong; if it stays left, the shell process's frame clock is
    // dead under Xvfb. (add_tick_callback itself segfaults this gjs build
    // on an unrealized widget, proven 2026-11-13 — hence this indirection.)
    if (GLib.getenv("HALAL_RENDER_FLIP_SWITCH") === "1") {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1_000, () => {
        halalAudioConfig.setEnabled(false)
        print("RENDER: flip -> false")
        return GLib.SOURCE_REMOVE
      })
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2_000, () => {
        halalAudioConfig.setEnabled(true)
        print("RENDER: flip -> true")
        return GLib.SOURCE_REMOVE
      })
    }
  } else {
    win.present()
    print("RENDER: presented (no page)")
  }

  } catch (e) {
    print(`RENDER: FAILED: ${e instanceof Error ? e.message : String(e)}`)
    print(`RENDER: STACK: ${e instanceof Error ? e.stack ?? "" : ""}`)
    app.quit()
    return
  }

  // Stay up long enough for the screenshot, then quit: the render
  // script screenshots at ~7s and this exits at 12s.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 12_000, () => {
    app.quit()
    return GLib.SOURCE_REMOVE
  })
})
app.run([])
