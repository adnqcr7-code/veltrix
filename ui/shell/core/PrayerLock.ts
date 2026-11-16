// Prayer Lock — the "Go pray" + 60-second lock (Phase 6, Islamic core).
//
// At each prayer time the system shows a full-screen overlay naming the
// specific prayer ("Go pray — Fajr", …) and locks for 60 seconds, then
// unlocks automatically. Adnan's words (2026-11-12): "when it's prayer time
// the system says go pray and come asha or what ever at the time and it
// should lock for 60s and then it goes to normal."
//
// ── WHO OWNS WHAT (the safety design — read bin/veltrix-prayer-lock first)
// This module is ONLY a scheduler. It polls `veltrix-prayer-times --due`
// once a minute and, when a prayer is due, spawns `veltrix-prayer-lock` and
// forgets it. The LOCK ITSELF — the overlay, the 60-second timer, the
// watchdog that ends it — lives entirely in that separate process, which
// calls os.setsid() at start: killing or crashing THIS shell cannot strand
// the user, because the shell holds no handle on the lock's lifetime. If
// this module is wrong, the worst case is a lock that fires late, early, or
// not at all — never a lock that never ends. See docs/prayer-lock-report.md
// for the edge-case decisions (sleep/wake, clock jumps, two prayers due,
// mid-typing, fullscreen apps) and the verification record.
//
// ── One deliberate escape: hold Esc for 3 s (fix pass #1)
// There is no setting, no click and no other keybind that dismisses the
// lock — the ONLY escape is holding Escape for 3 continuous seconds (an
// emergency override for a wrong-time or emergency lock; the hint is
// printed on the overlay, and every early exit is logged). The opt-out
// question (should a future version offer one, and what would it cost the
// feature's purpose?) is CLOSED: the Esc hold is the answer, per
// docs/prayer-lock-report.md and bin/veltrix-prayer-lock's header. The
// no-skip default is unchanged — Adnan asked for a lock, not a reminder.
// Per-prayer minute offsets and a method/madhab choice are a later
// Settings item, not this module.
//
// ── Failure mode: no data, no lock
// Prayer times come from al-falak, offline, via the helper. If the helper
// is missing (al-falak not installed — exit 3) or fails, nothing fires and
// nothing is faked: the bar simply never locks, and one warning is logged
// per outage. A failed poll never clears a good schedule either — the next
// minute retries.
import GLib from "gi://GLib"
import { execAsync, spawn } from "../../lib/process"

/** How often the scheduler asks the helper what is due. */
const POLL_MS = 60_000
/** A helper read that never returns is a hung scheduler, not a slow one. */
const HELPER_TIMEOUT_MS = 10_000
/** The lock length, in seconds — the same number the lock process defaults
 *  to. The shell passes it explicitly so the two can never drift apart. */
const LOCK_SECONDS = 60
/**
 * After spawning a lock for a prayer, do not spawn for the same prayer
 * again for this long. The helper's --due grace window is 300 s, so without
 * this the minute poll would re-spawn the lock four more times for the same
 * prayer. The lock process ALSO refuses a second live lock (its state file),
 * so this is the scheduler's half of a two-layer dedup, not the only one.
 */
const RESPAWN_SUPPRESS_MS = 10 * 60_000

/** The prayer a --due poll can name. */
export type PrayerName = "Fajr" | "Dhuhr" | "Asr" | "Maghrib" | "Isha"

const PRAYERS: readonly PrayerName[] = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]

function isPrayerName(value: string): value is PrayerName {
    return (PRAYERS as readonly string[]).includes(value)
}

/**
 * Key for the respawn suppressor: one prayer on one day. A clock jumped
 * backwards across midnight could otherwise re-fire yesterday's prayer.
 */
function suppressKey(prayer: PrayerName, when: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${prayer}@${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

class PrayerLockScheduler {
    private _started = false
    private _polling = false
    /** A failure has already been logged for the current outage. */
    private _warned = false
    /** Last spawn, per prayer-day — the respawn suppressor. */
    private _lastSpawn = new Map<string, number>()

    /** Idempotent: start the minute poll and check once now. Called by app.ts. */
    start(): void {
        if (this._started) return
        this._started = true
        void this.poll()
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            void this.poll()
            return GLib.SOURCE_CONTINUE
        })
    }

    async poll(): Promise<void> {
        if (this._polling) return
        this._polling = true
        try {
            const out = await execAsync(["veltrix-prayer-times", "--due"],
                { timeoutMs: HELPER_TIMEOUT_MS })
            this._warned = false
            const prayer = out.trim()
            if (!isPrayerName(prayer)) {
                // --due prints exactly one prayer name, or exits 1 (nothing
                // due, which execAsync turns into a rejection — see below).
                // Anything else is a helper talking nonsense: ignore it,
                // never spawn a lock for a prayer the helper did not name.
                if (prayer !== "") {
                    console.warn(`[PrayerLock] veltrix-prayer-times --due printed unexpected output: ${JSON.stringify(out)}`)
                }
                return
            }
            const now = new Date()
            const key = suppressKey(prayer, now)
            const last = this._lastSpawn.get(key)
            if (last !== undefined && now.getTime() - last < RESPAWN_SUPPRESS_MS) return
            this._lastSpawn.set(key, now.getTime())
            // Prune the suppressor so it cannot grow without bound: one
            // entry per prayer-day, and a day is long past after 48 h.
            for (const [k, at] of this._lastSpawn) {
                if (now.getTime() - at > 48 * 3600_000) this._lastSpawn.delete(k)
            }
            this.spawnLock(prayer)
        } catch (e) {
            // Exit 1 from --due is "nothing due" — the normal case, not an
            // error. execAsync rejects with the helper's stderr, which is
            // empty for exit 1; a real failure carries a message.
            const message = e instanceof Error ? e.message : String(e)
            if (message.trim() === "") return
            if (!this._warned) {
                this._warned = true
                console.warn("[PrayerLock] veltrix-prayer-times --due failed (prayer lock unavailable):", e)
            }
        } finally {
            this._polling = false
        }
    }

    /**
     * Fire and forget. The child calls os.setsid() at start and owns its
     * own 60-second deadline plus a watchdog — this process never waits on
     * it, never kills it, and its death cannot strand the user. spawn() is
     * the one door for child processes (commandment 11): it strips
     * GTK_THEME so the lock's GTK does not inherit our no-theme env.
     */
    private spawnLock(prayer: PrayerName): void {
        try {
            spawn(["veltrix-prayer-lock", "--prayer", prayer,
                "--duration", String(LOCK_SECONDS)])
            console.log(`[PrayerLock] lock spawned for ${prayer} (${LOCK_SECONDS}s)`)
        } catch (e) {
            console.error(`[PrayerLock] failed to spawn veltrix-prayer-lock for ${prayer}:`, e)
        }
    }
}

export const prayerLockScheduler = new PrayerLockScheduler()

/** Start the minute poll. Called once from app.ts main(). */
export function startPrayerLock(): void {
    prayerLockScheduler.start()
}

export default prayerLockScheduler
