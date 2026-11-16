// Anonymity — Settings → Safety → Anonymity (v1.0).
//
// One single-select group, three modes (the power profile group's shape:
// selection_mode = SINGLE, rows are VeltrixRow directly and are NOT
// indexed in search — they are VALUES, not settings — with the kit's
// VeltrixSelectionCheck, and updates follow onPageShown with a syncing
// flag so showing the page never writes anything).
//
//   Off — normal routing. Nothing to apply, nothing to protect.
//   VPN — the existing VPN support (Settings → Network: Proton VPN Free,
//     RiseupVPN, custom WireGuard/OpenVPN). Selecting it brings up the
//     first configured VPN profile; if none is configured the selection
//     is refused with an honest line instead of pretending. A VPN hides
//     traffic from the local network but the provider sees all of it —
//     Tor is the strong mode, VPN is the usable one.
//   Tor — the strong mode. `bin/veltrix-anonymity` routes ALL traffic
//     through Tor behind an nftables default-deny kill-switch (see
//     core/Anonymity.ts). Turning it ON needs no password (enabling
//     protection is always safe); turning it OFF needs the admin password
//     (so malware cannot silently de-anonymise the user). The two verbs
//     deliberately do not share one authorisation level.
//
// The mode is DERIVED from live state, never stored: Tor mode on → Tor;
// a VPN connection up → VPN; neither → Off. A VPN connected from the
// Network page shows as VPN mode here, and Tor mode switched on from a
// terminal shows as Tor — the page never disagrees with the system.
//
// The state line under the list is the same idea as the Content Safety
// toggle's footer: it re-reads `veltrix-anonymity status` on every visit
// and after every action, and says "Could not check" when the helper
// cannot run instead of guessing. "Check my anonymity" runs the
// leak-check (exit IP + DNS, both THROUGH Tor) and prints the honest
// result; "Install Tor" appears only while the tor package is missing.
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { VeltrixButton, VeltrixRow, VeltrixSelectionCheck } from "../../../../lib/veltrix-kit"
import { t } from "../../../core/i18n"
import { ApplyCancelled, applyTorMode, getAnonymityStatus, installTor, runLeakCheck, type AnonymityStatus } from "../../../core/Anonymity"
import * as Net from "../../../core/NetworkService"
import { bindWhileRealized, listGroup, onPageShown } from "../SettingsHelpers"
import { runSettingsAction } from "../SettingsErrors"
import type { PageCtx, ItemBuilder } from "../PreferencePage"

type Mode = "off" | "vpn" | "tor"

const MODES: { id: Mode; titleKey: string; descKey: string }[] = [
    { id: "off", titleKey: "settings.safety.anonymity.off", descKey: "settings.safety.anonymity.off.desc" },
    { id: "vpn", titleKey: "settings.safety.anonymity.vpn", descKey: "settings.safety.anonymity.vpn.desc" },
    { id: "tor", titleKey: "settings.safety.anonymity.tor", descKey: "settings.safety.anonymity.tor.desc" },
]

export const build = (_ctx: PageCtx) => {
    return {
        anonymityModes: (slot) => {
            const group = listGroup(slot.title)
            group.listBox.selection_mode = Gtk.SelectionMode.SINGLE

            const checkIcons = new Map<Mode, Gtk.Widget>()
            MODES.forEach((m) => {
                const check = VeltrixSelectionCheck(16)
                check.visible = false
                checkIcons.set(m.id, check)
                // VeltrixRow, not createRow: the search index is built when
                // the page is constructed and these three are VALUES, not
                // settings — indexing them would make "Tor" a search hit
                // that navigates to a page whose row it cannot select.
                const row = VeltrixRow(t(m.titleKey as any), t(m.descKey as any), check)
                row.set_name(m.id)
                group.listBox.append(row)
            })

            // Live state, under the list (same role as the Content Safety
            // toggle's footer). Re-read on every visit and after every
            // action; never a stored guess.
            const statusLabel = new Gtk.Label({
                label: "",
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                css_classes: ["dimmed"],
                halign: Gtk.Align.FILL,
                hexpand: true,
                xalign: 0,
                margin_top: 12,
                margin_start: 12,
                margin_end: 12,
            })
            const resultLabel = new Gtk.Label({
                label: "",
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                css_classes: ["dimmed"],
                halign: Gtk.Align.FILL,
                hexpand: true,
                xalign: 0,
                margin_top: 8,
                margin_start: 12,
                margin_end: 12,
            })
            const limitsLabel = new Gtk.Label({
                label: t("settings.safety.anonymity.limits"),
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                css_classes: ["dimmed"],
                halign: Gtk.Align.FILL,
                hexpand: true,
                xalign: 0,
                margin_top: 12,
                margin_start: 12,
                margin_end: 12,
                margin_bottom: 12,
            })

            const checkButton = VeltrixButton({
                label: t("settings.safety.anonymity.check"),
                variant: "ghost", size: "compact",
                halign: Gtk.Align.START, valign: Gtk.Align.CENTER,
            })
            const installButton = VeltrixButton({
                label: t("settings.safety.anonymity.install-tor"),
                variant: "ghost", size: "compact",
                halign: Gtk.Align.START, valign: Gtk.Align.CENTER,
            })
            installButton.visible = false
            const buttonsBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, margin_start: 12, margin_end: 12, margin_top: 8 })
            buttonsBox.append(checkButton)
            buttonsBox.append(installButton)

            group.box.append(statusLabel)
            group.box.append(buttonsBox)
            group.box.append(resultLabel)
            group.box.append(limitsLabel)

            // Set while we are SHOWING what the system already says, so
            // the selection we make programmatically doesn't come back
            // around as a write (the power profile group's syncing flag,
            // same reason).
            let syncing = false
            let current: Mode = "off"
            let lastStatus: AnonymityStatus | null = null

            const selectMode = (mode: Mode) => {
                const idx = MODES.findIndex((m) => m.id === mode)
                if (idx < 0) return
                const row = group.listBox.get_row_at_index(idx)
                if (!row) return
                syncing = true
                group.listBox.select_row(row)
                syncing = false
                checkIcons.forEach((icon, id) => { icon.visible = id === mode })
                current = mode
            }

            const paintStatus = (st: AnonymityStatus | null) => {
                lastStatus = st
                if (!st) {
                    statusLabel.label = t("settings.safety.anonymity.state.unknown")
                    installButton.visible = false
                    return
                }
                if (st.mode === "tor") {
                    let line = t("settings.safety.anonymity.state.tor")
                    if (st.warnings.length > 0) line += ` · ${st.warnings[0]}`
                    statusLabel.label = line
                } else if (st.vpn_active) {
                    statusLabel.label = t("settings.safety.anonymity.state.vpn")
                        .replace("{name}", st.vpn_active)
                } else {
                    statusLabel.label = t("settings.safety.anonymity.state.off")
                }
                installButton.visible = !st.tor_installed
            }

            const refreshStatus = () => {
                void getAnonymityStatus().then((st) => {
                    paintStatus(st)
                    if (!st) return
                    selectMode(st.mode === "tor" ? "tor" : st.vpn_active ? "vpn" : "off")
                })
            }
            onPageShown(refreshStatus)

            // Refuse a selection the system cannot honour, and say why —
            // the row snaps back to the live mode instead of claiming a
            // mode that is not on.
            const refuse = (message: string) => {
                statusLabel.label = message
                selectMode(current)
            }

            group.listBox.connect("row-selected", (_: any, row: any) => {
                checkIcons.forEach((i) => { i.visible = false })
                if (!row) return
                const id = row.get_name() as Mode
                if (!id) return
                checkIcons.get(id)!.visible = true
                if (syncing) return
                if (id === current) return
                const st = lastStatus
                if (id === "tor") {
                    if (st && !st.tor_installed) {
                        refuse(t("settings.safety.anonymity.state.no-tor"))
                        return
                    }
                    // The tap is already painted (the check above); the
                    // row only STAYS on Tor once the apply has actually
                    // succeeded — the refresh after it selects the true
                    // mode, so a cancelled prompt snaps back to the mode
                    // that was really on. `current` does not change here.
                    void applyTorMode(true).then(refreshStatus).catch((e) => {
                        if (e instanceof ApplyCancelled) { refreshStatus(); return }
                        void runSettingsAction(() => { throw e })
                        refreshStatus()
                    })
                    return
                }
                if (id === "off") {
                    if (current === "tor") {
                        void applyTorMode(false).then(refreshStatus).catch((e) => {
                            if (e instanceof ApplyCancelled) { refreshStatus(); return }
                            void runSettingsAction(() => { throw e })
                            refreshStatus()
                        })
                        return
                    }
                    if (current === "vpn" && st?.vpn_active) {
                        const name = st.vpn_active
                        void Net.vpnDown(name).then(refreshStatus).catch((e) => {
                            console.error("[Anonymity] vpn down:", e)
                            void runSettingsAction(() => { throw e })
                            refreshStatus()
                        })
                        return
                    }
                    return
                }
                // id === "vpn"
                if (current === "tor") {
                    // Tor off first (admin password — the sensitive
                    // direction), then the VPN up. If the user cancels the
                    // password prompt, Tor stays on and the selection
                    // snaps back to it.
                    void applyTorMode(false).then(() => {
                        void bringVpnUp()
                    }).catch((e) => {
                        if (e instanceof ApplyCancelled) { refreshStatus(); return }
                        void runSettingsAction(() => { throw e })
                        refreshStatus()
                    })
                    return
                }
                void bringVpnUp()
            })

            const bringVpnUp = async () => {
                const profiles = await Net.listVpnProfiles()
                if (profiles.length === 0) {
                    refuse(t("settings.safety.anonymity.state.vpn-none"))
                    return
                }
                const active = profiles.find((p) => p.active)
                const target = active ?? profiles[0]
                if (active) { refreshStatus(); return }
                try {
                    await Net.vpnUp(target.name)
                } catch (e) {
                    console.error("[Anonymity] vpn up:", e)
                    void runSettingsAction(() => { throw e })
                }
                refreshStatus()
            }

            checkButton.connect("clicked", () => {
                checkButton.sensitive = false
                resultLabel.label = ""
                void runLeakCheck().then((res) => {
                    if (!res) {
                        resultLabel.label = t("settings.safety.anonymity.check.failed")
                        return
                    }
                    if (!res.checked) {
                        resultLabel.label = t("settings.safety.anonymity.check.off")
                        return
                    }
                    const torLine = res.tor
                        ? t("settings.safety.anonymity.check.tor").replace("{ip}", res.exit_ip ?? "?")
                        : t("settings.safety.anonymity.check.not-tor").replace("{ip}", res.exit_ip ?? "?")
                    const dnsLine = res.dns_via_tor
                        ? t("settings.safety.anonymity.check.dns-yes")
                        : t("settings.safety.anonymity.check.dns-no")
                    resultLabel.label = `${torLine} · ${dnsLine}`
                    if (res.error) resultLabel.label += ` · ${res.error}`
                }).catch((e) => {
                    console.error("[Anonymity] leak-check:", e)
                    resultLabel.label = t("settings.safety.anonymity.check.failed")
                }).finally(() => {
                    checkButton.sensitive = true
                })
            })

            installButton.connect("clicked", () => {
                installButton.sensitive = false
                installButton.label = t("settings.safety.anonymity.installing")
                void installTor().then(() => {
                    refreshStatus()
                }).catch((e) => {
                    if (e instanceof ApplyCancelled) return
                    void runSettingsAction(() => { throw e })
                }).finally(() => {
                    installButton.sensitive = true
                    installButton.label = t("settings.safety.anonymity.install-tor")
                })
            })

            bindWhileRealized(group.box, () => {
                refreshStatus()
                return () => {}
            })
            return group.box
        },
    } satisfies Record<string, ItemBuilder>
}
