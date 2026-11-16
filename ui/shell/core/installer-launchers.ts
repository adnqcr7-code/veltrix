// SPDX-License-Identifier: GPL-3.0-or-later
// Which launchers the installer itself owns — pure, no imports, so a
// probe can exercise it without the app registry.
//
// The installer writes two kinds of launcher with NO pacman package
// behind them, so `pacman -Qo` on their .desktop file answers "no
// package owns it" and Settings → Apps used to call them unremovable
// (Nov 14 sweep #13):
//
//   • web apps (WhatsApp): install.sh's apps_webapp writes
//     /usr/share/applications/veltrix-<id>.desktop — the file IS the
//     install, so removing it IS the uninstall.
//   • Vile: apps_vile writes /usr/share/applications/vile.desktop and
//     installs the binary to /usr/local/bin/vile. Removing the launcher
//     takes the app out of every menu; the binary stays (the dialog's
//     "Any files the app itself installed stay where they are" still
//     holds — Vile can be re-picked in the installer later).
//
// The match is deliberately narrow: the file must live in the system
// applications dir AND be one of those two names. Anything else without
// a pacman owner stays "unsupported" — a hand-placed .desktop file in
// /usr/share/applications is the admin's, not ours to delete.

const SYSTEM_APPS_DIR = "/usr/share/applications/"

/** True when this .desktop file is a launcher the installer wrote. */
export function isInstallerOwnedLauncher(desktopFile: string): boolean {
    if (!desktopFile.startsWith(SYSTEM_APPS_DIR)) return false
    const base = desktopFile.slice(SYSTEM_APPS_DIR.length)
    if (base === "vile.desktop") return true
    if (/^veltrix-[a-z0-9-]+\.desktop$/.test(base)) return true
    return false
}
