import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { execAsync, spawn } from "../../../../lib/process"
import { VeltrixButton } from "../../../../lib/veltrix-kit"
import { listGroup, createRow, pageBox, staticLabel, onPageShown } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import { readShellVersion } from "../../../core/Paths"
import compositor from "../../../core/CompositorState"
import * as sys from "../../../core/SystemInfo"

/**
 * Settings → About is the DETAIL half of the pair (owner's call, 2026-08-25,
 * closing debt #94). The About window is the glanceable card — the machine, the
 * OS, the desktop's version, and a button that lands here; this page is a strict
 * SUPERSET of it plus the one thing a settings page can hold and a card cannot:
 * something to act on (the update check).
 *
 * Nothing here reads a file or an environment variable itself. Every fact comes
 * from `core/SystemInfo`, which is what stopped the two surfaces from disagreeing
 * about the same machine (RAM was 31 GB in one window and 31.3 GB in the other).
 */

/**
 * True when `latest` is a strictly newer version than `current`.
 * Two tag schemes, both understood (the scheme changed at 1.2):
 * old releases carry a packaging suffix, e.g. 0.13.0-v4 — the dotted
 * part is the upstream version, the -vN part is the release number;
 * releases from 1.2 on are plain, e.g. 1.2, 1.3. A plain dotted split
 * turns "0-v4" into 0, so v4 and v5 compare EQUAL and the update row
 * never appears — the suffix is split off first, and a missing suffix
 * counts as release 0. The dotted compare is what makes 1.2 newer
 * than 0.13.0-v7 (1 > 0 in the first component), so a machine on v7
 * is correctly offered the 1.2 update.
 * Twin of UpdateCheck.ts's; keep the two in step.
 */
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

/** Every value on this page goes through the same "" → placeholder contract. */
const shown = (v: string) => staticLabel(v || t("settings.about.unavailable"))

/** A row whose value arrives later; `SystemInfo` never rejects, so there is no catch. */
function asyncRow(label: string, subtitle: string, src: Promise<string>) {
    const lbl = staticLabel("…")
    src.then(v => { lbl.label = v || t("settings.about.unavailable") })
    return createRow(label, subtitle, lbl)
}

export default function AboutPage() {
    const page = pageBox("about-page")

    // ── Veltrix ──────────────────────────────────────────────────────────
    // The desktop, and what you can DO about it. It used to also carry a "Shell"
    // row whose value read "Hyprland WM" while its own subtitle described ours —
    // one of the three places this page named the compositor. The compositor has
    // exactly one row now, in Environment, where the other component versions are.
    const { box: shellBox, listBox: shellList } = listGroup(t("settings.about.group.veltrix"))

    // The row's subtitle names a COMPONENT, so it is the component's full name:
    // this number is the desktop environment's, not the operating system's (the
    // System group below carries that one). nidara-iso/PRODUCT.md draws the line.
    // Kept in a variable: the update check re-reads it after an update ran
    // while Settings stayed open, so the version on screen follows the install.
    const versionLabel = staticLabel(readShellVersion())
    shellList.append(createRow(t("settings.about.version"), "VELTRIX", versionLabel))

    // Update — the one visible update button (owner's call, 2026-11-13).
    // This row is ALWAYS present. The old design appended a row only when
    // the check resolved, so on a failed check (Settings opened right after
    // login, network not up yet) there was no row at all — and even when it
    // resolved it was a static label, nothing to tap. The notification is
    // still there as a second path, but the button here is the one the user
    // can always find: Settings → About → Software update.
    //
    // The button is the whole flow: it checks GitHub for the latest release
    // on its own, and when one is available it becomes "Download update" —
    // one tap starts `veltrix-update-download download` in the background
    // (the tarball, or the delta when one exists for the installed
    // version), and the row follows it through downloading → ready → the
    // "Update now" button, which runs the privileged helper through pkexec
    // (`/usr/bin/veltrix-update-helper apply`). No terminal, no password
    // prompt, no yes/no: the helper re-verifies the staged release itself
    // and restarts only the shell service. The state lives in
    // ~/.local/share/veltrix-update/status.json (the downloader's and the
    // helper's shared file), polled here while a download or an apply is
    // in flight. The terminal is kept as the fallback, for the one case
    // the background apply must refuse: an update that changes the system
    // packages (the "needs-interactive" state), where the user reviews the
    // upgrade in a terminal running `veltrix-update`.
    //
    // State lives in the row itself (the footer status label + the button),
    // not in the list: the page is built once and cached, so the row is
    // created at build time and only its text and button change. The footer
    // slot carries the status because the row's subtitle is a fixed string;
    // the button stays in the trailing slot, aligned with the Version row.
    type UpdateState = "checking" | "uptodate" | "available" | "downloading" | "ready" | "applying" | "failed" | "needs-interactive" | "updating"
    let updateState: UpdateState = "checking"
    let answered = false
    let checking = false
    // True when the last failure was a DOWNLOAD failure (not a check
    // failure): the button then retries the download directly instead of
    // re-running the check. applyFailed is the same, for an APPLY failure
    // (the button re-applies instead of re-downloading).
    let downloadFailed = false
    let applyFailed = false
    // The 2 s status poll, while a download or an apply is in flight.
    let polling = false

    const statusLabel = new Gtk.Label({
        label: t("settings.about.update.checking"),
        css_classes: ["dimmed"],
        halign: Gtk.Align.START,
        xalign: 0,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
    })
    const updateBtn = VeltrixButton({
        label: t("settings.about.update.checking"),
        variant: "secondary", pill: true,
        valign: Gtk.Align.CENTER, sensitive: false,
    })

    const setUpdateState = (state: UpdateState, status: string) => {
        updateState = state
        statusLabel.label = status
        const primary = state === "available" || state === "ready" || state === "updating"
        updateBtn.remove_css_class("veltrix-btn--primary")
        updateBtn.remove_css_class("veltrix-btn--secondary")
        updateBtn.add_css_class(primary ? "veltrix-btn--primary" : "veltrix-btn--secondary")
        switch (state) {
            case "checking":
                updateBtn.label = t("settings.about.update.checking")
                updateBtn.sensitive = false
                break
            case "uptodate":
                updateBtn.label = t("settings.about.update.check")
                updateBtn.sensitive = true
                break
            case "available":
                updateBtn.label = t("settings.about.update.download")
                updateBtn.sensitive = true
                break
            case "downloading":
                updateBtn.label = t("settings.about.update.downloading-btn")
                updateBtn.sensitive = false
                break
            case "ready":
                updateBtn.label = t("settings.about.update.update-now")
                updateBtn.sensitive = true
                break
            case "applying":
                updateBtn.label = t("settings.about.update.applying")
                updateBtn.sensitive = false
                break
            case "failed":
                updateBtn.label = t("update.failed-download.action")
                updateBtn.sensitive = true
                break
            case "needs-interactive":
                updateBtn.label = t("settings.about.update.update-in-terminal")
                updateBtn.sensitive = true
                break
            case "updating":
                updateBtn.label = t("settings.about.update.updating")
                updateBtn.sensitive = false
                break
        }
    }

    const runUpdateCheck = () => {
        if (checking) return
        checking = true
        downloadFailed = false
        applyFailed = false
        setUpdateState("checking", t("settings.about.update.checking"))
        execAsync(["curl", "-fsS", "--max-time", "5",
            "https://api.github.com/repos/adnqcr7-code/veltrix/releases/latest",
        ]).then(async out => {
            checking = false
            let latest = ""
            try {
                latest = String(JSON.parse(out)?.tag_name ?? "").replace(/^v/, "")
            } catch { /* malformed JSON: a failed check, handled below */ }
            if (!latest) {
                setUpdateState("failed", t("settings.about.update.failed"))
                return
            }
            answered = true
            // The installed version may have moved since this page was built
            // (an update ran while Settings stayed open): re-read it, so the
            // Version row and the comparison follow the install, not the boot.
            const current = readShellVersion()
            versionLabel.label = current
            if (isNewerVersion(latest, current)) {
                // A download or apply may already be in flight (started
                // from the notification) — join it instead of offering a
                // fresh download.
                const st = await readDownloadStatus()
                if (st && st.latest === latest) {
                    if (st.state === "ready") {
                        setUpdateState("ready", t("settings.about.update.ready"))
                        return
                    }
                    if (st.state === "downloading" || st.state === "verifying" || st.state === "checking") {
                        setUpdateState("downloading",
                            t("settings.about.update.downloading").replace("%s", String(st.percent ?? 0)))
                        startStatusPoll()
                        return
                    }
                    if (st.state === "applying") {
                        setUpdateState("applying", t("settings.about.update.applying"))
                        startStatusPoll()
                        return
                    }
                    if (st.state === "needs-interactive") {
                        setUpdateState("needs-interactive", t("settings.about.update.needs-interactive"))
                        return
                    }
                    // failed / idle: fall through to "available" (a fresh download).
                }
                setUpdateState("available",
                    t("settings.about.update.available.desc").replace("%s", latest).replace("%s", current))
            } else {
                setUpdateState("uptodate", t("settings.about.update.up-to-date"))
            }
        }).catch(() => {
            checking = false
            // Offline, rate-limited, or the network not up yet: say so on the
            // row instead of leaving no row at all, and retry on the next visit.
            setUpdateState("failed", t("settings.about.update.failed"))
        })
    }

    // ── The background updater, from this page ─────────────────────────────
    // The downloader and the helper share one status file,
    // ~/.local/share/veltrix-update/status.json (see
    // bin/veltrix-update-download's header for the schema). This page reads
    // it through the downloader CLI — never by opening the file itself, so
    // the CLI stays the single source of truth — and polls it every 2 s
    // while a download or an apply is in flight. The timer stops itself
    // on the next tick once the state leaves downloading/applying.
    type DownloadStatus = {
        state: string
        latest?: string
        percent?: number
        reason?: string
    }

    const readDownloadStatus = async (): Promise<DownloadStatus | null> => {
        try {
            const out = await execAsync(["veltrix-update-download", "status"])
            const st = JSON.parse(out) as DownloadStatus
            if (st && typeof st.state === "string") return st
        } catch {
            // The downloader is missing, or status.json is unreadable:
            // the caller treats a null as "no background state".
        }
        return null
    }

    const pollUpdateStatus = async (): Promise<void> => {
        const st = await readDownloadStatus()
        if (!st) return // transient: the next tick retries
        const current = readShellVersion()
        versionLabel.label = current
        switch (st.state) {
            case "downloading":
            case "verifying":
            case "checking":
                setUpdateState("downloading",
                    t("settings.about.update.downloading").replace("%s", String(st.percent ?? 0)))
                break
            case "ready":
                if (st.latest && isNewerVersion(st.latest, current)) {
                    setUpdateState("ready", t("settings.about.update.ready"))
                } else {
                    runUpdateCheck()
                }
                break
            case "applying":
                setUpdateState("applying", t("settings.about.update.applying"))
                break
            case "failed":
                // Which phase failed decides the retry: a download failure
                // re-downloads, an apply failure re-applies.
                if (updateState === "applying") {
                    applyFailed = true
                } else {
                    downloadFailed = true
                }
                setUpdateState("failed", t("settings.about.update.download-failed"))
                break
            case "needs-interactive":
                setUpdateState("needs-interactive", t("settings.about.update.needs-interactive"))
                break
            case "applied":
            case "idle":
                // Applied: the version moved (or the shell restarted) — a
                // re-check shows up-to-date. Idle: the download went away
                // (cancelled from the notification) — a re-check shows the
                // available state again.
                runUpdateCheck()
                break
            default:
                break
        }
    }

    const startStatusPoll = () => {
        if (polling) return
        polling = true
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            if (updateState !== "downloading" && updateState !== "applying") {
                polling = false
                return GLib.SOURCE_REMOVE
            }
            void pollUpdateStatus()
            return GLib.SOURCE_CONTINUE
        })
    }

    const startDownload = () => {
        downloadFailed = false
        applyFailed = false
        setUpdateState("downloading", t("settings.about.update.downloading").replace("%s", "0"))
        try {
            // Fire-and-forget: the poll above watches status.json for the
            // result. spawn() (ui/lib/process) strips GTK_THEME=Empty.
            spawn(["veltrix-update-download", "download"])
        } catch (e) {
            console.error("[About] could not start the downloader:", e)
            downloadFailed = true
            setUpdateState("failed", t("settings.about.update.download-failed"))
            return
        }
        startStatusPoll()
    }

    const applyDownloaded = () => {
        downloadFailed = false
        applyFailed = false
        setUpdateState("applying", t("settings.about.update.applying"))
        try {
            // pkexec + allow_active=yes: no prompt for the active session.
            // The helper re-verifies the staged release itself; the poll
            // watches status.json for the result.
            spawn(["pkexec", "/usr/bin/veltrix-update-helper", "apply"])
        } catch (e) {
            console.error("[About] could not start the update helper:", e)
            applyFailed = true
            setUpdateState("failed", t("settings.about.update.download-failed"))
            return
        }
        startStatusPoll()
    }

    // Open a visible terminal running `veltrix-update` — the fallback for
    // the one case the background apply must refuse (an update that changes
    // the system packages), and the same terminal table as Settings →
    // Users' spawnTerminalWithCommand. The window stays open afterwards so
    // the user sees the result (and the sudo prompt); the background flow
    // never uses this path. Kept a local copy, not an import of
    // UpdateCheck: that module owns the notification daemon (core/notifd.ts),
    // which the Settings closure forbids.
    const openUpdateTerminal = () => {
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
                execAsync(map[term]).catch(e => console.error("[About] could not open terminal:", e))
                return
            }
        }
        console.error("[About] No terminal found to run veltrix-update")
    }

    updateBtn.connect("clicked", () => {
        if (updateState === "available") {
            startDownload()
            return
        }
        if (updateState === "ready") {
            applyDownloaded()
            return
        }
        if (updateState === "needs-interactive") {
            // The one case the background apply must refuse: a terminal,
            // where the user reviews the upgrade. The row stays
            // "Updating…" until the version moves (see onPageShown).
            setUpdateState("updating", t("settings.about.update.updating"))
            openUpdateTerminal()
            return
        }
        if (updateState === "failed") {
            // "Try again" retries the phase that failed: a download
            // failure re-downloads, an apply failure re-applies, and a
            // check failure re-checks.
            if (applyFailed) {
                applyDownloaded()
                return
            }
            if (downloadFailed) {
                startDownload()
                return
            }
            runUpdateCheck()
            return
        }
        // "Check for updates": re-check now, even though the automatic
        // check already answered.
        runUpdateCheck()
    })

    shellList.append(createRow(t("settings.about.update"),
        t("settings.about.update.desc"), updateBtn, undefined, undefined, statusLabel))

    // Retried on every visit UNTIL it answers, then never again — except
    // while an update is running in the terminal, where the version file is
    // re-read to notice the moment it lands (a second "Update now" while
    // one is already running would open a second terminal over the same
    // install, so the row stays "Updating…" until the version moves).
    // The old one-shot flag was the right call for one attempt and the wrong
    // one for a session: Settings is often opened right after login, the curl
    // loses to a network that isn't up yet, and this page — built once,
    // cached for the life of the shell — would have kept silent about an
    // available update for the rest of the day.
    //
    // While a download or an apply is in flight, a visit refreshes the row
    // from status.json (the state may have moved since the last visit) and
    // makes sure the poll is running. While the row is "ready", a visit
    // also refreshes once: the download may have been cancelled from the
    // notification, in which case the row goes back to the check.
    onPageShown(() => {
        if (updateState === "updating") {
            if (readShellVersion() !== versionLabel.label) runUpdateCheck()
            return
        }
        if (updateState === "downloading" || updateState === "applying") {
            void pollUpdateStatus()
            startStatusPoll()
            return
        }
        if (updateState === "ready") {
            void pollUpdateStatus()
            return
        }
        if (!answered) runUpdateCheck()
    })

    page.append(shellBox)

    // ── System ─────────────────────────────────────────────────────────────────
    // The machine and the system on it — the About window's block, in the same
    // order, plus the two it does not show (kernel, uptime). The OS row's subtitle
    // used to be os-release's raw `ID` ("endeavouros"), a machine value printed at
    // a person; the value is the OS's own PRETTY_NAME and the subtitle now says
    // what the value IS.
    const { box: sysBox, listBox: sysList } = listGroup(t("settings.about.group.system"))

    sysList.append(createRow(t("settings.about.device"), t("settings.about.device.desc"), shown(sys.deviceName())))
    sysList.append(createRow(t("settings.about.os"), t("settings.about.os.desc"), shown(sys.osName())))
    sysList.append(createRow(t("settings.about.cpu"), t("settings.about.cpu.desc"), shown(sys.cpuModel())))
    sysList.append(createRow(t("settings.about.ram"), t("settings.about.ram.desc"), shown(sys.totalRam())))
    sysList.append(asyncRow(t("settings.about.graphics"), t("settings.about.graphics.desc"), sys.graphics()))
    sysList.append(asyncRow(t("settings.about.kernel"), t("settings.about.kernel.desc"), sys.kernel()))

    // Uptime — the one value on this page that is wrong the moment after it is
    // read. Everything else here is fixed for the session (kernel, CPU, RAM, OS);
    // this one is a clock, so it gets re-read whenever the page is shown.
    const uptimeLabel = staticLabel("…")
    sysList.append(createRow(t("settings.about.uptime"), t("settings.about.uptime.desc"), uptimeLabel))
    onPageShown(() => {
        uptimeLabel.label = sys.uptime() || t("settings.about.unavailable")
    })

    page.append(sysBox)

    // ── Environment ────────────────────────────────────────────────────────────
    // What the desktop runs ON: the compositor, the toolkit, the runtime. These are
    // the rows the About window dropped when it became the summary — diagnostics,
    // not identity — so this is where they live.
    //
    // Two rows that were here are gone, and for the same reason: a row whose value
    // is fixed is filler wearing a fact's clothes. `XDG_CURRENT_DESKTOP` printed
    // "Hyprland" a third time; the windowing system could only ever read "Wayland",
    // because Hyprland is a Wayland compositor and the shell needs
    // gtk4-layer-shell to draw at all (owner's call, 2026-08-25 — GNOME's
    // "Windowing System" row earns its place precisely because GNOME also runs on
    // X11, and we do not).
    const { box: envBox, listBox: envList } = listGroup(t("settings.about.group.environment"))

    // The row names the compositor this session runs on; "Hyalo" is a proper name, not
    // text to translate (the description, "Compositor version", is).
    const compositorName = compositor.kind === "hyalo" ? "Hyalo" : t("settings.about.hyprland")
    envList.append(asyncRow(compositorName, t("settings.about.hyprland.desc"),
        compositor.version().then(v => v || "").catch(() => "")))
    envList.append(createRow("GTK", t("settings.about.gtk.desc"), staticLabel(sys.gtkVersion())))
    envList.append(createRow("GJS", t("settings.about.gjs.desc"), staticLabel(sys.gjsVersion())))

    page.append(envBox)

    return page
}
