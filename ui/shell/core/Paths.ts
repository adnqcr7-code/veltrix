import GLib from "gi://GLib"

/**
 * Root of the shell's bundled resources (assets/, style.css, icons).
 *
 * The launcher starts the shell process inside ui/shell (so scripts/run.sh
 * bundles and finds style.css) and exports VELTRIX_SHELL_ROOT pointing there.
 * We capture it here and then immediately move the process CWD to $HOME (below) —
 * otherwise every app launched from the dock/AppGrid inherits ui/shell as its
 * working directory instead of $HOME (kitty opening in the source tree, etc.).
 *
 * So: assets resolve against SHELL_ROOT (fixed), never the live CWD. The env var
 * is the source of truth; get_current_dir() covers a bare scripts/run.sh.
 */
export const SHELL_ROOT = GLib.getenv("VELTRIX_SHELL_ROOT") || GLib.get_current_dir()

/**
 * Where the shell writes the greeter's MIRRORS (appearance, clock format) — the
 * world-readable copies for the one surface outside any session. Overridable ONLY
 * so a probe that constructs ThemeManager or RegionConfig does not overwrite the
 * real login screen's copy with its test values (scripts/dev/define-config-probe.sh
 * sets it). The greeter always reads /var/tmp/veltrix.
 */
export const GREETER_MIRROR_DIR = GLib.getenv("VELTRIX_GREETER_MIRROR_DIR") || "/var/tmp/veltrix"

// Move the process CWD to $HOME so child processes (terminals, apps) open there.
// Importing this module before anything spawns a child (see app.ts) makes this the
// effective default for the whole shell, replacing the per-launch `cd "$HOME"`.
GLib.chdir(GLib.get_home_dir())

/**
 * The shell's own version string. A release install (bootstrap.sh from a
 * GitHub release, or veltrix-update's GITHUB path) records its full release
 * version, e.g. 1.2, in ~/.config/veltrix/.release. Since 1.2 the release
 * version IS the plain version in VERSION (the old 0.13.0-vN releases
 * shared one VERSION, 0.13.0, so the marker was what told them apart);
 * the marker is kept anyway — it is the tag the install came from, and
 * the update check compares it, so a machine still on 0.13.0-v7 is
 * correctly offered 1.2. It is written only by a release install and
 * cleared by any branch-based install (install.sh --dev / --update), so
 * when it exists it IS the installed release. Dev checkouts (no marker)
 * fall through to the tree's VERSION; the system copy is the last resort.
 */
export function readShellVersion(): string {
    const releaseMarker = `${GLib.get_home_dir()}/.config/veltrix/.release`
    try {
        const [relOk, relBytes] = GLib.file_get_contents(releaseMarker)
        if (relOk) {
            const v = new TextDecoder().decode(relBytes).trim()
            if (v) return v
        }
    } catch {}

    const devMarker = `${GLib.get_home_dir()}/.config/veltrix/.dev`
    try {
        const [devOk, devBytes] = GLib.file_get_contents(devMarker)
        if (devOk) {
            const repoDir = new TextDecoder().decode(devBytes).trim()
            const [ok, bytes] = GLib.file_get_contents(`${repoDir}/VERSION`)
            if (ok) return new TextDecoder().decode(bytes).trim()
        }
    } catch {}

    try {
        const [ok, bytes] = GLib.file_get_contents("/usr/share/veltrix/VERSION")
        if (ok) return new TextDecoder().decode(bytes).trim()
    } catch {}

    return "unknown"
}

