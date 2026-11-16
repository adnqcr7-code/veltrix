// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Veltrix — accent palette (single source of truth)
 *
 * Ten named presets: cyan #00E5FF is the default (and the only house accent
 * 2026-11-12 – 2026-11-15), and the other nine are the pre-cyan-only palette,
 * restored as presets by the owner's call of 2026-11-15 ("make the accent
 * customizable"). The picker (Studio, and the shell's own Appearance page)
 * offers these ten — and a theme may ALSO carry any #RRGGBB hex as its
 * accent (`accentHex` in `VeltrixThemeConfig`); the presets are what the
 * nearest-name mapping resolves a custom hex to, and what GNOME's
 * accent-color enum is published as (cyan has no GNOME name, so it
 * publishes as blue). The shell's VeltrixTheme token engine builds its
 * ACCENT_PALETTE from ACCENT_HEX; the greeter and lockscreen build their accent
 * CSS through initAppearance() → generateTokensCss(), NOT via accentCssFor()
 * (which has no live callers — see below). Nothing hardcodes a preset hex
 * value anywhere else; a custom hex lives only in `accentHex`.
 *
 * KEEP IN SYNC: Studio's ACCENT_PRESETS (theme.py) and the portal's copy
 * (bin/veltrix-portal) — same names, same hexes, same nearest rule.
 */

export const ACCENT_HEX = {
  // VELTRIX fork (Phase 0 fix): the default accent is cyan, never Nidara blue.
  // Blue and violet-family purple were REMOVED (Phase 0 fix): blue was Nidara's
  // brand colour and purple sits one hue-step from the banned #6D4AFF. Both are
  // back now ONLY as user-selectable presets (owner, 2026-11-15): the DEFAULT
  // is still cyan, and neither is ever the default or a fallback for a
  // missing value.
  cyan:   "#00E5FF",
  blue:   "#0088FF",
  teal:   "#2190A4",
  green:  "#79B757",
  yellow: "#F3BA4B",
  orange: "#E9873A",
  red:    "#ED5F5D",
  pink:   "#E55E9C",
  purple: "#9A57A3",
  slate:  "#6F8396",
} as const

export type AccentKey = keyof typeof ACCENT_HEX

export const ACCENT_NAMES: Record<AccentKey, string> = {
  cyan:   "Cyan",
  blue:   "Blue",
  teal:   "Teal",
  green:  "Green",
  yellow: "Yellow",
  orange: "Orange",
  red:    "Red",
  pink:   "Pink",
  purple: "Purple",
  slate:  "Slate",
}

/** "#RRGGBB" (any case), the only shape a custom accent hex may take. */
export function isValidAccentHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)
}

/** A preset name, or a valid hex, as a hex string. Anything else → null. */
export function accentHexFor(value: unknown): string | null {
  if (typeof value === "string" && value in ACCENT_HEX) return ACCENT_HEX[value as AccentKey]
  if (isValidAccentHex(value)) return (value as string).toUpperCase()
  return null
}

/** Any stored or served value as an AccentKey: a stale value (or anything
 *  else) resolves to cyan, never to nothing. */
export function asAccent(v: unknown): AccentKey {
  return typeof v === "string" && v in ACCENT_HEX ? (v as AccentKey) : "cyan"
}

/** The GNOME accent-color enum name for a Veltrix preset. GNOME's enum has
 *  no cyan, so cyan publishes as blue; every other preset name IS a GNOME
 *  enum name. Keep in sync with scripts/gen-dconf-defaults.sh. */
export function gnomeAccentForPreset(key: AccentKey): string {
  return key === "cyan" ? "blue" : key
}

/** The GNOME accent-color enum name nearest to a hex colour: nearest preset
 *  (RGB Euclidean distance, same rule as rgbToClosestAccent and Studio's
 *  nearest_accent_preset), then that preset's GNOME name. An invalid hex
 *  publishes the default's name, blue. */
export function nearestGnomeAccent(hex: string): string {
  if (!isValidAccentHex(hex)) return "blue"
  const key = rgbToClosestAccent(
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
  )
  return gnomeAccentForPreset(key)
}

/** "#rrggbb" → "r, g, b" */
export function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r}, ${g}, ${b}`
}

/** (r, g, b) in 0..255 → "#RRGGBB". The inverse of the parse in hexToRgb. */
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
    .toString(16).padStart(2, "0").toUpperCase()
  return `#${c(r)}${c(g)}${c(b)}`
}

/** "#rrggbb" → { r, g, b } as 0..1 floats, what Cairo's setSourceRGBA wants. The
 *  single conversion point for any Cairo draw call that needs a color defined as a
 *  hex string elsewhere (the live accent, a semantic status color). It sits here
 *  rather than in the shell's `common/DrawingUtils.ts` — which re-exports it — so
 *  `veltrix-kit/slider.ts` can fill its track with the accent without reaching into
 *  `ui/shell/`. */
export function hexToFloatRgb(hex: string): { r: number, g: number, b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  }
}

/**
 * CSS block defining the --veltrix-accent* custom properties for a given accent
 * key OR hex. No live callers: the greeter and lockscreen go through initAppearance()
 * → generateTokensCss(), not this function. Kept as the documented runtime
 * override that re-emits the accent tokens (the greeter stylesheet's fallback
 * block is written to stay in lockstep with it). Unknown/empty keys
 * resolve to cyan, never to "".
 *
 * ⚠️ `--veltrix-state-selected` is an ACCENT token and is emitted here, which it was
 * not until 2026-09-07 (tech-debt #92 / issue #323). The login sheet declares it once
 * as the DEFAULT cyan at 0.22, so before cyan-only a user who picked green got green
 * everywhere on the login screen except the selected row of a dropdown, which stayed
 * blue forever — on the two surfaces that have no dev mode to notice it in.
 *
 * 🔑 It is emitted from HERE and not typed in the stylesheet, and the reason outlives
 * the light skin it was written for: a value typed in the sheet would PIN the selection
 * to whatever colour was typed, for every user who chose a different one. Emitting it
 * from the same accent the rest of the screen uses is what keeps it following them.
 * (Until 2026-09-21 this block had a second half under `window.skin-light *`, for the
 * light skin's lighter 0.16 — the skin is gone, see #613.) The alpha is the shell's
 * own, from `ui/lib/veltrix-kit/platform/theme-tokens.ts` ("Selection is the ONLY place accent enters").
 */
export function accentCssFor(accent: string | null | undefined): string {
  // A hex paints itself; a preset name resolves through the palette; anything
  // else resolves to cyan, never "".
  const color = accentHexFor(accent) ?? ACCENT_HEX.cyan
  const rgb = hexToRgb(color)
  return [
    `* {`,
    `  --veltrix-accent:     ${color};`,
    `  --veltrix-accent-rgb: ${rgb};`,
    `  --veltrix-accent-10:  rgba(${rgb}, 0.10);`,
    `  --veltrix-accent-30:  rgba(${rgb}, 0.30);`,
    `  --veltrix-state-selected: rgba(${rgb}, 0.22);`,
    `}`,
  ].join("\n")
}

/** Map an (r, g, b) triple in 0..255 to the closest Veltrix AccentKey:
 *  RGB Euclidean distance over the ten presets. Same rule as Studio's
 *  nearest_accent_preset — the two must agree, or Studio and the shell would
 *  publish different GNOME accent names for the same theme. Callers with a
 *  0..1 triple (the portal) scale it to 0..255 first. */
export function rgbToClosestAccent(r: number, g: number, b: number): AccentKey {
  let best: AccentKey = "cyan"
  let bestD = Infinity
  for (const key of Object.keys(ACCENT_HEX) as AccentKey[]) {
    const hex = ACCENT_HEX[key]
    const pr = parseInt(hex.slice(1, 3), 16)
    const pg = parseInt(hex.slice(3, 5), 16)
    const pb = parseInt(hex.slice(5, 7), 16)
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
    if (d < bestD) { best = key; bestD = d }
  }
  return best
}

