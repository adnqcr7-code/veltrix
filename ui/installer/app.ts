// Veltrix Installer — the entry point of the fourth bundle.
//
// This surface exists only on the live medium: it is packaged as
// `veltrix-installer`, which nothing but nidara-iso's package list ever names, so
// an installed desktop never carries code that partitions disks. See
// `nidara-iso/INSTALLER.md` for the decision and the shape.
//
// What it is NOT allowed to do is worth stating at the top of the file it would
// be added to: it never partitions, never formats, never pacstraps and never
// writes a bootloader. It collects answers, produces an archinstall config, and
// runs one process as root. Everything that can destroy data lives on the other
// side of that seam, in Arch's own code.

import app from "../lib/veltrix-kit/platform/host"
import GLib from "gi://GLib"
import { initAppearance } from "../lib/veltrix-kit/platform/appearance-css"
import { applyCrispFontRendering } from "../lib/veltrix-kit/platform/font-rendering"
import { InstallerWindow } from "./widget/InstallerWindow"
import { getLocale } from "./lib/i18n"
import { applyLocaleDirection } from "../lib/rtl"
import { useNoGtkTheme } from "../lib/veltrix-kit/platform/gtk-theme"

// No GTK theme at all — this sheet is the only CSS there is (commandment 11).
//
// ⚠️ This bundle is the reason the theme must come out of GTK's gresource rather
// than off the disk. It ships as `veltrix-installer` and runs on a live medium that
// need not carry `veltrix`, which is what installed the blank theme we used
// to name here — so on an ISO built without the desktop package the installer ran
// the full default GTK theme while this line claimed it was running on nothing.
useNoGtkTheme()

const cssPath = [
  "./style.css",
  "./ui/installer/style.css",
  "/usr/share/veltrix/ui/installer/style.css",
].find(p => GLib.file_test(p, GLib.FileTest.EXISTS)) ?? "/usr/share/veltrix/ui/installer/style.css"

app.start({
  applicationId: "org.veltrix.installer",
  applicationName: "Veltrix Installer",
  processName: "veltrix-install",
  logDomain: "veltrix-installer",
  css: cssPath,

  main() {
    // First: the process-wide text direction, from the locale the installer
    // resolved at module load. A live language switch (welcome step →
    // setLocale) re-applies it there. See ui/lib/rtl.ts.
    applyLocaleDirection(getLocale())
    // Before any window exists: glyph baselines on the pixel grid. There is no
    // ThemeManager in this process to do it later.
    applyCrispFontRendering()

    // The installer runs INSIDE a running Veltrix and has no opinions of its own:
    // whatever accent, mode and window opacity the user picked while trying the
    // desktop is what this window wears, and it follows them changing it with the
    // installer open. One call — the full token ramp, the kit's Cairo seam and the
    // glass rim — read from the Settings portal, exactly as a third-party app reads
    // it. See the contract in ui/lib/veltrix-kit/platform/appearance.ts.
    initAppearance()

    InstallerWindow().present()
  },
})
