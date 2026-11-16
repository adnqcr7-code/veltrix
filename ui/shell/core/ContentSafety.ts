// Content Safety — the system side of Settings → Safety, and the daily
// re-enable nudge. Two halves that must not be confused:
//
//  1. `applySystemFilter` / `getFilterStatus`: the privileged apply. The
//     Settings toggle, the agent key and the nudge all go through
//     SafetyConfig.setContentFilter, which calls `applySystemFilter` FIRST
//     and only then writes the GSettings bit — so a failed or cancelled
//     apply can never leave the bit saying something the system is not.
//
//  2. `startContentSafetyNudge`: the once-a-day reminder while the
//     protection is off. It runs in the SHELL (started from app.ts), not in
//     Settings, because Settings is a separate application that exits on
//     close — a reminder owned by it would only fire while its window was
//     open. It sends a real notification through the session daemon with a
//     "Turn protection back on" action, and the tap comes back to the shell
//     as an ActionInvoked signal — which is why the notification is sent
//     over the shell's own D-Bus connection, not via `notify-send`: a
//     notify-send process exits at once, and the daemon answers an action
//     tap with "notification sender unknown or disconnected" when the
//     sender is already gone. The shell is alive for the whole session, so
//     the tap reaches it.
//
// Nudge rules (the no-nag contract, all local, no account, no telemetry):
//   - at most once per calendar day (lastNudgeDate in org.veltrix.safety);
//   - never on the day the user turned it off (turnedOffDate) — the day
//     they chose, after a 60-second reflection, is not the day to ask again;
//   - the date is marked the moment the notification is SENT, so dismissing
//     it does not make it reappear the same day;
//   - one tap re-enables (the usual pkexec prompt applies); cancelling that
//     prompt leaves the protection off and does not re-nudge today.
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync, spawn } from "../../lib/process"
import { t } from "./i18n"
import { SHELL_ROOT } from "./Paths"

/** Local YYYY-MM-DD for the nudge dates. */
export const todayStr = (): string => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── Privileged apply ────────────────────────────────────────────────────────

/** The pkexec prompt was dismissed (exit 126, same convention as the
 *  language row in Settings → Region): nothing failed, nothing changed. */
export class ApplyCancelled extends Error {
    constructor() { super("cancelled") }
}

/**
 * Run the privileged helper. Throws ApplyCancelled if the user dismisses the
 * polkit prompt, or an Error carrying the helper's stderr on a real failure.
 * Writes nothing to any store — the caller does that only on success.
 */
export async function applySystemFilter(on: boolean): Promise<void> {
    const proc = spawn(["pkexec", "veltrix-content-safety", on ? "on" : "off"],
        Gio.SubprocessFlags.STDERR_PIPE)
    const [ok, _out, err] = await new Promise<[boolean, string, string]>((resolve) => {
        proc.communicate_utf8_async(null, null, (_: any, res: any) => {
            try {
                const [_ok, out, errText] = proc.communicate_utf8_finish(res)
                resolve([proc.get_successful(), out ?? "", errText ?? ""])
            } catch (e) {
                console.error("[ContentSafety] veltrix-content-safety:", e)
                resolve([false, "", String(e)])
            }
        })
    })
    // 126 = the password prompt was dismissed: nothing failed, nothing changed.
    const cancelled = !ok && proc.get_if_exited() && proc.get_exit_status() === 126
    if (cancelled) throw new ApplyCancelled()
    if (!ok) {
        throw new Error((err ?? "").trim() || "veltrix-content-safety failed")
    }
}

export interface FilterStatus {
    on: "on" | "off" | "partial"
    dns: { servers: string[]; dropin: boolean; dispatcher: boolean; resolved_active: boolean | null; resolv_conf: string; resolved_loaded: boolean | null }
    hosts: { blocked: number; total: number; present: boolean }
}

/** Read the helper's status (unprivileged, no pkexec). Null when the helper
 *  cannot be run at all — the Settings page then says so instead of guessing. */
export async function getFilterStatus(): Promise<FilterStatus | null> {
    try {
        const out = await execAsync(["veltrix-content-safety", "status"], { timeoutMs: 5000 })
        return JSON.parse(out) as FilterStatus
    } catch (e) {
        console.error("[ContentSafety] status:", e)
        return null
    }
}

// ── The daily nudge ─────────────────────────────────────────────────────────
// Plus the startup reconcile (M2, fix pass, 2026-11-12): the bit defaults
// ON, but nothing applied the system layers on a fresh install until the
// install-time apply landed — and an out-of-band change (another user, a
// direct helper run) can desync them later. At startup the shell reads the
// helper's unprivileged `status`; if the bit says ON but the system is
// off/partial, it shows ONE notification offering one-tap "Apply
// protection". No surprise pkexec prompt at login: nothing is applied
// until the user taps.
//
// Both notifications share ONE path — the notifier below owns the bus, the
// subscription and the in-flight send, so the nudge and the reconcile never
// each half-own it. Same action (`reenable` → setContentFilter(true)),
// same once-a-day mark, same no-nag contract.

const NOTIF_IFACE = "org.freedesktop.Notifications"
const NOTIF_PATH = "/org/freedesktop/Notifications"
const REENABLE_ACTION = "reenable"

/** The slice of the safety store the nudge needs — structural, so this module
 *  never imports SafetyConfig (which imports this module for the apply). */
export interface SafetyStore {
    readonly contentFilter: boolean
    readonly lastNudgeDate: string
    readonly turnedOffDate: string
    setContentFilter(on: boolean): Promise<void>
    markNudgedToday(): void
    subscribe(key: "contentFilter", cb: (v: boolean) => void): () => void
}

export function startContentSafetyNudge(store: SafetyStore): void {
    const n = safetyNotifier(store)

    const maybeNudge = () => {
        if (store.contentFilter) return
        const today = todayStr()
        if (store.turnedOffDate === today) return
        if (store.lastNudgeDate === today) return
        // The bus may have been absent at startup (S2, fix pass): retry the
        // subscription here, so a notification sent later still has its tap
        // answered. ensureSubscription() is idempotent.
        n.ensureSubscription()
        n.notify(t("settings.safety.nudge.title"), t("settings.safety.nudge.body"),
            t("settings.safety.nudge.action"), {
                // S3 (fix pass #3): the subscription may resolve after the
                // user turned protection back on — do not show a stale nudge.
                stillValid: () => !store.contentFilter,
            })
    }

    n.ensureSubscription()

    // Re-check when the bit flips off mid-session, on start, and hourly
    // (which is what catches "still off tomorrow").
    store.subscribe("contentFilter", (on) => { if (!on) maybeNudge() })
    maybeNudge()
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3600, () => {
        maybeNudge()
        // R1: the reconcile is the other half of M2 — a startup run missed
        // because the bus was absent or status transiently failed gets
        // another chance here, once an hour. It self-guards (bit off /
        // already offered today / status on → nothing), so this is a
        // re-check, not a nag.
        reconcileContentSafety(store)
        return GLib.SOURCE_CONTINUE
    })
}

/**
 * Reconcile the bit with the system at shell startup (M2, fix pass):
 * if the bit says ON but the helper reports off/partial, show ONE
 * notification offering one-tap "Apply protection" — the same nudge path
 * (same action, same once-a-day mark). Nothing is applied until the user
 * taps: no pkexec prompt at login, ever, from this path.
 *
 * R1 (fix pass #2): the check used to fire exactly once, so a bus absent
 * at startup or a transiently failing `status` lost the reconcile until
 * the next login. It now retries, bounded, with backoff — the hypr-ipc
 * shape (delay doubles from 1s, capped at 30s), at most 5 attempts — and
 * the nudge's hourly tick re-runs it as well. A sent notification still
 * marks the day, so a retry can never re-notify after a dismissal.
 */
export function reconcileContentSafety(store: SafetyStore): void {
    if (!store.contentFilter) return
    const MAX_ATTEMPTS = 5
    let attempt = 0
    let retryDelayS = 1
    const scheduleRetry = () => {
        if (attempt >= MAX_ATTEMPTS) return
        const delay = retryDelayS
        retryDelayS = Math.min(retryDelayS * 2, 30)
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            tryOnce()
            return GLib.SOURCE_REMOVE
        })
    }
    const tryOnce = () => {
        attempt += 1
        void getFilterStatus().then((st) => {
            if (!store.contentFilter) return
            // Cannot check (helper missing, transient failure) — say
            // nothing yet, but retry: a null here is not a verdict.
            if (!st || st.on === "on") {
                if (!st) scheduleRetry()
                return
            }
            // Once a day, like the nudge: a user who dismisses it is not asked
            // again at every login.
            if (store.lastNudgeDate === todayStr()) return
            const n = safetyNotifier(store)
            n.ensureSubscription()
            // notify() is false only when there is no bus to send on (or a
            // send is already in flight) — a queued send, waiting on the
            // subscription, counts as sent. Retry the unsent case.
            if (!n.notify(t("settings.safety.reconcile.title"), t("settings.safety.reconcile.body"),
                t("settings.safety.reconcile.action"), {
                    // M5 (fix pass #3): a Notify that fails after the bus
                    // existed used to vanish — notify() returns true for a
                    // queued send, so no retry was ever scheduled and the
                    // next chance was the hourly tick. The failure now
                    // calls back into this reconcile's bounded retry.
                    onFailed: () => scheduleRetry(),
                    // S3 (fix pass #3): by the time the subscription
                    // lands, the user may already have applied protection
                    // via Settings — re-check before showing anything, so
                    // a stale notification never appears.
                    stillValid: async () => {
                        if (!store.contentFilter) return false
                        const st = await getFilterStatus()
                        return st !== null && st.on !== "on"
                    },
                })) scheduleRetry()
        })
    }
    tryOnce()
}

// ── Shared notification path (nudge + reconcile) ──────────────────────────

/** The Veltrix mark, as the notification's app icon — an absolute path, so
 *  the banner and the Center draw the V mark even though no desktop file
 *  names this sender. The mark (veltrix-symbolic.svg), not the full lockup
 *  (veltrix-logo.svg): the lockup is the design source, and at notification
 *  sizes its wordmark would be unreadable. (An empty app_icon left the
 *  banner's icon to the daemon resolving it from the app name; a path is
 *  explicit.) The NotificationCenter fallback handles absolute paths. */
const APP_ICON = `${SHELL_ROOT}/assets/veltrix/assets/veltrix-symbolic.svg`

interface SafetyNotifier {
    ensureSubscription(): void
    /** True when the notification was sent (or queued for the subscription
     *  still resolving); false when there is no bus to send on. `opts`
     *  carries the fix-pass-#3 hooks: `onFailed` runs when a queued send's
     *  Notify call itself fails, and `stillValid` is re-checked before a
     *  pending send is flushed, so a stale notification never appears. */
    notify(summary: string, body: string, actionLabel: string, opts?: {
        onFailed?: () => void
        stillValid?: () => boolean | Promise<boolean>
    }): boolean
}

// One notifier per process, bound to the first store it is given — the shell
// passes the same safetyConfig to the nudge and the reconcile, so this is
// one owner, not two half-owners.
let notifier: SafetyNotifier | null = null

function safetyNotifier(store: SafetyStore): SafetyNotifier {
    if (notifier) return notifier
    let sending = false
    let subscribed = false
    let subscribing = false
    let subId = 0
    let conn: Gio.DBusConnection | null = null
    // The id Notify returned for the most recent notification we sent
    // (0 = none), and the daemon's unique bus name once resolved.
    let lastNotifId = 0
    let daemonOwner: string | null = null
    // One send held while the subscription is still resolving (N1 below).
    let pending: {
        summary: string; body: string; actionLabel: string
        onFailed?: () => void
        stillValid?: () => boolean | Promise<boolean>
    } | null = null

    const bus = (): Gio.DBusConnection | null => {
        if (conn) return conn
        try {
            conn = Gio.bus_get_sync(Gio.BusType.SESSION, null)
        } catch (e) {
            console.error("[ContentSafety] no session bus for the nudge:", e)
            conn = null
        }
        return conn
    }

    const sendNotify = (summary: string, body: string, actionLabel: string, onFailed?: () => void): boolean => {
        if (sending) return false
        const c = bus()
        if (!c) return false
        sending = true
        const args = new GLib.Variant("(susssasa{sv}i)", [
            "Veltrix", 0, APP_ICON, summary, body, [REENABLE_ACTION, actionLabel], {}, -1,
        ])
        c.call(NOTIF_IFACE, NOTIF_PATH, NOTIF_IFACE, "Notify", args, null,
            Gio.DBusCallFlags.NO_AUTO_START, 5000, null,
            (c2: any, res: any) => {
                sending = false
                try {
                    const unpacked = (c2 as Gio.DBusConnection).call_finish(res).deepUnpack() as unknown[]
                    lastNotifId = unpacked[0] as number
                    // Sent — mark the day now, so dismissing it does not
                    // make it reappear today.
                    store.markNudgedToday()
                } catch (e) {
                    // The daemon is down or refused: nothing was shown, so
                    // nothing is marked — the hourly re-check tries again.
                    console.error("[ContentSafety] nudge Notify failed:", e)
                    // M5 (fix pass #3): the bus existed when the send was
                    // queued, so notify() already returned true and no
                    // retry was scheduled — the next chance would have been
                    // the hourly tick, up to an hour later. Hand the
                    // failure back to the caller that asked for it, so the
                    // reconcile's bounded retry covers this leg too.
                    onFailed?.()
                }
            })
        return true
    }

    const ensureSubscription = () => {
        if (subscribed || subscribing) return
        const c = bus()
        if (!c) return
        // `subscribing` (an attempt in flight) is tracked apart from
        // `subscribed` (live): the old code set the flag before the async
        // callback, so a call that never returned would make every later
        // retry no-op forever. The flag now flips only in the callback,
        // which always lands — the GetNameOwner call carries a 5s timeout.
        subscribing = true
        // Learn the daemon's unique name so the ActionInvoked handler only
        // ever answers the daemon. Subscribing with sender null (the old
        // code) meant ANY process on the session bus could pop a pkexec
        // prompt by emitting ActionInvoked with action "reenable" — still
        // gated by the admin password, but a prompt on demand is not a
        // thing to hand out. If the name cannot be resolved, the
        // subscription falls back to sender null and the id check below
        // is the guard that remains.
        c.call("org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "GetNameOwner",
            new GLib.Variant("(s)", [NOTIF_IFACE]), null,
            Gio.DBusCallFlags.NONE, 5000, null,
            (_c2: any, res: any) => {
                let sender: string | null = null
                try {
                    sender = (c.call_finish(res).deepUnpack() as unknown[])[0] as string
                    daemonOwner = sender
                } catch (e) {
                    console.error("[ContentSafety] GetNameOwner for the notification daemon failed; ActionInvoked sender is unchecked:", e)
                }
                subId = c.signal_subscribe(sender, NOTIF_IFACE, "ActionInvoked", NOTIF_PATH, null,
                    Gio.DBusSignalFlags.NONE,
                    (_c3: any, from: string, _path: string, _iface: string, _signal: string, params: any) => {
                        try {
                            const [id, action] = params.deepUnpack()
                            if (action !== REENABLE_ACTION) return
                            // Only our own notification may re-enable: the
                            // id Notify returned, from the daemon that owns
                            // it. A foreign ActionInvoked with any other id
                            // is ignored. And with lastNotifId 0 no
                            // notification of ours is outstanding at all —
                            // there is nothing to tap — so every
                            // ActionInvoked is ignored instead of skipping
                            // the id check (S2: the old `lastNotifId !== 0
                            // &&` guard left the fallback state spoofable).
                            if (lastNotifId === 0) return
                            if (id !== lastNotifId) return
                            if (daemonOwner !== null && from !== daemonOwner) return
                            void store.setContentFilter(true).catch((e) => {
                                if (!(e instanceof ApplyCancelled)) console.error("[ContentSafety] re-enable:", e)
                            })
                        } catch (e) {
                            console.error("[ContentSafety] ActionInvoked:", e)
                        }
                    })
                void subId
                subscribing = false
                subscribed = true
                if (pending) {
                    const p = pending
                    pending = null
                    // S3 (fix pass #3): a send held while the subscription
                    // resolved may be stale by the time it flushes — the
                    // user may already have fixed protection via Settings.
                    // Re-check before showing anything, so a stale
                    // notification never appears (and never marks the day).
                    void Promise.resolve(p.stillValid ? p.stillValid() : true).then((ok) => {
                        if (ok) sendNotify(p.summary, p.body, p.actionLabel, p.onFailed)
                    })
                }
            })
    }

    const notify = (summary: string, body: string, actionLabel: string, opts?: {
        onFailed?: () => void
        stillValid?: () => boolean | Promise<boolean>
    }): boolean => {
        if (subscribed) return sendNotify(summary, body, actionLabel, opts?.onFailed)
        // N1: never send before the ActionInvoked subscription exists.
        // ensureSubscription resolves the daemon owner asynchronously, and
        // the old code notified immediately after calling it — a tap in
        // that window was lost, while the day was already marked at send,
        // so there was no retry today. Hold this one send until the
        // subscription lands; the callback flushes it. One slot is enough:
        // the nudge and the reconcile are each once a day.
        // S2 (fix pass #3): the slot is the FIRST send's — a second
        // notify() while one is queued is dropped, not silently swapped
        // in. The nudge and the reconcile are mutually exclusive by the
        // bit, so a second send here needs a mid-session bit flip inside
        // the subscription window; the first send is the one already
        // promised to its caller, and it keeps the slot.
        if (pending) return bus() !== null
        pending = { summary, body, actionLabel, onFailed: opts?.onFailed, stillValid: opts?.stillValid }
        ensureSubscription()
        // No bus at all: ensureSubscription did nothing, the pending send
        // will never flush, and the caller must retry — say so.
        return bus() !== null
    }

    notifier = { ensureSubscription, notify }
    return notifier
}
