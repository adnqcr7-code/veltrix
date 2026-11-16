// Dev-only render harness — NOT shipped, no bundle references this file.
//
// Paints ONE installer step (the InterfaceStep: "Choose your interface")
// in a plain GTK window under Xvfb, with the installer's own CSS. It
// exists because the full installer flow cannot start in this VM: the
// window needs the real base.json (only the live medium ships it), and
// without it the installer shows "not a Veltrix medium" instead of a
// first step. The step itself never touches base.json, so this renders
// the real step code — the real cards, the real preview images, the
// real CSS — without the wizard chrome around it. Label any screenshot
// from it "standalone step render under Xvfb", never "the installer".
//
//   cd ~/workspace/veltrix/fork   # CWD matters: the step resolves its
//   # preview images relative to the checkout (./ui/installer/assets/)
//   VELTRIX_INSTALLER_ROOT=ui/installer \
//   GSETTINGS_SCHEMA_DIR=/tmp/veltrix-schemas \
//   DISPLAY=:99 gjs -m /tmp/installer-step.js
//
// The var() flattening is the same VM-only workaround as
// scripts/dev/ipad-panel-render.ts: this VM's GTK is 4.14.5 and var()
// needs 4.16, so the token values are substituted literally before
// loading (see that file's comment for the full proof).

import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import { veltrixVars, DEFAULT_CONFIG } from "../../ui/lib/veltrix-kit/platform/theme-tokens"

// NOTE: the step is imported DYNAMICALLY inside "activate", not at the
// top level — same display reason as the panel harness (a static import
// runs before the application has a display).

const INSTALLER_ROOT = GLib.getenv("VELTRIX_INSTALLER_ROOT")
if (!INSTALLER_ROOT) throw new Error("VELTRIX_INSTALLER_ROOT is required (ui/installer)")

function loadCss(path: string): void {
  const provider = new Gtk.CssProvider()
  provider.load_from_path(path)
  Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(),
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
  )
}

const app = new Gtk.Application({ application_id: "org.veltrix.installer-render" })
app.connect("activate", async () => {
  print("RENDER: activate")
  const win = new Gtk.ApplicationWindow({ application: app })
  win.set_default_size(1280, 800)
  win.set_title("Interface step — standalone render (Xvfb)")
  // The step's selection-ring rule is scoped to the installer window
  // (`window.veltrix-installer-window .installer-interface-card.is-selected`):
  // without this class the faithful render shows no ring (fix pass #1,
  // fidelity #2 — the v1 harness was missing it). Cursor hidden for the
  // same reason as the panel harness (the × marred the v1 render).
  win.add_css_class("veltrix-installer-window")
  win.set_cursor(Gdk.Cursor.new_from_name("none", null))
  print("RENDER: window built")
  const { InterfaceStep } = await import("../../ui/installer/steps/interface")
  print("RENDER: step imported")

  // ── Tokens, flattened (VM-only workaround — see the header) ────────
  const tokenLines = veltrixVars(DEFAULT_CONFIG, true)
  const tokens = new Map<string, string>()
  for (const line of tokenLines) {
    const m = /--([a-z0-9-]+):\s*([^;]+);/.exec(line)
    if (m) tokens.set(m[1], m[2].trim())
  }
  const readText = (path: string): string => {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok || !bytes) throw new Error(`cannot read ${path}`)
    return new TextDecoder().decode(bytes)
  }
  const kitText = readText(`${INSTALLER_ROOT}/../lib/veltrix-kit/kit.css`)
  const styleText = readText(`${INSTALLER_ROOT}/style.css`)
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
  loadCss(flattenText(styleText, "veltrix-render-flat-installer.css"))
  print("RENDER: style.css done (flattened)")
  if (unresolved > 0) print(`RENDER: WARNING ${unresolved} var() left unresolved`)
  print("RENDER: css done")

  const step = InterfaceStep()
  const widget = step.build(() => {})
  print("RENDER: step built")
  // The wizard centres the step in the real VeltrixClamp
  // (WINDOW_LAYOUT.wizardContent = 900, contentFloor = 560) — the same
  // call InstallerWindow makes — so the 480px previews are constrained
  // exactly as the real installer constrains them.
  const { VeltrixClamp } = await import("../../ui/lib/veltrix-kit/clamp")
  const clamped = VeltrixClamp(widget, 900, true, 560)
  const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true })
  outer.set_halign(Gtk.Align.CENTER)
  outer.set_valign(Gtk.Align.CENTER)
  outer.append(clamped)
  win.set_child(outer)
  win.present()
  print("RENDER: presented")

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 12_000, () => {
    app.quit()
    return GLib.SOURCE_REMOVE
  })
})
app.run([])
