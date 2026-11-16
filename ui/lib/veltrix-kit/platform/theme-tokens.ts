// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * VELTRIX TOKEN ENGINE — the whole `--veltrix-*` ramp, for EVERY bundle
 * ==================================================================
 *
 * One config (accent, reduce transparency, window transparency) plus one boolean
 * (is this surface dark?) produce the ~60 custom properties that every Veltrix
 * surface is painted from. The tokens are scoped to the GJS process — external
 * GTK apps are not affected; they get the accent through the portal instead.
 *
 * ⚠️ **It lived in `ui/shell/core/VeltrixTheme.ts` until 2026-08-26, and that was
 * an accident of history, not a coupling.** It imports four things, all of them
 * from `ui/lib/`, and nothing from the shell — but because of where the file sat,
 * the greeter, the lockscreen and the installer could not have it. Each of them
 * grew a hand-typed partial copy of the ramp in its own SCSS, plus
 * `accentCssFor()` for a six-token accent subset, and the copies drifted: the
 * installer's was missing `--veltrix-surface-strong`, so a kit button's hover
 * resolved to nothing at all (GTK4 does not warn about an undefined custom
 * property — the declaration simply does not apply).
 *
 * The shell's own module is still `core/VeltrixTheme.ts`: it re-exports this file
 * and keeps the one piece that IS shell knowledge, the chrome scope naming the
 * shell's four skin surfaces.
 *
 * Feed it from `ui/lib/veltrix-kit/platform/appearance.ts`, which answers the "what did the user
 * pick?" half from the portal or the mirror file, whichever this process can
 * reach.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { readFile, writeFile } from "./file"
import { ACCENT_HEX, ACCENT_NAMES, asAccent, hexToRgb, isValidAccentHex, type AccentKey } from "./accent"
import { DANGER_HEX, WARNING_HEX } from "./status-colors"
import { GLASS_SPECULAR, GLASS_STATE_MIX, GLASS_TINT } from "./tokens"
import { TEXT_INK } from "./glass-legibility"

// -- COLOR PALETTES ---------------------------------------------------
// The accent palette is the single source of truth in ui/lib/veltrix-kit/platform/accent.ts.
// Here we reshape it to { color, name } for existing consumers (Settings, etc).

export const ACCENT_PALETTE = Object.fromEntries(
  (Object.keys(ACCENT_HEX) as AccentKey[]).map((k) => [k, { color: ACCENT_HEX[k], name: ACCENT_NAMES[k] }]),
) as Record<AccentKey, { color: string; name: string }>

export type { AccentKey }

// ── TYPES & INTERFACES ──────────────────────────────────────────────

// There is no shell-skin PIN any more (`shellAppearance`, removed 2026-09-29, #676).
// It existed to keep the shell legible over any wallpaper; on Hyalo the compositor paints
// the shell's glass and turns its ink where the backdrop needs it (references/hyalo.md).

export interface VeltrixThemeConfig {
  accent: AccentKey
  /** The exact accent hex the shell paints (owner, 2026-11-15: the accent is
   *  a real setting again, any #RRGGBB, set by Studio or `appearance.accentHex`).
   *  `accent` above is the NEAREST PRESET NAME to this hex — the name the
   *  outside world sees (`appearance.accent`, the GNOME enum, the hook) — and
   *  is what an old config that never stored a hex falls back to. When the two
   *  disagree, this hex wins for painting: see effectiveAccentHex().
   *  When ABSENT, the named preset's hex is used. The default hex lives in
   *  the GSettings schema default and the ThemeManager store, NOT in
   *  DEFAULT_CONFIG: a default hex here would shadow the `accent` name in
   *  every config built by spreading DEFAULT_CONFIG (the token exporter
   *  enumerates accents exactly that way, and a stale default hex turned
   *  every set cyan). */
  accentHex?: string
  // What the user picks (#674): reduce transparency, from Accessibility. The material
  // choice is gone (2026-10-11): see `GLASS_FLOORS`.
  reduceTransparency: boolean
  /** Settings → Appearance → Windows: Veltrix's windows opaque, tinted or translucent
   *  (`WINDOW_BACKGROUNDS`). */
  windowBackground: WindowBackground
  // ⚠️ DERIVED, never stored: the glass opacity per surface (higher = more opaque) that
  // the two above give, through `glassOpacities`. Whoever changes either of them calls
  // `withGlass` — the painters read these four and nothing else.
  glassFrost: number      // The material's haze over the tint (`frostedFill`)
  barOpacity: number      // Bar capsules (Cairo)
  overlayOpacity: number  // Overlays CC/NC/Prism/… (Cairo)
  dockOpacity: number     // Dock (Cairo)
  windowOpacity: number   // Settings + About windows (CSS tokens)
}

/**
 * The range every glass FLOOR lies in — every entry of `GLASS_FLOORS` below.
 *
 * **Why the floor is 0.24 and not 0.05** (2026-08-23). Until then the floor was
 * 0.05 and the range was documented as "WYSIWYG — no floor": you could drag the
 * glass down to illegible, deliberately. That decision was sound while it was
 * made, because 5% glass was NOT actually 5% of anything — Hyprland's
 * `decoration:blur:brightness = 0.8` was dimming the blurred backdrop under every
 * one of our surfaces by 20%, so the material had a body no token in this repo
 * accounted for. That brightness had to go (it applies at FULL strength the
 * instant a pixel clears `ignore_alpha`, which draws a hard dark step along every
 * antialiased edge — see `tech-debt.md` #81), and removing it took the hidden body
 * with it: white text on 5% glass over a bright wallpaper measured **2.78:1**.
 *
 * 0.24 is the arithmetic of what was removed, not a taste: compositing at alpha α
 * over a backdrop dimmed to 80% is the same coverage as compositing at
 * `0.2 + 0.8·α` over an undimmed one, and `0.2 + 0.8 × 0.05 = 0.24`. So the new
 * floor IS the old default, honestly named.
 *
 * ⚠️ It is a floor, NOT a legibility guarantee: on Hyalo the shell's glass is the
 * compositor's, and legibility is its tone and its ink. `scripts/ci/blur-threshold-check.mjs` reads
 * `min` from this line: it must stay above every layer's `ignore_alpha`.
 */
export const GLASS_RANGE = { min: 0.24, max: 0.80 } as const

/**
 * The `ignore_alpha` every shell layer runs under (`veltrix-bar` and `veltrix-dock` in
 * `config/hypr/hyprland.lua`). A pixel whose alpha
 * is at or below it gets NO backdrop blur. `scripts/ci/blur-threshold-check.mjs`
 * holds every one of those rules to this number — it is one decision in two languages.
 */
export const LAYER_IGNORE_ALPHA = 0.23

/** One layer of an elevation shadow: down by `dy`, blurred over `blur` px, black at `alpha`. */
export type ShadowLayer = { dy: number; blur: number; alpha: number }

/**
 * The elevation shadows — "whisper" range, heavier in dark (less ambient contrast) — as
 * NUMBERS. `--veltrix-shadow-sm/-md` are generated from them, and a widget that draws its
 * own content as textures (the dock's icons, `DockIcon`, through a GSK shadow node) reads
 * the same layers instead of copying a CSS string.
 */
export const ELEVATION_SHADOW: Record<"dark" | "light", Record<"sm" | "md", ShadowLayer[]>> = {
  dark: {
    sm: [{ dy: 1, blur: 2, alpha: 0.20 }, { dy: 1, blur: 1, alpha: 0.16 }],
    md: [{ dy: 2, blur: 8, alpha: 0.28 }, { dy: 1, blur: 2, alpha: 0.18 }],
  },
  light: {
    sm: [{ dy: 1, blur: 2, alpha: 0.06 }, { dy: 1, blur: 1, alpha: 0.04 }],
    md: [{ dy: 2, blur: 8, alpha: 0.08 }, { dy: 1, blur: 2, alpha: 0.05 }],
  },
}

const shadowCss = (layers: ShadowLayer[]) =>
  layers.map(l => `0 ${l.dy}px ${l.blur}px rgba(0,0,0,${l.alpha.toFixed(2)})`).join(", ")

/**
 * The glass: ONE material, no choice (owner, 2026-10-11). Settings → Appearance offered
 * three (#674: clear / regular / frosted) — a choice that predates measuring the reference
 * and never meant what the reference's own setting means, so it only confused the two. What
 * stays is what was its factory position, `regular`: the one every measurement against the
 * reference was made on. How the glass's style becomes configurable is to be decided anew.
 *
 * A floor per surface (`GLASS_FLOORS`) and a compositor blur (`GLASS_BLUR`): the dock,
 * which carries no text, takes thinner glass than a panel full of it (tech-debt #83).
 * They are what glass a client paints itself wears (a control on a pane, the greeter on
 * Hyprland); on Hyalo the shell's panes are the compositor's. The windows are not in it:
 * `WINDOW_BACKGROUNDS`.
 */
export interface GlassFloors { bar: number; overlay: number; dock: number }

/** Per surface. Every entry lies in `GLASS_RANGE`. */
export const GLASS_FLOORS: GlassFloors = { bar: 0.32, overlay: 0.36, dock: GLASS_RANGE.min }

/**
 * Profile-specific floors for shell surfaces that share a Wayland layer with another
 * surface. The launcher is intentionally denser than a generic overlay: it carries a
 * persistent grid of labels, but it is still lighter than a solid application menu.
 *
 * Keep them here, rather than in a widget, so the visual hierarchy remains one token
 * decision and can be calibrated without scattering alpha literals through the shell.
 */
export const GLASS_ROLE_FLOORS = { launcher: 0.42 }

/**
 * Veltrix's WINDOWS are not glass material (owner, 2026-09-30): the glass is the interface's.
 * A window is opaque, TINTED — the colour of what is behind it comes through, heavily
 * blurred: subtle — or TRANSLUCENT — less opaque, less blurred: what is behind it shows
 * (owner, 2026-10-18: one choice, opaque by default; a window that lets anything through is
 * always blurred). Each is ONE pair, its opacity over the window's colour and the blur under
 * it; Hyalo draws both (toolkit/PHASE1.md D6), the shell writes this table into its
 * `[windows.background]` (AppearanceSync), and GTK windows paint the same opacity
 * themselves. Another app's translucent window gets the translucent blur, whatever is
 * chosen here: the tinted one is for the tint, not for seeing through.
 *
 * ⚠️ PROVISIONAL numbers (owner: not measured against the reference yet). The blur is the
 * kawase offset (logical px) and passes, as `GLASS_BLUR`.
 */
export type WindowBackground = "opaque" | "tinted" | "translucent"
export const WINDOW_BACKGROUNDS: Record<Exclude<WindowBackground, "opaque">, { opacity: number, blur: { size: number, passes: number } }> = {
  tinted: { opacity: 0.92, blur: { size: 6, passes: 4 } },
  translucent: { opacity: 0.78, blur: { size: 3, passes: 3 } },
}

/** A stored or served value as a window background: anything else is the default, opaque. */
export function asWindowBackground(v: unknown): WindowBackground {
  return v === "tinted" || v === "translucent" ? v : "opaque"
}

/** The white haze laid over the tint (`frostAt` in glass-legibility.ts). It gives way by
 *  itself as the glass thickens. Provisional. */
export const GLASS_FROST = 0.04

/** The compositor's blur: Hyalo's per surface (a large pane one pass further,
 *  `pieceBlur` in glass-material.ts), Hyprland's `decoration:blur` for everything — which is
 *  what `config/hypr/hyprland.lua` ships, so the shell pushes nothing there. */
export const GLASS_BLUR = { size: 2, passes: 2 }

/**
 * Reduce transparency (Settings → Accessibility → Vision, #674): every glass surface
 * at this opacity — the tint, solid. Hyprland still blurs behind it — nothing of that blur shows — and the
 * blur is left on deliberately: it is ONE compositor option, and switching it off would
 * reach every other app's translucent window, which is not what the switch says.
 */
export const SOLID_GLASS = 1

/** The four opacities the two switches give. The ONE place the table is read. */
export function glassOpacities(reduceTransparency: boolean, windowBackground: WindowBackground):
  Pick<VeltrixThemeConfig, "glassFrost" | "barOpacity" | "overlayOpacity" | "dockOpacity" | "windowOpacity"> {
  if (reduceTransparency) {
    return { glassFrost: 0, barOpacity: SOLID_GLASS, overlayOpacity: SOLID_GLASS, dockOpacity: SOLID_GLASS, windowOpacity: SOLID_GLASS }
  }
  const f = GLASS_FLOORS
  return { glassFrost: GLASS_FROST, barOpacity: f.bar, overlayOpacity: f.overlay, dockOpacity: f.dock,
           windowOpacity: windowBackground === "opaque" ? SOLID_GLASS : WINDOW_BACKGROUNDS[windowBackground].opacity }
}

/** `c` with its four opacities re-derived from reduce transparency and the window
 *  background. Call it after changing either. */
export function withGlass<T extends VeltrixThemeConfig>(c: T): T {
  return Object.assign(c, glassOpacities(c.reduceTransparency, c.windowBackground))
}

export const DEFAULT_CONFIG: VeltrixThemeConfig = withGlass({
  // VELTRIX fork (Phase 0 fix): the default accent is cyan, never Nidara blue.
  // The hex is deliberately absent — the named preset's hex is used (see
  // accentHex above); a default hex here would shadow the name in every
  // config built by spreading DEFAULT_CONFIG.
  accent: "cyan",
  reduceTransparency: false,
  windowBackground: "opaque",
  glassFrost: 0,
  barOpacity: 0, overlayOpacity: 0, dockOpacity: 0, windowOpacity: 0,
})

/** The hex the shell actually paints for a config: the stored `accentHex`
 *  when it is a valid #RRGGBB, else the named preset's hex. The one place
 *  the choice is made, so the token engine, the groupbar and the kit's
 *  Cairo painters cannot disagree about which colour the accent is. */
export function effectiveAccentHex(config: VeltrixThemeConfig): string {
  return isValidAccentHex(config.accentHex)
    ? (config.accentHex as string).toUpperCase()
    : ACCENT_PALETTE[asAccent(config.accent)].color
}

// ── LOGIC ────────────────────────────────────────────────────────────

function generateTokenHeader(config: VeltrixThemeConfig, isDark: boolean): string {
  // effectiveAccentHex: the stored hex when valid, else the named preset's —
  // so a pre-accentHex config can never index ACCENT_PALETTE into undefined.
  const accent = effectiveAccentHex(config)

  const lines = [
    `/* Veltrix Token Engine */`,
    // libadwaita named-colour bridge: AGS force-loads libadwaita in-process (it
    // calls Adw.init), so keep its accent named colours pointed at ours.
    `@define-color accent_bg_color ${accent};`,
    `@define-color accent_fg_color #ffffff;`,
    `@define-color accent_color ${accent};`,
    `* {`,
  ]

  // No `--accent-<key>` tokens any more: they existed only for the shell
  // picker's swatches (`.accent-<key>` in _settings.scss), and the shell has
  // no picker — the accent is picked in Studio (any hex + presets) and
  // arrives here as `accentHex`. The accent itself is `--veltrix-accent` below.

  // No `.nd-icon` rule rides along any more: the shipped drawings are symbolic
  // files, so they take the CSS `color` that `--veltrix-text` above already
  // carries for this mode. This used to append `-gtk-icon-filter: none` in light
  // mode, to undo the invert the sheets applied for dark.
  lines.push(
    ...veltrixVars(config, isDark),
    `}`,
  )
  return lines.join("\n")
}

/**
 * The mode-dependent `--veltrix-*` custom properties (everything between `* {`
 * and `}`). Extracted so the same block can be re-emitted under a scoped
 * selector for the bar/dock chrome override (see generateChromeTokenScope) —
 * the chrome must carry the FULL token family, not just `--veltrix-text`, or its
 * surfaces/edges/shadows would desync from its text colour.
 */
export function veltrixVars(config: VeltrixThemeConfig, isDark: boolean): string[] {
  const accent = effectiveAccentHex(config)
  // Token glass (--veltrix-bg, materials, popovers) tracks the WINDOW opacity — it
  // styles the CSS-painted Settings/About windows (`.veltrix-window-glass` etc.).
  // The Cairo overlays use overlayOpacity directly. WYSIWYG — no legibility floor
  // (removed by design; for contrast raise the slider or pin the shell skin).
  const bgAlphaNum = config.windowOpacity
  const bgAlpha = bgAlphaNum.toFixed(2)

  const popoverBg = isDark ? GLASS_TINT.dark.hex : GLASS_TINT.light.hex
  const popoverAlpha = Math.max(bgAlphaNum, 0.38).toFixed(2)
  const popoverBorder = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)"

  const whiteOrBlack = isDark ? "#ffffff" : "#000000"
  const ink = TEXT_INK[isDark ? "dark" : "light"]
  const r = parseInt(accent.slice(1, 3), 16)
  const g = parseInt(accent.slice(3, 5), 16)
  const b = parseInt(accent.slice(5, 7), 16)
  const fg = isDark ? "255, 255, 255" : "0, 0, 0"
  const bg = isDark ? GLASS_TINT.dark.rgb : GLASS_TINT.light.rgb
  const pbR = parseInt(popoverBg.slice(1, 3), 16)
  const pbG = parseInt(popoverBg.slice(3, 5), 16)
  const pbB = parseInt(popoverBg.slice(5, 7), 16)

  const shadows = ELEVATION_SHADOW[isDark ? "dark" : "light"]
  const sh = { sm: shadowCss(shadows.sm), md: shadowCss(shadows.md) }
  // ⚠️ `--veltrix-edge` (the rim of light) is NOT emitted any more, and neither are
  // the four `--veltrix-material-*` or `--veltrix-shadow-popover`. Buried 2026-09-20,
  // tech-debt #106: the rim is painted in Cairo (`ui/lib/veltrix-kit/platform/glass-paint.ts`, mirrored
  // as numbers in `LOCK_GLASS`), the CSS copy had one reader left — the window card
  // — and #600 correctly took that away by giving window chrome back to Hyprland.
  // A token nothing reads is a value that drifts from the one on screen.

  // The one hover and press of an icon button on glass or in window chrome — the bar's
  // pills (GLASS_STATE_MIX, painted in Cairo), the window controls Hyalo draws (the same
  // numbers in render/controls.rs) and the kit's icon buttons all show these (owner,
  // 2026-10-06: one hover). White ink on dark, the glass's own dark tint on light.
  const stateInk = isDark ? GLASS_SPECULAR : GLASS_TINT.dark
  const stateRgb = [stateInk.r, stateInk.g, stateInk.b].map((v) => Math.round(v * 255)).join(", ")
  const stateMix = (m: { dark: number, light: number }) => (isDark ? m.dark : m.light)

  return [
    `  --veltrix-accent: ${accent};`,
    `  --veltrix-accent-rgb: ${r}, ${g}, ${b};`,
    `  --veltrix-accent-fg: #ffffff;`,
    `  --veltrix-accent-30: rgba(${r}, ${g}, ${b}, 0.3);`,
    `  --veltrix-accent-10: rgba(${r}, ${g}, ${b}, 0.1);`,
    `  --veltrix-bg: rgba(${bg}, ${bgAlpha});`,
    `  --veltrix-surface-back: rgba(${fg}, 0.04);`,
    `  --veltrix-surface: rgba(${fg}, 0.08);`,
    `  --veltrix-surface-hover: rgba(${fg}, 0.12);`,
    `  --veltrix-surface-active: rgba(${fg}, 0.16);`,
    // ── Interaction states ───────────────────────────────────────────────────
    // hover/pressed are MODE-AWARE (--veltrix-surface-hover/-active = rgba(fg,…)):
    // they lighten in dark / darken in light, always moving toward the mode's
    // contrast, so they stay visible on ANY background — including a translucent
    // panel over a dark wallpaper, where a fixed dark "deepen" overlay vanished.
    // Selection is the ONLY place accent enters.
    `  --veltrix-state-selected: rgba(${r}, ${g}, ${b}, ${isDark ? "0.22" : "0.16"});`,
    `  --veltrix-state-hover: rgba(${stateRgb}, ${stateMix(GLASS_STATE_MIX.hover)});`,
    `  --veltrix-state-pressed: rgba(${stateRgb}, ${stateMix(GLASS_STATE_MIX.open)});`,
    `  --veltrix-surface-raised: rgba(${fg}, 0.20);`,
    `  --veltrix-surface-strong: rgba(${fg}, 0.30);`,   // one step above raised, for hover on raised fills
    `  --veltrix-text: ${whiteOrBlack};`,
    // The ramp's alphas live in `TEXT_INK` (glass-legibility.ts), which is also what the
    // tooltips' floors are checked against — so the tiers held to a target are the tiers
    // on screen by construction, not a copy that can drift.
    `  --veltrix-text-secondary: rgba(${fg}, ${ink.secondary});`,
    `  --veltrix-text-dim: rgba(${fg}, ${ink.dim});`,
    `  --veltrix-text-disabled: rgba(${fg}, 0.3);`,
    // The switch thumb. WHITE in both modes, deliberately: it is the moving part
    // of a control whose track goes accent when on, and it has to stay legible
    // against both the accent and the off-track. It is emitted here rather than
    // left in the shell's static block because the switch rules moved to the KIT
    // on 2026-09-20 — every bundle that uses `VeltrixToggleRow` now paints with it.
    `  --veltrix-thumb: #ffffff;`,
    // What is ON in the Control Center (a capsule's icon circle; the 1×1 and the gauge are
    // Cairo's, `ON_WHITE` in tokens.ts): white in both modes, its icon in the accent.
    `  --veltrix-on: #ffffff;`,
    `  --veltrix-danger: ${DANGER_HEX};`,
    `  --veltrix-danger-rgb: ${hexToRgb(DANGER_HEX)};`,
    `  --veltrix-warning: ${WARNING_HEX};`,
    `  --veltrix-popover-bg: rgba(${pbR}, ${pbG}, ${pbB}, ${popoverAlpha});`,
    `  --veltrix-popover-border: ${popoverBorder};`,
    `  --veltrix-shadow-sm: ${sh.sm};`,
    `  --veltrix-shadow-md: ${sh.md};`,
  ]
}

export function generateTokensCss(config: VeltrixThemeConfig, isDark: boolean): string {
  return generateTokenHeader(config, isDark)
}

/**
 * Scoped token sets — `generateSkinFlipScope` in `ui/shell/core/VeltrixTheme.ts`, the
 * full `--veltrix-*` family a surface wears while its skin differs from the shell's (one that
 * follows the system mode: common/ShellGlass.ts). (Until 2026-09-29 the shell PIN used the same scope, `generateChromeTokenScope`;
 * the pin is gone, #676, and the lessons below are why the scope is shaped as it is.)
 *
 * Scope = every toplevel of the shell skin, listed in `CHROME_SCOPE_WINDOWS`.
 * `window#veltrix-bar` hosts the bar content AND the floating overlays that are
 * still children of its `Gtk.Overlay` (CC/NC/Prism/system menu/overview/expansion
 * panel); the dock, the Activity Island and the app grid are each their own
 * toplevel. App-mode windows — Settings (`veltrix-settings-window`) and About
 * (`veltrix-about`) — are SEPARATE toplevels, deliberately NOT in the scope, so
 * they keep the system mode like any third-party app. Nothing else has to be
 * mirrored: the icons are symbolic and follow `--veltrix-text`, which this scope
 * already redefines.
 *
 * ⚠️ THIS LIST IS A COUPLING TO WHICH SURFACES EXIST, AND IT HAS BEEN WRONG
 * BEFORE. It said "bar and dock" from the days when the island and the app grid
 * were children of the bar's window. Both later moved out to their own surfaces
 * (island 2026-07-26, app grid 2026-08-09) and neither was added here, so from
 * then until 2026-08-24 a user who pinned the shell to Dark on a Light system —
 * or the reverse — got a bar and a dock that obeyed and an island and an app grid
 * that did not: wrong tokens AND uninverted icons. The doc comment even claimed
 * the app grid was "scoped separately", which was never true.
 *
 * The same move broke `blur_popups` for the island in the same way (see
 * `config/hypr/hyprland.lua`). A surface leaving the bar's window silently leaves
 * everything that was scoped to the bar's window, which is why
 * `scripts/ci/chrome-scope-check.mjs` now compares this list against the
 * namespaces that actually exist.
 *
 * The selector must hit every DESCENDANT directly (`window#veltrix-bar *`), not
 * just the container: GTK4 custom properties don't inherit reliably, and the
 * global `* { --veltrix-* }` block matches every node directly — so a bare
 * `window#veltrix-bar { --veltrix-* }` only overrides the container itself and the
 * children keep the global value (glass flipped but text stayed). An id-qualified
 * universal beats `*` on specificity.
 */
