// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "../../lib/process"
import appService, { type AppData } from "./AppService"
import { isInstallerOwnedLauncher } from "./installer-launchers"

// ── App uninstall — the engine behind Settings → Apps → Installed apps ──────
// How an app is removed depends on where it came from, and the page asks this
// module first (describeUninstall) so the dialog can say what will actually go:
//
//   • a distribution package  → `pacman -Rns` (via pkexec — the same privilege
//     pattern as Users.tsx's `pkexec chpasswd` and region.ts's `pkexec
//     veltrix-language`). pacman itself is the second safety net: it refuses a
//     removal that would break another installed package.
//   • a Flatpak              → `flatpak uninstall` (user installs need no root;
//     system installs go through pkexec). App data is NOT deleted — the app
//     goes, its saved data stays, and the dialog says so.
//   • a launcher somebody put in ~/.local/share/applications by hand (or with a
//     per-user installer) → the .desktop file is deleted. That only removes the
//     launcher; the dialog says so, because the app's own files live elsewhere.
//   • a launcher the INSTALLER wrote with no pacman package behind it (its
//     web apps, veltrix-<id>.desktop, and Vile's vile.desktop — see
//     installer-launchers.ts) → the .desktop file is deleted with pkexec,
//     because it is root-owned. Same "launcher only" honesty as above:
//     Vile's binary stays in /usr/local/bin.
//   • a Snap, or anything with no owner and no launcher file → unsupported, with
//     a reason the page can show instead of a button that fails.
//
// The module never touches the UI: it returns plans and results, and the page
// turns them into rows and dialogs.

/**
 * Packages the desktop cannot boot or run without. pacman would refuse most of
 * these anyway (veltrix depends on them), but the list is the UPFRONT answer
 * — without it the user types a password first and only then learns the removal
 * was refused.
 */
const PROTECTED_PACKAGES = new Set([
    // The desktop itself and its platform library.
    "veltrix", "veltrix-kit",
    // The session and its plumbing.
    "hyprland", "greetd", "uwsm", "systemd", "linux", "linux-firmware",
    "pacman", "glibc", "polkit", "polkit-gnome", "dbus", "sudo", "bash",
    "filesystem", "mesa", "wayland", "xdg-desktop-portal",
    "xdg-desktop-portal-hyprland", "pipewire", "wireplumber",
    "networkmanager", "shadow", "pambase", "util-linux", "coreutils",
    "gjs", "gtk4", "gtk3", "glib2", "seatd", "hypridle", "hyprsunset",
    "power-profiles-daemon", "gnome-keyring",
])

export type UninstallKind =
    | "pacman"
    | "flatpak-user"
    | "flatpak-system"
    | "desktop-file"
    | "unsupported"

export interface UninstallPlan {
    kind: UninstallKind
    /** What will be removed: package name, Flatpak id, or launcher path. */
    target: string
    /** Why it cannot be removed (kind === "unsupported" only). One of:
     *  "protected" | "snap" | "no-owner" | "no-desktop-file" | "no-flatpak-id". */
    reason?: string
    /** The app's .desktop file, when it has one. */
    desktopFile?: string
    /** The launcher is root-owned (an installer-written one): remove it
     *  with pkexec, not as the user. Only set on kind "desktop-file". */
    privileged?: boolean
}

function desktopFileOf(app: AppData): string {
    try {
        return appService.getAppInfo(app.id)?.get_filename?.() ?? ""
    } catch {
        return ""
    }
}

/** Work out how this app can be removed — no privilege, no changes, just a plan. */
export async function describeUninstall(app: AppData): Promise<UninstallPlan> {
    const desktopFile = desktopFileOf(app)
    const origin = appService.getAppOrigin(app.id)

    if (origin === "flatpak") {
        const id = appService.getFlatpakId(app.id)
        if (!id) return { kind: "unsupported", target: app.id, reason: "no-flatpak-id", desktopFile }
        // A user Flatpak's export lives under the user's own data dir; a system
        // one's under /var/lib/flatpak. The first needs no privilege, the second
        // does — the kind carries that, so the run step picks the right command.
        const kind = desktopFile.startsWith(GLib.get_user_data_dir()) ? "flatpak-user" : "flatpak-system"
        return { kind, target: id, desktopFile }
    }
    if (origin === "snap") {
        return { kind: "unsupported", target: app.id, reason: "snap", desktopFile }
    }
    if (origin === "user") {
        if (!desktopFile) return { kind: "unsupported", target: app.id, reason: "no-desktop-file" }
        return { kind: "desktop-file", target: desktopFile, desktopFile }
    }

    // System (or unknown) origin: the owning pacman package, if any.
    if (!desktopFile) return { kind: "unsupported", target: app.id, reason: "no-desktop-file" }
    let owner: string | null = null
    try {
        // `pacman -Qo /path` prints "/path is owned by <pkg> <version>".
        const out = await execAsync(["pacman", "-Qo", desktopFile], { timeoutMs: 15_000 })
        owner = out.match(/ is owned by (\S+)/)?.[1] ?? null
    } catch {
        owner = null // "No package owns ..." — not an error to surface here.
    }
    if (!owner) {
        // No pacman package owns the launcher — but the installer may
        // have written it itself (its web apps, Vile): then the launcher
        // IS the install, and removing it is the uninstall (Nov 14
        // sweep #13). Anything else unowned stays unsupported.
        if (isInstallerOwnedLauncher(desktopFile)) {
            return { kind: "desktop-file", target: desktopFile, privileged: true, desktopFile }
        }
        return { kind: "unsupported", target: app.id, reason: "no-owner", desktopFile }
    }
    if (PROTECTED_PACKAGES.has(owner)) {
        return { kind: "unsupported", target: owner, reason: "protected", desktopFile }
    }
    return { kind: "pacman", target: owner, desktopFile }
}

/**
 * Carry a plan out. The caller already confirmed with the user.
 *
 * On success the app registry is reloaded so the list reflects the removal at
 * once (the directory watcher would get there on its own, a beat later).
 * On failure the message is the tool's own stderr, trimmed — the page shows it
 * rather than inventing a reason.
 */
export async function uninstallApp(plan: UninstallPlan): Promise<{ ok: boolean; message: string }> {
    try {
        switch (plan.kind) {
            case "pacman":
                // -Rns: remove the package and the dependencies it pulled in
                // that nothing else needs; --noconfirm because there is no
                // terminal here to answer in — the pkexec prompt is the one
                // confirmation, and the page's dialog is the other.
                await execAsync(["pkexec", "pacman", "-Rns", "--noconfirm", plan.target], { timeoutMs: 300_000 })
                break
            case "flatpak-user":
                await execAsync(["flatpak", "uninstall", "-y", plan.target], { timeoutMs: 300_000 })
                break
            case "flatpak-system":
                await execAsync(["pkexec", "flatpak", "uninstall", "-y", plan.target], { timeoutMs: 300_000 })
                break
            case "desktop-file": {
                // A user-owned launcher goes with a plain delete; an
                // installer-written one is root-owned, so it goes with
                // pkexec. The privilege is re-checked here, not trusted
                // from the plan: a plan naming anything but an
                // installer-owned launcher never takes the pkexec path.
                if (plan.privileged && isInstallerOwnedLauncher(plan.target)) {
                    await execAsync(["pkexec", "rm", "-f", "--", plan.target], { timeoutMs: 60_000 })
                    break
                }
                const file = Gio.File.new_for_path(plan.target)
                try {
                    file.delete(null)
                } catch {
                    // Already gone counts as removed — the goal is "no launcher".
                    if (file.query_exists(null)) throw new Error(`could not remove ${plan.target}`)
                }
                break
            }
            default:
                return { ok: false, message: "unsupported" }
        }
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
    try {
        appService.reload()
    } catch {
        /* the directory watcher covers it */
    }
    return { ok: true, message: "" }
}
