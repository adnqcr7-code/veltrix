// Auto-sleep — the timeout the Settings → Power toggle restores (2026-11-13).
//
// The split, and why it is split this way:
//
// - The toggle itself is NOT stored anywhere. It IS the live effective suspend:
//   `getIdleConfig().suspend > 0` — a suspend listener present in hypridle.conf
//   on Hyprland, a nonzero `suspend` in Hyalo's `[idle]`. The toggle reads it
//   back from the same place it writes it (PowerConfig → the compositor's
//   `setIdle`), so the switch always shows the true current state — including
//   a suspend listener veltrix-setup seeded on a battery laptop, or one a hand
//   edit added. Storing the toggle separately would let the two disagree.
//
// - What IS stored, here in GSettings `org.veltrix.power`, is the timeout the
//   toggle restores when switched back on (`auto-sleep-timeout`). Turning
//   auto-sleep off writes an effective suspend of 0 — which on its own would
//   destroy the user's chosen timeout, so the next "on" would have nothing to
//   restore. The timeout lives here instead, and the Suspend dropdown edits
//   it, not the effective value: with auto-sleep off, picking a timeout only
//   remembers it (no hypridle rewrite, no restart); with auto-sleep on, it
//   also applies live.
//
// - The stored timeout is a `computed` field: its TypeScript default is seeded
//   once, at first load, from the effective suspend in force right then — so
//   a laptop whose setup seeded 30 min keeps 30 min, and a desktop that never
//   suspended defaults to 30 min for the day auto-sleep is first switched on.
//   After that the stored value is the truth, never re-seeded.
//
// Stored in GSettings `org.veltrix.power`, key `auto-sleep-timeout` (uint32
// seconds). A schema that is not installed gives a store that works in memory
// and persists nothing (see core/configFile.ts) — the toggle still works for
// the session, and the effective suspend still persists in hypridle.conf /
// Hyalo's settings layer; only a custom timeout choice is lost on reload
// until the schema is (re)installed.

import { defineSettings } from "./configFile"
import { getIdleConfig } from "./PowerConfig"

/** The timeouts the Suspend dropdown offers, in seconds. */
export const AUTO_SLEEP_TIMEOUTS = [900, 1800, 3600, 7200, 10800] as const

/** The timeout auto-sleep restores when switched on, when nothing is in force yet. */
export const AUTO_SLEEP_DEFAULT_TIMEOUT = 1800

interface AutoSleepSettings {
    /** Seconds of inactivity auto-sleep waits before suspending, when it is on. */
    autoSleepTimeout: number
}

/** Seed from the suspend already in force, so an existing timeout survives
 *  the first load instead of being reset to the default. A failure to read
 *  (no compositor reachable yet) falls back to the default. */
function seedTimeout(): number {
    try {
        const suspend = getIdleConfig().suspend
        return suspend > 0 ? suspend : AUTO_SLEEP_DEFAULT_TIMEOUT
    } catch {
        return AUTO_SLEEP_DEFAULT_TIMEOUT
    }
}

const config = defineSettings<AutoSleepSettings>("power", {
    autoSleepTimeout: seedTimeout(),
}, {
    autoSleepTimeout: v => Number.isInteger(v) && v >= 0 && v <= 86400,
}, { computed: ["autoSleepTimeout"] })

export const autoSleepConfig = {
    get timeout() { return config.get("autoSleepTimeout") },

    setTimeout(secs: number): void {
        config.set("autoSleepTimeout", Math.round(secs))
    },

    onChange(fn: (key: keyof AutoSleepSettings) => void): () => void {
        return config.subscribeAll(fn)
    },

    subscribe<K extends keyof AutoSleepSettings>(key: K, cb: (v: AutoSleepSettings[K]) => void): () => void {
        return config.subscribe(key, cb)
    },
}

export default autoSleepConfig
