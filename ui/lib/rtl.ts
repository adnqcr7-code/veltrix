// Text direction for Veltrix's five bundles.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// GTK derives a widget's direction from the process locale, but that default
// is not enough here: the greeter live-switches language without changing
// LANG, and the lockscreen and installer resolve their locale from their own
// catalogs — so no bundle can trust the default to be right. Each bundle's
// main() calls applyLocaleDirection() once, with the locale its own i18n
// layer resolved, and any bundle that switches language at runtime re-applies
// it on every switch (greeter setLocale, installer setLocale).
//
// This is also the ONE place that knows which locales are RTL. Arabic is the
// only RTL locale Veltrix ships (2026-11-12, bilingual feature); when a second
// one arrives, it is added here and every bundle follows.
//
// What this does NOT do: force a direction on any widget. Widgets inherit the
// process default, and the kit's START/END alignments and the `:dir(rtl)` CSS
// overrides do the mirroring from there. The single exception is the Quran
// verse label in the Content Safety interstitial (safety.ts), which is
// explicitly RTL because the verse is Arabic in every locale.
//
// ─── WHAT "MIRROR" MEANS HERE ───────────────────────────────────────────────
// The dock mirrors: its internal order follows the direction, like every
// other row. That is the RTL standard, and the brief for the bilingual
// feature chose it over keeping the dock LTR as a macOS-fidelity deviation
// (Adnan to confirm). Nothing in the tree forces LTR anywhere: the only
// forced direction before this file was the verse label above.
import Gtk from "gi://Gtk?version=4.0"

/** The RTL locales Veltrix ships, as BCP 47 / POSIX prefixes. Arabic only, for now. */
const RTL_LOCALES = ["ar"]

/**
 * True when a locale reads right-to-left. Accepts the forms the bundles pass
 * around: "ar", "ar-SA", "ar_SA.UTF-8" — the prefix match is on the language
 * subtag, so a regional variant follows its language.
 */
export function isRtlLocale(locale: string): boolean {
  const lang = locale.toLowerCase().replace("_", "-").split("-")[0]
  return RTL_LOCALES.includes(lang)
}

export function directionForLocale(locale: string): Gtk.TextDirection {
  return isRtlLocale(locale) ? Gtk.TextDirection.RTL : Gtk.TextDirection.LTR
}

/**
 * Set the process-wide default direction from a locale. Call in main(),
 * before the first window exists, so every widget created afterwards inherits
 * it; call again on any runtime language switch. Idempotent and cheap — it is
 * a single GTK call, so a bundle that is unsure whether the direction is
 * already right calls it anyway rather than tracking state.
 */
export function applyLocaleDirection(locale: string): void {
  Gtk.Widget.set_default_direction(directionForLocale(locale))
}

/**
 * The direction icon lookups must use. `Gtk.Widget.get_default_direction()`
 * answers with whatever applyLocaleDirection() set (or GTK's locale-derived
 * default before any call), so an icon name that flips with direction —
 * "pan-start" vs "pan-end", a back chevron — resolves against the live
 * direction instead of a hardcoded LTR. Use this wherever the old code wrote
 * `Gtk.TextDirection.LTR` as a lookup argument.
 */
export function iconDirection(): Gtk.TextDirection {
  return Gtk.Widget.get_default_direction()
}
