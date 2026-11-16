// Update check — the shell-owned "a new Veltrix release is out" notification.
//
// Why the SHELL owns it (same reason as ContentSafety's nudge): Settings is a
// separate application that exits on close, so a check owned by it would only
// run while its window was open. Started once from app.ts, after the
// notification client (the dismissal watch below reads its mirror).
//
// The check itself reuses the About page's endpoint and comparison —
// https://api.github.com/repos/adnqcr7-code/veltrix/releases/latest vs
// readShellVersion() — and no other: one endpoint, one comparison, in the
// whole desktop. `isNewerVersion` here is a twin of About.tsx's; keep the
// two in step (both are ten lines, and a shared import would drag core/
// into surfaces/ or the other way round).
//
// No-nag contract (all local, no account, no telemetry):
//   - on boot (30 s in, so the network has a chance to come up — the About
//     page documents losing that race at login), then at most once a day
//     afterwards (an hourly tick that only fires when lastCheckDate is not
//     today). A failed check — offline, GitHub rate-limited (curl -f fails
//     on the 403), malformed JSON — stays SILENT: no popup, no error, and
//     lastCheckDate is left alone so the next hourly tick retries.
//   - up to date: quiet. No notification, and a stale one from before the
//     update is closed.
//   - a newer release posts ONE persistent notification (see the notifier):
//     CRITICAL urgency + expire_timeout 0, so the banner never auto-expires
//     and cuts through Do Not Disturb (NotificationPopups treats both as
//     "never auto-expire"), and the `resident` hint, so tapping "Update now"
//     does NOT resolve it — if the update is cancelled in the terminal, the
//     card is still in the Notification Center, and the next boot re-posts
//     it (same daemon id, via replaces_id) while the update is pending.
//   - dismissing it suppresses ONLY that version: dismissedVersion is
//     keyed by version, so release Y is still announced after X was
//     dismissed. The dismissal is read off the daemon's Resolved signal
//     (reason DISMISSED) through notifd — not NotifService, which drops
//     the reason — so a daemon restart (UNDEFINED) never counts as a
//     dismissal and the notification is re-posted instead of lost.
//
// The background updater (1.0): when a newer release is found, the shell
// starts `veltrix-update-download download` in the background — the tarball
// (or the delta, when one exists for the installed version) downloads
// quietly while the user keeps playing, with progress in
// ~/.local/share/veltrix-update/status.json. The notification then walks
// through its states on ONE card (re-posted with replaces_id): downloading
// → ready ("Update now" / "On next login") → installing. "Update now"
// runs the privileged helper through pkexec (`/usr/bin/veltrix-update-
// helper apply`): the helper re-verifies the staged tarball against the
// pinned GitHub API itself and installs it, restarting ONLY the shell
// service — never the machine. There is no password anywhere in this flow:
// no sudo password is saved, in any file, keyring or environment variable,
// not even briefly, so there is no prompt to show and nothing for a
// compromised updater to steal (the helper's header comment carries the
// threat model). "On next login" writes a flag file the shell consumes at
// the next boot, so the update applies then instead of mid-game.
//
// The terminal is still the fallback, and the only path for the cases the
// background apply must refuse: a release that changes the system packages
// (the deps list differs from the installed pins — the interactive
// `pacman -Syu` in install.sh §1), a missing apps choice, and DEV /
// PACKAGE installs (which update from their registered clone / pacman,
// through `veltrix-update`). Those post a card whose action opens a
// VISIBLE terminal running `veltrix-update` and keeps it open afterwards,
// so the user sees the result — and the sudo prompt, on the pacman path.
// See bin/veltrix-update.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync, spawn } from "../../lib/process"
import { t } from "./i18n"
import { readShellVersion, SHELL_ROOT } from "./Paths"
import { defineSettings } from "./configFile"
import { getDefault, ClosedReason } from "./notifd"

const RELEASES_URL = "https://api.github.com/repos/adnqcr7-code/veltrix/releases/latest"
const UPDATE_ACTION = "update-now"
const NEXT_LOGIN_ACTION = "update-next-login"
const CANCEL_ACTION = "update-cancel"
const RETRY_ACTION = "update-retry"
const TERMINAL_ACTION = "update-terminal"
const BOOT_DELAY_S = 30
const RETRY_INTERVAL_S = 3600
// The background updater's staging dir (shared with bin/veltrix-update-
// download and bin/veltrix-update-helper — the same paths, the same
// status.json schema; see the downloader's header).
const UPDATE_DIR = `${GLib.get_home_dir()}/.local/share/veltrix-update`
const UPDATE_STATUS = `${UPDATE_DIR}/status.json`
const APPLY_ON_LOGIN_FLAG = `${UPDATE_DIR}/apply-on-login`
const DOWNLOADER = "veltrix-update-download"
const HELPER = "/usr/bin/veltrix-update-helper"
// How often the shell polls status.json while a download or an apply is
// in flight (short-lived: the timer stops itself on a terminal state).
const POLL_INTERVAL_S = 5

/** Local YYYY-MM-DD (same shape as ContentSafety.todayStr; kept local so
 *  this module does not depend on the safety module for one date). */
const todayStr = (): string => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** True when `latest` is a strictly newer version than `current`.
 *  Two tag schemes, both understood (the scheme changed at 1.2):
 *  old releases carry a packaging suffix, e.g. 0.13.0-v4 — the dotted
 *  part is the upstream version, the -vN part is the release number;
 *  releases from 1.2 on are plain, e.g. 1.2, 1.3. A plain dotted split
 *  turns "0-v4" into 0, so v4 and v5 compare EQUAL and the update
 *  notification never fires — the suffix is split off first, and a
 *  missing suffix counts as release 0. The dotted compare is what
 *  makes 1.2 newer than 0.13.0-v7 (1 > 0 in the first component), so a
 *  machine on v7 is correctly offered the 1.2 update.
 *  Twin of About.tsx's; keep the two in step. */
function isNewerVersion(latest: string, current: string): boolean {
    if (!latest || latest === "unknown" || !current || current === "unknown") return false
    const split = (v: string): { parts: number[]; rel: number } => {
        const clean = v.trim().replace(/^v/, "")
        const m = clean.match(/^(.*?)-v(\d+)$/)
        const base = m ? m[1] : clean
        return { parts: base.split(".").map(n => parseInt(n, 10) || 0), rel: m ? parseInt(m[2], 10) : 0 }
    }
    const a = split(latest)
    const b = split(current)
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
        if ((a.parts[i] || 0) !== (b.parts[i] || 0)) return (a.parts[i] || 0) > (b.parts[i] || 0)
    }
    return a.rel > b.rel
}

// ── State (GSettings org.veltrix.notifications) ──────────────────────────────
//
// A second store on the same schema as NotifConfig — each store only
// declares its own keys, so neither validates the other's. These four are
// internal bookkeeping, not user settings: they are deliberately NOT in
// ConfigRegistry / the Settings manifest.

interface UpdateCheckSettings {
    lastUpdateCheckDate: string // YYYY-MM-DD the check last answered; "" = never
    dismissedUpdateVersion: string // release version whose notification was dismissed; "" = none
    notifiedUpdateVersion: string // release version the live notification announces; "" = none
    notifiedUpdateId: number // daemon id of that notification; 0 = none
}

const DEFAULTS: UpdateCheckSettings = {
    lastUpdateCheckDate: "",
    dismissedUpdateVersion: "",
    notifiedUpdateVersion: "",
    notifiedUpdateId: 0,
}

const config = defineSettings("notifications", DEFAULTS)

const updateStore = {
    get lastUpdateCheckDate() { return config.get("lastUpdateCheckDate") },
    get dismissedUpdateVersion() { return config.get("dismissedUpdateVersion") },
    get notifiedUpdateVersion() { return config.get("notifiedUpdateVersion") },
    get notifiedUpdateId() { return config.get("notifiedUpdateId") },
    markCheckedToday() { config.set("lastUpdateCheckDate", todayStr()) },
    markDismissed(version: string) { config.set("dismissedUpdateVersion", version) },
    markNotified(version: string, id: number) {
        config.update({ notifiedUpdateVersion: version, notifiedUpdateId: id })
    },
    clearNotified() {
        config.update({ notifiedUpdateVersion: "", notifiedUpdateId: 0 })
    },
}

// ── The notifier ────────────────────────────────────────────────────────────
//
// The shell's own D-Bus connection to org.freedesktop.Notifications — the
// ContentSafety pattern, not `notify-send`: a notify-send process exits at
// once, and the daemon answers an action tap with "notification sender
// unknown or disconnected" when the sender is already gone. The shell is
// alive for the whole session, so the tap reaches it. One notifier per
// process; the subscription is established BEFORE the first Notify, so a
// tap in the first seconds is never lost (N1 in ContentSafety.ts).

const NOTIF_IFACE = "org.freedesktop.Notifications"
const NOTIF_PATH = "/org/freedesktop/Notifications"

/** The Veltrix mark, as the notification's app icon — an absolute path, so
 *  the banner and the Center draw the V mark even though no desktop file
 *  names this sender. Same icon as ContentSafety's nudge. */
const APP_ICON = `${SHELL_ROOT}/assets/veltrix/assets/veltrix-symbolic.svg`

/** One notification card: the background updater re-posts the SAME card
 *  (replaces_id) as the update walks downloading → ready → installing,
 *  so the user sees one card whose actions change with the state. */
interface UpdateCard {
    summary: string
    body: string
    /** [action id, label] pairs, in the order the daemon shows them. */
    actions: [string, string][]
}

interface UpdateNotifier {
    ensureSubscription(): void
    /** True when the notification was sent (or queued for the subscription
     *  still resolving); false when there is no bus to send on. */
    notify(card: UpdateCard, opts?: {
        onSent?: (id: number) => void
        onFailed?: () => void
        stillValid?: () => boolean | Promise<boolean>
    }): boolean
}

let notifier: UpdateNotifier | null = null

/** Every action id the updater's cards can carry. An ActionInvoked with
 *  any other id is not ours — the handler ignores it. */
const KNOWN_ACTIONS = new Set([UPDATE_ACTION, NEXT_LOGIN_ACTION, CANCEL_ACTION, RETRY_ACTION, TERMINAL_ACTION])

function updateNotifier(onAction: (action: string) => void): UpdateNotifier {
    if (notifier) return notifier
    let sending = false
    let subscribed = false
    let subscribing = false
    let subId = 0
    let conn: Gio.DBusConnection | null = null
    // The id Notify returned for the most recent notification we sent
    // (0 = none), and the daemon's unique bus name once resolved. Seeded
    // from GSettings, not 0: after a shell RELOAD the daemon still holds
    // the card we posted before it, and its action tap must still reach
    // us in the window before the next check re-posts and re-learns the id.
    let lastNotifId = updateStore.notifiedUpdateId
    let daemonOwner: string | null = null
    // One send held while the subscription is still resolving.
    let pending: {
        card: UpdateCard
        onSent?: (id: number) => void
        onFailed?: () => void
        stillValid?: () => boolean | Promise<boolean>
    } | null = null

    const bus = (): Gio.DBusConnection | null => {
        if (conn) return conn
        try {
            conn = Gio.bus_get_sync(Gio.BusType.SESSION, null)
        } catch (e) {
            console.error("[UpdateCheck] no session bus for the notification:", e)
            conn = null
        }
        return conn
    }

    const sendNotify = (
        card: UpdateCard,
        onSent?: (id: number) => void, onFailed?: () => void,
    ): boolean => {
        if (sending) return false
        const c = bus()
        if (!c) return false
        sending = true
        // replaces_id = the previous notification's id (0 the first time):
        // the daemon REUSES that id, so a re-post replaces the same card
        // instead of stacking a duplicate. expire_timeout 0 = never expire;
        // urgency byte 2 = CRITICAL (cuts through DnD, never auto-expires
        // in the banner layer); resident = the card survives its own action.
        const replacesId = updateStore.notifiedUpdateId
        const flatActions: string[] = []
        for (const [id, label] of card.actions) flatActions.push(id, label)
        const args = new GLib.Variant("(susssasa{sv}i)", [
            "Veltrix", replacesId, APP_ICON, card.summary, card.body,
            flatActions,
            {
                urgency: new GLib.Variant("y", 2),
                resident: new GLib.Variant("b", true),
            },
            0,
        ])
        c.call(NOTIF_IFACE, NOTIF_PATH, NOTIF_IFACE, "Notify", args, null,
            Gio.DBusCallFlags.NO_AUTO_START, 5000, null,
            (c2: any, res: any) => {
                sending = false
                try {
                    const unpacked = (c2 as Gio.DBusConnection).call_finish(res).deepUnpack() as unknown[]
                    lastNotifId = unpacked[0] as number
                    onSent?.(lastNotifId)
                } catch (e) {
                    console.error("[UpdateCheck] Notify failed:", e)
                    onFailed?.()
                }
            })
        return true
    }

    const ensureSubscription = () => {
        if (subscribed || subscribing) return
        const c = bus()
        if (!c) return
        subscribing = true
        // Learn the daemon's unique name so the ActionInvoked handler only
        // ever answers the daemon (same guard as ContentSafety's notifier:
        // with sender null, ANY process could pop a terminal running
        // veltrix-update by emitting ActionInvoked with our action id).
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
                    console.error("[UpdateCheck] GetNameOwner for the notification daemon failed; ActionInvoked sender is unchecked:", e)
                }
                subId = c.signal_subscribe(sender, NOTIF_IFACE, "ActionInvoked", NOTIF_PATH, null,
                    Gio.DBusSignalFlags.NONE,
                    (_c3: any, from: string, _path: string, _iface: string, _signal: string, params: any) => {
                        try {
                            const [id, action] = params.deepUnpack()
                            if (!KNOWN_ACTIONS.has(action)) return
                            // Only our own notification may act: the id
                            // Notify returned, from the daemon that owns it.
                            if (lastNotifId === 0) return
                            if (id !== lastNotifId) return
                            if (daemonOwner !== null && from !== daemonOwner) return
                            onAction(action)
                        } catch (e) {
                            console.error("[UpdateCheck] ActionInvoked:", e)
                        }
                    })
                void subId
                subscribing = false
                subscribed = true
                if (pending) {
                    const p = pending
                    pending = null
                    void Promise.resolve(p.stillValid ? p.stillValid() : true).then((ok) => {
                        if (ok) sendNotify(p.card, p.onSent, p.onFailed)
                    })
                }
            })
    }

    const notify = (card: UpdateCard, opts?: {
        onSent?: (id: number) => void
        onFailed?: () => void
        stillValid?: () => boolean | Promise<boolean>
    }): boolean => {
        if (subscribed) return sendNotify(card, opts?.onSent, opts?.onFailed)
        // Never send before the ActionInvoked subscription exists: a tap
        // in that window would be lost. Hold this one send until the
        // subscription lands; the callback flushes it.
        if (pending) return bus() !== null
        pending = { card, onSent: opts?.onSent, onFailed: opts?.onFailed, stillValid: opts?.stillValid }
        ensureSubscription()
        // No bus at all: ensureSubscription did nothing, the pending send
        // will never flush, and the caller must retry — say so.
        return bus() !== null
    }

    notifier = { ensureSubscription, notify }
    return notifier
}

// ── "Update now": a visible terminal running veltrix-update ──────────────────
//
// First terminal found on PATH (same table as Settings → Users'
// spawnTerminalWithCommand). The command keeps the window open after the
// update finishes, so the user sees the result — and the sudo prompt, on
// the pacman path — instead of a window that flashes and vanishes. The
// background apply never takes this path: it runs through pkexec + the
// polkit policy, where there is no password to prompt for at all. This
// terminal exists for the cases the background apply must refuse (a
// package-list change, DEV / PACKAGE installs), where the privileged step
// happens where the user can see and refuse it.
// Launched through spawn() (ui/lib/process), which strips GTK_THEME=Empty
// (commandment 11) — never Gio.Subprocess.new or GLib.spawn_* directly.

function openUpdateTerminal(): void {
    const prompt = t("update.available.terminal.prompt")
    const cmd = `veltrix-update; echo; read -n 1 -s -r -p ${GLib.shell_quote(prompt)}`
    const map: Record<string, string[]> = {
        kitty: ["kitty", "--", "bash", "-c", cmd],
        alacritty: ["alacritty", "-e", "bash", "-c", cmd],
        wezterm: ["wezterm", "start", "--", "bash", "-c", cmd],
        "gnome-terminal": ["gnome-terminal", "--", "bash", "-c", cmd],
        xterm: ["xterm", "-e", "bash", "-c", cmd],
    }
    for (const term of Object.keys(map)) {
        if (GLib.find_program_in_path(term)) {
            try {
                spawn(map[term])
            } catch (e) {
                console.error("[UpdateCheck] could not open terminal:", e)
            }
            return
        }
    }
    console.error("[UpdateCheck] No terminal found to run veltrix-update")
}

// ── The background updater ──────────────────────────────────────────────────
//
// The states, in order: a newer release is found → the downloader starts
// (spawn, fire-and-forget — the shell holds the handle only so "Cancel"
// can kill it) and the DOWNLOADING card posts once, with no progress in
// its body (re-posting a CRITICAL card every few seconds would re-pop the
// banner while the user plays; the live percent lives on the About page).
// The poll then watches status.json every 5 s and re-posts the SAME card
// only when the STATE changes: ready → installing → (the shell restarts).
// A failure posts its own card and stops the poll. There is ever one live
// card, so the version it is about lives in module state (activeLatest /
// activeCurrent) for the action dispatcher to read.

type UpdateStatus = {
    state: string
    current?: string
    latest?: string
    kind?: string
    filename?: string
    downloaded?: number
    size?: number
    percent?: number
    reason?: string
}

async function readUpdateStatus(): Promise<UpdateStatus | null> {
    try {
        const out = await execAsync([DOWNLOADER, "status"])
        const st = JSON.parse(out) as UpdateStatus
        if (st && typeof st.state === "string") return st
    } catch {
        // The downloader is missing, or status.json is unreadable: the
        // caller treats a null as "no background state" and falls back.
    }
    return null
}

let activeLatest = ""
let activeCurrent = ""
let downloadProc: Gio.Subprocess | null = null
let pollSourceId = 0
let pollFailures = 0
let lastPostedState = ""

function postCard(card: UpdateCard, latest: string, current: string): void {
    activeLatest = latest
    activeCurrent = current
    const n = updateNotifier(handleCardAction)
    n.ensureSubscription()
    n.notify(card, {
        onSent: (id) => updateStore.markNotified(latest, id),
        stillValid: () => {
            if (latest === updateStore.dismissedUpdateVersion) return false
            return isNewerVersion(latest, readShellVersion())
        },
    })
}

const downloadingCard = (latest: string): UpdateCard => ({
    summary: t("update.downloading.title").replace("%s", latest),
    body: t("update.downloading.body"),
    actions: [[CANCEL_ACTION, t("update.downloading.action.cancel")]],
})

const readyCard = (latest: string): UpdateCard => ({
    summary: t("update.ready.title").replace("%s", latest),
    body: t("update.ready.body"),
    actions: [
        [UPDATE_ACTION, t("update.available.action")],
        [NEXT_LOGIN_ACTION, t("update.ready.action.next-login")],
    ],
})

const installingCard = (latest: string): UpdateCard => ({
    summary: t("update.installing.title").replace("%s", latest),
    body: t("settings.about.update.applying"),
    actions: [],
})

const failedCard = (latest: string): UpdateCard => ({
    summary: t("update.available.title").replace("%s", latest),
    body: t("update.failed-download.body").replace("%s", latest),
    actions: [[RETRY_ACTION, t("update.failed-download.action")]],
})

const needsInteractiveCard = (latest: string): UpdateCard => ({
    summary: t("update.available.title").replace("%s", latest),
    body: t("settings.about.update.needs-interactive"),
    actions: [[TERMINAL_ACTION, t("settings.about.update.update-in-terminal")]],
})

const availableCard = (latest: string, current: string): UpdateCard => ({
    summary: t("update.available.title").replace("%s", latest),
    body: t("update.available.body").replace("%s", latest).replace("%s", current),
    actions: [[TERMINAL_ACTION, t("update.available.action")]],
})

function dismissLiveCard(): void {
    // Clear the bookkeeping BEFORE dismissing, so the onResolved handler
    // below does not read our own Dismiss as the user dismissing the
    // version (the up-to-date path does the same).
    const id = updateStore.notifiedUpdateId
    updateStore.clearNotified()
    if (id > 0) getDefault().getNotification(id)?.dismiss()
}

function stopPoll(): void {
    if (pollSourceId !== 0) {
        GLib.source_remove(pollSourceId)
        pollSourceId = 0
    }
    pollFailures = 0
    downloadProc = null
}

/** The 5 s watch on status.json while a download or an apply is in
 *  flight. Re-posts the card only when the STATE changes, and stops
 *  itself on a terminal state (failed / needs-interactive / applied /
 *  idle). A status that cannot be read 12 times running (60 s) is a
 *  broken downloader, not a slow one — stop polling silently. */
function startPoll(latest: string, current: string): void {
    stopPoll()
    lastPostedState = ""
    pollSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_S, () => {
        void (async () => {
            const st = await readUpdateStatus()
            if (!st) {
                if (++pollFailures >= 12) {
                    console.error("[UpdateCheck] status.json unreadable 12 times — stopping the update poll")
                    stopPoll()
                }
                return
            }
            pollFailures = 0
            if (st.latest && st.latest !== latest) {
                // A newer release appeared mid-flight: stop here; the
                // hourly check announces the new one.
                stopPoll()
                return
            }
            switch (st.state) {
                case "downloading":
                case "verifying":
                case "checking":
                    if (lastPostedState !== "downloading") {
                        lastPostedState = "downloading"
                        postCard(downloadingCard(latest), latest, current)
                    }
                    break
                case "ready":
                    if (lastPostedState !== "ready") {
                        lastPostedState = "ready"
                        postCard(readyCard(latest), latest, current)
                    }
                    break
                case "applying":
                    if (lastPostedState !== "applying") {
                        lastPostedState = "applying"
                        postCard(installingCard(latest), latest, current)
                    }
                    break
                case "failed":
                    lastPostedState = "failed"
                    postCard(failedCard(latest), latest, current)
                    stopPoll()
                    break
                case "needs-interactive":
                    lastPostedState = "needs-interactive"
                    postCard(needsInteractiveCard(latest), latest, current)
                    stopPoll()
                    break
                case "applied":
                case "idle":
                    // Applied: the helper already restarted the shell, so
                    // this poll is running on borrowed time — stop quietly.
                    // Idle: the download went away (cancelled elsewhere);
                    // the hourly check re-announces if it is still due.
                    stopPoll()
                    break
                default:
                    break
            }
        })()
        // Always CONTINUE: stopping is done by stopPoll() (source_remove),
        // whether from inside the async work above or from an action tap.
        // Returning REMOVE here would only matter if the source had
        // already been removed between ticks.
        return GLib.SOURCE_CONTINUE
    })
}

function startBackgroundDownload(latest: string, current: string): void {
    try {
        downloadProc = spawn([DOWNLOADER, "download"])
    } catch (e) {
        // The downloader is missing (a broken install): fall back to the
        // terminal card instead of leaving the user with nothing.
        console.error("[UpdateCheck] could not start the downloader:", e)
        postCard(availableCard(latest, current), latest, current)
        return
    }
    postCard(downloadingCard(latest), latest, current)
    startPoll(latest, current)
}

function applyUpdate(latest: string): void {
    try {
        // pkexec + the polkit policy (allow_active=yes): no password
        // prompt for the active local session, and no credential
        // anywhere to steal. The helper re-verifies the staged
        // release itself before it touches the system.
        spawn(["pkexec", HELPER, "apply"])
    } catch (e) {
        console.error("[UpdateCheck] could not start the update helper:", e)
        postCard(availableCard(latest, activeCurrent), latest, activeCurrent)
        return
    }
    postCard(installingCard(latest), latest, activeCurrent)
    startPoll(latest, activeCurrent)
}

/** The one dispatcher for every action id on the updater's cards. */
function handleCardAction(action: string): void {
    const latest = activeLatest
    const current = activeCurrent
    if (!latest) return
    switch (action) {
        case UPDATE_ACTION:
            // "Update now" — the ready card's apply action.
            applyUpdate(latest)
            break
        case NEXT_LOGIN_ACTION: {
            // "On next login" — write the flag, then dismiss the card.
            // The flag is written FIRST: if it fails, the card stays, so
            // the user can pick again. The version is deliberately NOT
            // marked dismissed: if the login apply fails, the hourly
            // check must re-announce it instead of staying quiet.
            if (!GLib.file_set_contents(APPLY_ON_LOGIN_FLAG, latest)) {
                console.error("[UpdateCheck] could not write the apply-on-login flag")
                postCard(readyCard(latest), latest, current)
                return
            }
            stopPoll()
            dismissLiveCard()
            break
        }
        case CANCEL_ACTION:
            // "Cancel" — kill the downloader, drop the staged file, and
            // suppress ONLY this version (the user chose not to have it).
            try {
                downloadProc?.force_exit()
            } catch {
                // Already finished: the cancel below still cleans up.
            }
            void execAsync([DOWNLOADER, "cancel"]).catch(() => {})
            stopPoll()
            dismissLiveCard()
            updateStore.markDismissed(latest)
            break
        case RETRY_ACTION:
            // "Try again" — the download failed; start it over.
            startBackgroundDownload(latest, current)
            break
        case TERMINAL_ACTION:
            // "Open terminal" / the fallback card's "Update now": the
            // terminal flow, where the user sees the sudo prompt.
            openUpdateTerminal()
            break
        default:
            break
    }
}

/** At boot: a flag file from "On next login" means the update applies
 *  now, before the first check. The helper consumes the flag at apply
 *  start, so a restarted shell cannot re-apply in a loop. A stale flag
 *  (the download was cancelled, or a newer release appeared) is dropped
 *  and the normal check runs instead. */
async function checkApplyOnLogin(): Promise<void> {
    let flag = ""
    try {
        const [ok, bytes] = GLib.file_get_contents(APPLY_ON_LOGIN_FLAG)
        if (ok) flag = new TextDecoder().decode(bytes).trim()
    } catch {
        return
    }
    if (!flag) return
    const st = await readUpdateStatus()
    if (!st || st.state !== "ready" || st.latest !== flag) {
        try {
            Gio.File.new_for_path(APPLY_ON_LOGIN_FLAG).delete(null)
        } catch {
            // Already gone: nothing to clean.
        }
        return
    }
    if (!isNewerVersion(flag, readShellVersion())) {
        try {
            Gio.File.new_for_path(APPLY_ON_LOGIN_FLAG).delete(null)
        } catch {
            // Already gone: nothing to clean.
        }
        return
    }
    applyUpdate(flag)
}

// ── The check ───────────────────────────────────────────────────────────────

let started = false

/** One check: fetch the latest release, compare, notify or stay quiet.
 *  Silent on every failure (offline, rate-limited, malformed JSON):
 *  nothing is marked, so the hourly tick retries. */
async function checkOnce(): Promise<void> {
    let out: string
    try {
        // Same argv as the About page: -f so a 403 (GitHub rate limit)
        // rejects instead of handing us an error page to misparse.
        out = await execAsync(["curl", "-fsS", "--max-time", "5", RELEASES_URL])
    } catch {
        return
    }
    let latest = ""
    try {
        latest = String(JSON.parse(out)?.tag_name ?? "").replace(/^v/, "")
    } catch {
        return
    }
    if (!latest) return
    updateStore.markCheckedToday()
    const current = readShellVersion()
    if (!isNewerVersion(latest, current)) {
        // Up to date — and a notification from before the update is stale:
        // close it. Only clear the bookkeeping once the card is actually
        // in hand to dismiss: if the mirror does not hold it (daemon down,
        // not yet hydrated) the close is retried by the next check instead
        // of leaving a stale card behind with no record of it. Clearing
        // first also keeps the dismissal watch below from marking the
        // just-installed version as dismissed (it fires on our own Dismiss).
        const staleId = updateStore.notifiedUpdateId
        if (staleId > 0) {
            const stale = getDefault().getNotification(staleId)
            if (stale) {
                updateStore.clearNotified()
                stale.dismiss()
            }
        }
        return
    }
    // Dismissed this version: stay quiet until a NEWER release appears.
    if (latest === updateStore.dismissedUpdateVersion) return
    // A download or apply already in flight (or already staged) for this
    // version: do not start a second one — join it, posting the card for
    // the state it is actually in.
    const st = await readUpdateStatus()
    if (st && st.latest === latest) {
        switch (st.state) {
            case "ready":
                postCard(readyCard(latest), latest, current)
                return
            case "downloading":
            case "verifying":
            case "checking":
                postCard(downloadingCard(latest), latest, current)
                startPoll(latest, current)
                return
            case "applying":
                postCard(installingCard(latest), latest, current)
                startPoll(latest, current)
                return
            case "failed":
                postCard(failedCard(latest), latest, current)
                return
            case "needs-interactive":
                postCard(needsInteractiveCard(latest), latest, current)
                return
            default:
                // "idle" / "applied": fall through to a fresh download.
                break
        }
    }
    startBackgroundDownload(latest, current)
}

/** Idempotent: a second call does nothing. */
export function startUpdateCheck(): void {
    if (started) return
    started = true

    // "On next login" from the last session: apply it now, before the
    // first check runs.
    void checkApplyOnLogin()

    // A dismissal of OUR notification suppresses only its version. The
    // reason matters: EXPIRED/UNDEFINED (daemon restart, retention —
    // critical is retention-exempt, so in practice a restart) is NOT a
    // dismissal, and the next check re-posts with the same id instead of
    // losing the announcement. Our own close-when-up-to-date clears the
    // bookkeeping before dismissing, so this handler never sees it.
    getDefault().onResolved((id, reason) => {
        const liveId = updateStore.notifiedUpdateId
        if (id === 0 || liveId === 0 || id !== liveId) return
        if (reason !== ClosedReason.DISMISSED) return
        const version = updateStore.notifiedUpdateVersion
        updateStore.clearNotified()
        if (version) updateStore.markDismissed(version)
    })

    // On boot (30 s in, so the network has a chance to be up), then at
    // most once a day: the hourly tick only fires when today has not
    // been checked yet. A failed check leaves lastCheckDate alone, so
    // the tick retries it hourly, silently.
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, BOOT_DELAY_S, () => {
        void checkOnce()
        return GLib.SOURCE_REMOVE
    })
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_INTERVAL_S, () => {
        if (updateStore.lastUpdateCheckDate !== todayStr()) void checkOnce()
        return GLib.SOURCE_CONTINUE
    })
}
