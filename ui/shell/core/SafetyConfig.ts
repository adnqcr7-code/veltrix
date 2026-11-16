import { defineSettings } from "./configFile"
import { applySystemFilter, todayStr } from "./ContentSafety"

// Safety — Settings → Safety ("Block adult websites").
//
// 🔑 `contentFilter` is the LIVE flag, not a preference about it: the Settings
// toggle, the re-enable nudge and the agent key `safety.contentFilter` are
// three faces of this one bit, and this file is its ONLY home (same shape as
// NotifConfig's doNotDisturb).
//
// The bit is stored in GSettings `org.veltrix.safety`, but the SYSTEM state
// (CleanBrowsing DNS + the hosts block) is applied by the privileged helper
// `veltrix-content-safety` (see ContentSafety.ts). The store is only written
// AFTER the helper succeeds, so the two can never disagree in the direction
// that matters: a failed or cancelled apply leaves the bit — and the system —
// exactly as they were.
//
// Default ON is Adnan's explicit call (2026-11-12), recorded as a deviation
// from halal rubric 6.3 ("offered during setup, opt-in") in
// docs/content-safety-report.md and BUILD_LOG.md. Do not "fix" the default
// back to false without him.
interface SafetySettings {
    contentFilter: boolean  // default true
    lastNudgeDate: string   // YYYY-MM-DD the re-enable reminder was last shown; "" = never
    turnedOffDate: string   // YYYY-MM-DD the protection was last turned off; "" = on / never
}

const DEFAULTS: SafetySettings = {
    contentFilter: true,
    lastNudgeDate: "",
    turnedOffDate: "",
}

type SafetyKey = keyof SafetySettings

const config = defineSettings("safety", DEFAULTS)

// One apply at a time (fix pass, 2026-11-12): tapping ON while a pkexec
// prompt is still pending, then OFF through the interstitial, used to run
// two applies interleaved, and the final bit depended on which one
// finished last. Applies now serialise — a second call waits for the
// first, then re-checks the bit (the first call may already have reached
// the state it wanted) before starting its own apply.
let inflight: Promise<void> | null = null

export const safetyConfig = {
    get contentFilter() { return config.get("contentFilter") },
    get lastNudgeDate() { return config.get("lastNudgeDate") },
    get turnedOffDate() { return config.get("turnedOffDate") },

    /**
     * Turn the protection on or off: apply the system layers FIRST (pkexec
     * helper — may prompt for the admin password, may be cancelled), and
     * only then write the bit. Throws on failure or cancellation; the caller
     * (Settings' runSettingsAction, the nudge) reports or swallows it, and
     * the bit stays where it was.
     *
     * `force` re-applies even when the bit already equals the requested
     * value (R2): the Safety page offers it when the bit says ON but the
     * live status says off/partial — without it the only recovery was
     * off-then-on through the 60-second interstitial. The apply still runs
     * first and the bit is still only written on success; with the bit
     * already true the writes are no-ops.
     *
     * `force` is ON-ONLY (M1, fix pass #3): the 60-second reflective pause
     * lives in the Settings page's OFF handler, not in this store, so a
     * future `setContentFilter(false, { force: true })` would have skipped
     * the reflection with one flag. The store rejects it outright, so no
     * caller can ever do that — today the only `force` caller is the Safety
     * page's Apply button, ON direction only.
     */
    async setContentFilter(on: boolean, opts?: { force?: boolean }): Promise<void> {
        if (opts?.force && !on) {
            throw new Error("[SafetyConfig] force is on-only: it may not skip the reflective pause for turning protection off")
        }
        // Serialise with any apply already in flight (see `inflight` above):
        // wait for it, swallowing its error — it is that caller's to report —
        // then re-check, since it may already have reached the wanted state.
        if (inflight) {
            await inflight.catch(() => {})
        }
        if (!opts?.force && config.get("contentFilter") === on) return
        const run = (async () => {
            await applySystemFilter(on)
            config.set("contentFilter", on)
            config.set("turnedOffDate", on ? "" : todayStr())
        })()
        inflight = run
        try {
            await run
        } finally {
            if (inflight === run) inflight = null
        }
    },

    markNudgedToday() {
        config.set("lastNudgeDate", todayStr())
    },

    onChange(fn: (key: SafetyKey) => void): () => void {
        return config.subscribeAll(fn)
    },

    subscribe<K extends SafetyKey>(key: K, cb: (v: SafetySettings[K]) => void): () => void {
        return config.subscribe(key, cb)
    },
}

export default safetyConfig
