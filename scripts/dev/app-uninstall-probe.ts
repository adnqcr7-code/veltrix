// app-uninstall-probe — installer-written launchers are uninstallable
// (Nov 14 sweep #13).
//
//   scripts/bundle.sh scripts/dev/app-uninstall-probe.ts /tmp/app-uninstall-probe
//   /tmp/app-uninstall-probe                     # under gjs, like the other probes
//
// Or under plain node (the module under test has no imports):
//   npx esbuild --bundle scripts/dev/app-uninstall-probe.ts --format=esm \
//     --platform=node --outfile=/tmp/app-uninstall-probe.mjs && node /tmp/app-uninstall-probe.mjs
//
// The installer writes two launcher shapes with NO pacman package behind
// them, so `pacman -Qo` answers "no package owns it" and Settings → Apps
// used to call them unremovable: its web apps (veltrix-<id>.desktop) and
// Vile (vile.desktop). The match must stay narrow — a hand-placed file
// in /usr/share/applications is the admin's, not ours to delete.

import { isInstallerOwnedLauncher } from "../../ui/shell/core/installer-launchers"

// `print` is the GJS global; under node it does not exist.
const print = (globalThis as any).print ?? ((...a: unknown[]) => console.log(...a))

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
    print(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`)
    if (!cond) failures++
}

check("WhatsApp web app is installer-owned",
    isInstallerOwnedLauncher("/usr/share/applications/veltrix-whatsapp.desktop"))
check("Vile is installer-owned",
    isInstallerOwnedLauncher("/usr/share/applications/vile.desktop"))
check("another installer web app matches the pattern",
    isInstallerOwnedLauncher("/usr/share/applications/veltrix-telegram.desktop"))
check("a packaged app is not installer-owned",
    !isInstallerOwnedLauncher("/usr/share/applications/org.gnome.Nautilus.desktop"))
check("a hand-placed launcher in /usr/share/applications is not ours",
    !isInstallerOwnedLauncher("/usr/share/applications/my-own-app.desktop"))
check("a user launcher is not installer-owned",
    !isInstallerOwnedLauncher("/home/adnan/.local/share/applications/veltrix-whatsapp.desktop"))
check("a veltrix- name outside the system dir is not installer-owned",
    !isInstallerOwnedLauncher("/usr/local/share/applications/veltrix-whatsapp.desktop"))
check("a name that only looks like the pattern is rejected",
    !isInstallerOwnedLauncher("/usr/share/applications/veltrix-whatsapp.desktop.bak"))
check("an empty path is rejected", !isInstallerOwnedLauncher(""))
check("a directory traversal in the name is rejected",
    !isInstallerOwnedLauncher("/usr/share/applications/../veltrix-whatsapp.desktop"))

print(failures === 0 ? "TEST: ALL PASSED" : `TEST: ${failures} FAILURE(S)`)
