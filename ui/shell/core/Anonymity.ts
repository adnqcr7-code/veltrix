// Anonymity — the system side of Settings → Safety → Anonymity.
//
// Tor mode is enforced in the firewall, not in per-app proxy settings:
// `bin/veltrix-anonymity` routes ALL traffic through Tor (TransPort 9040,
// DNSPort 5353) behind an nftables default-deny kill-switch, so a
// compromised app cannot bypass it by ignoring a proxy setting. This
// module is only the Settings-facing half: it runs the helper (privileged
// for on/off/install-tor, unprivileged for status/leak-check) and turns
// its JSON into typed values the page can render.
//
// The three privileged verbs deliberately do NOT share one authorisation
// level (see config/polkit/org.veltrix.anonymity.policy): turning Tor mode
// ON is always safe (allow_active=yes — at worst it blocks traffic until
// Tor starts), turning it OFF needs the admin password (auth_admin —
// malware that could silently turn it off could silently de-anonymise
// the user), and installing the tor package is a package install
// (auth_admin). A dismissed prompt is ApplyCancelled (exit 126, the same
// convention as ContentSafety and the Region language row): nothing
// failed, nothing changed.
import Gio from "gi://Gio"
import { execAsync, spawn } from "../../lib/process"
import { ApplyCancelled } from "./ContentSafety"

export { ApplyCancelled }

/** What `veltrix-anonymity status` reports (unprivileged JSON). */
export interface AnonymityStatus {
    mode: "off" | "tor"
    tor_installed: boolean
    tor_active: boolean
    socks_reachable: boolean
    rules_applied: boolean
    resolv_points_at_tor: boolean
    mac_randomized: boolean
    vpn_active: string | null
    kill_switch: "armed" | "off"
    warnings: string[]
}

/** What `veltrix-anonymity leak-check` reports (unprivileged JSON). */
export interface LeakCheckResult {
    checked: boolean
    tor: boolean
    exit_ip: string | null
    dns_via_tor: boolean
    error: string | null
}

/**
 * Run the privileged helper for one verb. Throws ApplyCancelled if the
 * user dismisses the polkit prompt, or an Error carrying the helper's
 * stderr on a real failure. Writes nothing to any store — the caller
 * re-reads status only on success.
 */
async function runPrivileged(verb: "on" | "off" | "install-tor"): Promise<void> {
    const proc = spawn(["pkexec", "veltrix-anonymity", verb],
        Gio.SubprocessFlags.STDERR_PIPE)
    const [ok, _out, err] = await new Promise<[boolean, string, string]>((resolve) => {
        proc.communicate_utf8_async(null, null, (_: any, res: any) => {
            try {
                const [_ok, out, errText] = proc.communicate_utf8_finish(res)
                resolve([proc.get_successful(), out ?? "", errText ?? ""])
            } catch (e) {
                console.error("[Anonymity] veltrix-anonymity:", e)
                resolve([false, "", String(e)])
            }
        })
    })
    // 126 = the password prompt was dismissed: nothing failed, nothing changed.
    const cancelled = !ok && proc.get_if_exited() && proc.get_exit_status() === 126
    if (cancelled) throw new ApplyCancelled()
    if (!ok) {
        throw new Error((err ?? "").trim() || `veltrix-anonymity ${verb} failed`)
    }
}

/** Turn Tor mode on (no password for the active session) or off (admin
 *  password — see the module header for why the two differ). */
export async function applyTorMode(on: boolean): Promise<void> {
    await runPrivileged(on ? "on" : "off")
}

/** Install the tor package (admin password — a package install must never
 *  happen silently). */
export async function installTor(): Promise<void> {
    await runPrivileged("install-tor")
}

/** Read the helper's status (unprivileged, no pkexec). Null when the helper
 *  cannot be run at all — the Settings page then says so instead of guessing. */
export async function getAnonymityStatus(): Promise<AnonymityStatus | null> {
    try {
        const out = await execAsync(["veltrix-anonymity", "status"], { timeoutMs: 5000 })
        return JSON.parse(out) as AnonymityStatus
    } catch (e) {
        console.error("[Anonymity] status:", e)
        return null
    }
}

/** Run the leak check (unprivileged, no pkexec): exit IP + DNS, both
 *  THROUGH Tor. Null when the helper cannot be run at all. When Tor mode
 *  is off the helper still answers, with checked=false — the page says
 *  "Tor mode is off", it does not pretend to have checked. */
export async function runLeakCheck(): Promise<LeakCheckResult | null> {
    try {
        const out = await execAsync(["veltrix-anonymity", "leak-check"], { timeoutMs: 30000 })
        return JSON.parse(out) as LeakCheckResult
    } catch (e) {
        console.error("[Anonymity] leak-check:", e)
        return null
    }
}
