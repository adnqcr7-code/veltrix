import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import { listGroup, createRow, staticLabel, pageBox, onPageShown, bindWhileRealized, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import { uiIcon } from "../../../core/Icons"
import * as Net from "../../../core/NetworkService"
import type { VpnProfile } from "../../../core/NetworkService"
import { FREE_VPN_PROVIDERS } from "../../../core/FreeVpnProviders"
import { VeltrixButton, VeltrixEmptyRow, attachTooltip, showVeltrixAlert, showVeltrixFormDialog } from "../../../../lib/veltrix-kit"
import { safeDisconnect } from "../../../core/signals"
import { joinNetwork, joinOtherNetwork } from "../../../common/WifiSecretsDialog"
import { buildIpSettings } from "./network-ip"

function buildVpnRow(profile: VpnProfile, onRefresh: () => void, onStatus: (msg: string) => void): Gtk.ListBoxRow {
    let active = profile.active

    const btn = VeltrixButton({ pill: true })

    function setState(state: "connect" | "disconnect" | "loading" | "error") {
        switch (state) {
            case "connect":
                btn.label = t("settings.network.vpn.btn.connect")
                btn.add_css_class("veltrix-btn--primary")
                btn.sensitive = true; break
            case "disconnect":
                // Disconnect is reversible → neutral (secondary). Danger is reserved
                // for destructive actions (forget). See VeltrixButton convention.
                btn.label = t("settings.network.vpn.btn.disconnect")
                btn.remove_css_class("veltrix-btn--primary")
                btn.sensitive = true; break
            case "loading":
                btn.label = t("settings.network.vpn.btn.connecting")
                btn.sensitive = false; break
            case "error":
                btn.label = t("settings.network.ap.label.error")
                btn.sensitive = false
                setTimeout(() => setState(active ? "disconnect" : "connect"), 2000); break
        }
    }
    setState(active ? "disconnect" : "connect")

    btn.connect("clicked", async () => {
        setState("loading")
        try {
            if (active) {
                await Net.vpnDown(profile.name)
                active = false
            } else {
                await Net.vpnUp(profile.name)
                active = true
            }
            setState(active ? "disconnect" : "connect")
            setTimeout(onRefresh, 1500)
        } catch (e) {
            console.error("[Network] VPN toggle failed:", e)
            setState("error")
        }
    })

    // Delete — destructive, so it asks first. Deleting removes only the
    // NetworkManager profile; the .conf/.ovpn file it came from is the
    // user's and stays where it is.
    const rightBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    rightBox.append(btn)
    const deleteBtn = VeltrixButton({ variant: "danger", pill: true, icon: true })
    attachTooltip(deleteBtn, t("settings.network.vpn.delete"), { chrome: false })
    deleteBtn.update_property([Gtk.AccessibleProperty.LABEL], [`${t("settings.network.vpn.delete")} · ${profile.name}`])
    deleteBtn.set_child(new Gtk.Image({ gicon: uiIcon("nd-user-trash"), pixel_size: 16, css_classes: ["nd-icon"] }))
    deleteBtn.connect("clicked", () => {
        showVeltrixAlert({
            parent: deleteBtn.get_root() as Gtk.Window | null,
            heading: t("settings.network.vpn.delete.title"),
            body: t("settings.network.vpn.delete.body").replace("%s", profile.name),
            responses: [
                { id: "cancel", label: t("settings.network.vpn.delete.cancel") },
                { id: "delete", label: t("settings.network.vpn.delete.confirm"), destructive: true },
            ],
            onResponse: (id) => {
                if (id !== "delete") return
                deleteBtn.sensitive = false
                Net.vpnDelete(profile.name).then(res => {
                    if (res.ok) {
                        onStatus(t("settings.network.vpn.deleted").replace("%s", profile.name))
                        onRefresh()
                    } else {
                        const detail = (res.error ?? "").split("\n")[0]?.slice(0, 160) ?? ""
                        onStatus(`${t("settings.network.vpn.delete.failed")}${detail ? `: ${detail}` : ""}`)
                        deleteBtn.sensitive = true
                    }
                })
            },
        })
    })
    rightBox.append(deleteBtn)

    return createRow(profile.name, Net.vpnTypeName(profile.type), rightBox)
}

// ── Manual WireGuard add ────────────────────────────────────────────────────
// The user types the server details instead of importing a file. The keys
// go straight from these entries into NetworkService.addManualWireGuard,
// which writes them to a 0600 temp file, imports it, and deletes the file
// — they are never logged and never stored by our code. The dialog stays
// open on a validation error so the user can fix the field.
function openManualVpnDialog(parent: Gtk.Window | null, onAdded: () => void, onStatus: (msg: string) => void) {
    const grid = new Gtk.Grid({ row_spacing: 8, column_spacing: 12 })
    const mkEntry = (placeholder: string, secret = false) => {
        const e = new Gtk.Entry({ placeholder_text: placeholder, hexpand: true })
        if (secret) e.visibility = false
        return e
    }
    const nameEntry = mkEntry("e.g. My server")
    const endpointEntry = mkEntry("vpn.example.com:51820")
    const privateKeyEntry = mkEntry("44-character key", true)
    const peerKeyEntry = mkEntry("44-character key", true)
    const addressEntry = mkEntry("10.0.0.2/32")
    const allowedEntry = mkEntry("0.0.0.0/0, ::/0")
    const dnsEntry = mkEntry("1.1.1.1 (optional)")
    const rows: [string, Gtk.Entry][] = [
        [t("settings.network.vpn.manual.name"), nameEntry],
        [t("settings.network.vpn.manual.endpoint"), endpointEntry],
        [t("settings.network.vpn.manual.private-key"), privateKeyEntry],
        [t("settings.network.vpn.manual.peer-key"), peerKeyEntry],
        [t("settings.network.vpn.manual.tunnel-address"), addressEntry],
        [t("settings.network.vpn.manual.allowed-ips"), allowedEntry],
        [t("settings.network.vpn.manual.dns"), dnsEntry],
    ]
    rows.forEach(([label, entry], i) => {
        grid.attach(new Gtk.Label({ label, halign: Gtk.Align.START, valign: Gtk.Align.CENTER }), 0, i, 1, 1)
        grid.attach(entry, 1, i, 1, 1)
    })
    const errorLabel = new Gtk.Label({
        label: "", wrap: true, xalign: 0,
        css_classes: ["veltrix-row-subtitle"], visible: false,
    })
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 })
    content.append(grid)
    content.append(errorLabel)
    const showError = (msg: string) => { errorLabel.label = msg; errorLabel.visible = true }

    const manualErrorKey: Record<string, string> = {
        "invalid-name": "settings.network.vpn.manual.error.name",
        "invalid-endpoint": "settings.network.vpn.manual.error.endpoint",
        "invalid-private-key": "settings.network.vpn.manual.error.private-key",
        "invalid-peer-key": "settings.network.vpn.manual.error.peer-key",
        "invalid-address": "settings.network.vpn.manual.error.address",
        "invalid-allowed-ips": "settings.network.vpn.manual.error.allowed-ips",
        "invalid-dns": "settings.network.vpn.manual.error.dns",
    }

    showVeltrixFormDialog({
        parent,
        heading: t("settings.network.vpn.manual.title"),
        body: t("settings.network.vpn.manual.body"),
        width: 520,
        content,
        responses: [
            { id: "cancel", label: t("settings.network.vpn.manual.cancel") },
            { id: "add", label: t("settings.network.vpn.manual.add"), suggested: true },
        ],
        onResponse: (id, handle) => {
            if (id !== "add") { handle.close(id); return }
            // No values are logged here or anywhere downstream: the keys
            // travel entries → addManualWireGuard → temp file → NM only.
            const details = {
                name: nameEntry.text,
                endpoint: endpointEntry.text,
                privateKey: privateKeyEntry.text,
                peerPublicKey: peerKeyEntry.text,
                tunnelAddress: addressEntry.text || "10.0.0.2/32",
                allowedIps: allowedEntry.text || "0.0.0.0/0, ::/0",
                dns: dnsEntry.text,
            }
            handle.setResponseSensitive("add", false)
            Net.addManualWireGuard(details).then(res => {
                if (res.ok && res.name) {
                    handle.close(id)
                    onStatus(t("settings.network.vpn.import.added").replace("%s", res.name))
                    onAdded()
                } else if (res.error && manualErrorKey[res.error]) {
                    showError(t(manualErrorKey[res.error] as Parameters<typeof t>[0]))
                    handle.setResponseSensitive("add", true)
                } else {
                    const detail = (res.error ?? "").split("\n")[0]?.slice(0, 160) ?? ""
                    showError(`${t("settings.network.vpn.import.failed")}${detail ? `: ${detail}` : ""}`)
                    handle.setResponseSensitive("add", true)
                }
            })
        },
    })
}

// IP with the Settings-style "None" fallback (the CC/bar widgets use a dash).
const ipOf = (service: any) => Net.getIp(service, t("settings.network.label.none"))

// ── AP row ────────────────────────────────────────────────────────────────────

/** The last attempt that ended in a failure, per SSID — the only state a row cannot
 *  read back from NM. Rows are rebuilt on every AP-list / device-state change, so
 *  anything a row kept in its own closure (the old "Connecting…" and "Error" labels)
 *  was thrown away mid-attempt: a refused password showed "Disconnect", as if
 *  connected, and then went back to "Connect" without a word. */
const failedSsids = new Set<string>()

function buildApRow(ap: any, isSaved: boolean, onRefresh: () => void, onDetails?: () => void): Gtk.ListBoxRow {
    // An SSID is arbitrary bytes on the wire, so NM hands it over as GLib.Bytes —
    // Net.apSsid is the decoder. Everything else on an AP is read straight off it.
    const ssid    = Net.apSsid(ap)
    const secured = Net.isSecured(ap)
    // Connected / connecting / idle comes from the adapter at build time; the page
    // rebuilds this row whenever that changes (Net.watchAccessPoints).
    const link    = Net.apLinkState(ap)

    // Right-side widget: optional info + (forget) + action button. (The lock for a
    // secured AP rides next to the SSID via createRow's titleIcon, not here.)
    const rightBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })

    // Lock badge next to the network name when the AP is secured.
    const lockIcon = secured
        ? new Gtk.Image({ gicon: uiIcon("nd-system-lock-screen"), pixel_size: 13, opacity: 0.5, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"] })
        : undefined

    // Network details subpage (security, band, channel, BSSID, IP when connected).
    if (onDetails) {
        const infoBtn = VeltrixButton({ variant: "secondary", pill: true, icon: true })
        attachTooltip(infoBtn, t("settings.network.ap.details"), { chrome: false })
        // An icon button's tooltip is not its name: without this a screen reader (and the
        // agent's AT-SPI tools) met a bare "button" beside every network.
        infoBtn.update_property([Gtk.AccessibleProperty.LABEL], [`${t("settings.network.ap.details")} · ${ssid}`])
        infoBtn.set_child(new Gtk.Image({ gicon: uiIcon("nd-network-wireless-configure"), pixel_size: 16, css_classes: ["nd-icon"] }))
        infoBtn.connect("clicked", onDetails)
        rightBox.append(infoBtn)
    }

    // Forget — only for saved networks the adapter is not on or joining.
    if (isSaved && link === "idle") {
        const forgetBtn = VeltrixButton({
            variant: "danger",
            pill: true,
            icon: true,
        })
        attachTooltip(forgetBtn, t("settings.network.ap.forget"), { chrome: false })
        forgetBtn.update_property([Gtk.AccessibleProperty.LABEL], [`${t("settings.network.ap.forget")} · ${ssid}`])
        forgetBtn.set_child(new Gtk.Image({ gicon: uiIcon("nd-user-trash"), pixel_size: 16, css_classes: ["nd-icon"] }))
        forgetBtn.connect("clicked", () => {
            forgetBtn.sensitive = false
            failedSsids.delete(ssid)
            // The row rebuilds itself on NM's connection-removed.
            Net.forgetNetwork(ap).catch(e => { console.error("[Network] forget failed:", e); forgetBtn.sensitive = true })
        })
        rightBox.append(forgetBtn)
    }

    const btn = VeltrixButton({ pill: true })
    rightBox.append(btn)
    switch (link) {
        case "connected":
            // Reversible → neutral (secondary); danger is reserved for forget.
            btn.label = t("settings.network.ap.disconnect")
            break
        case "connecting":
            btn.label = t("settings.network.ap.connecting")
            btn.sensitive = false
            break
        default:
            btn.label = t("settings.network.ap.connect")
            btn.add_css_class("veltrix-btn--primary")
    }

    btn.connect("clicked", () => {
        btn.sensitive = false
        if (link === "connected") {
            Net.disconnectWifi().catch(e => { console.error("[Network] disconnect failed:", e); btn.sensitive = true })
            return
        }
        failedSsids.delete(ssid)
        const onFail = (e: any) => {
            if (!(e instanceof Net.ConnectError)) console.error("[Network] connect failed:", e)
            if (e?.reason !== "cancelled") failedSsids.add(ssid)
            onRefresh()
        }
        // No password here, ever: NetworkManager asks for one through the shell's
        // secret agent (core/NetworkAgent) when — and each time — it needs it. Only an
        // enterprise network needs its form first, and only the first time.
        joinNetwork(ap, isSaved).catch(e => { if (e?.reason === "cancelled") btn.sensitive = true; onFail(e) })
    })

    const subtitle = link === "idle" && failedSsids.has(ssid)
        ? t("settings.network.ap.failed")
        : `${ap.strength}% • ${ap.frequency} MHz`
    return createRow(ssid, subtitle, rightBox, lockIcon)
}

// ── AP detail subpage ───────────────────────────────────────────────────────────

function buildApDetailPage(ap: any): Gtk.Widget {
    // Title (the SSID) rides in the window-header breadcrumb — see the pushSubpage
    // call in refreshAps — so the page body starts straight at the info group.
    const page = pageBox("network-ap-detail-page")

    const { box: infoBox, listBox: infoList } = listGroup(t("settings.network.detail.group.info"))
    const signalLabel = staticLabel(`${ap.strength}%`)
    infoList.append(createRow(t("settings.network.detail.security"),  t("settings.network.detail.security.desc"),  staticLabel(Net.securityLabel(ap))))
    infoList.append(createRow(t("settings.network.detail.signal"),    t("settings.network.detail.signal.desc"),    signalLabel))
    infoList.append(createRow(t("settings.network.detail.band"),      t("settings.network.detail.band.desc"),      staticLabel(Net.freqBand(ap.frequency))))
    infoList.append(createRow(t("settings.network.detail.channel"),   t("settings.network.detail.channel.desc"),   staticLabel(String(Net.freqChannel(ap.frequency)))))
    infoList.append(createRow(t("settings.network.detail.frequency"), t("settings.network.detail.frequency.desc"), staticLabel(`${ap.frequency} MHz`)))
    infoList.append(createRow(t("settings.network.detail.bssid"),     t("settings.network.detail.bssid.desc"),     staticLabel(ap.bssid)))
    const maxRate = ap.max_bitrate ? `${Math.round(ap.max_bitrate / 1000)} Mbps` : "---"
    infoList.append(createRow(t("settings.network.detail.max-rate"),  t("settings.network.detail.max-rate.desc"),  staticLabel(maxRate)))
    page.append(infoBox)

    // MAC and link speed are the adapter's, and only mean something while this is the
    // network it is on. IP and DNS are the form below, which shows the live values too.
    const { box: connBox, listBox: connList } = listGroup(t("settings.network.detail.group.ipv4"))
    const macLabel   = staticLabel("---")
    const speedLabel = staticLabel("---")
    connList.append(createRow(t("settings.network.detail.mac"),     t("settings.network.detail.mac.desc"),     macLabel))
    connList.append(createRow(t("settings.network.speed"),          t("settings.network.detail.speed.desc"),   speedLabel))
    page.append(connBox)

    // IP and DNS of the SAVED profile — a network never joined has nothing to edit yet.
    // Joining or forgetting it with this page open adds or removes the form.
    const target = Net.wifiIpTarget(ap)
    const ipHolder = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    page.append(ipHolder)
    let hasForm = false
    const syncForm = () => {
        const has = !!target.profile()
        if (has === hasForm) return
        hasForm = has
        let child = ipHolder.get_first_child()
        while (child) { ipHolder.remove(child); child = ipHolder.get_first_child() }
        if (has) ipHolder.append(buildIpSettings(target))
    }

    const update = () => {
        signalLabel.label = `${ap.strength}%`
        const dev = target.liveDevice() as any
        connBox.visible = !!dev
        if (!dev) return
        macLabel.label = dev.get_hw_address?.() || "---"
        const kbps = dev.bitrate || 0
        speedLabel.label = kbps > 0 ? `${Math.round(kbps / 1000)} Mbps` : "---"
    }

    // The signal lives on the AP object itself; the rest on the wifi device and the
    // saved profiles. All of it refreshes the page in place.
    bindWhileRealized(page, () => {
        const apStrengthId = ap.connect?.("notify::strength", update) ?? 0
        const disposers = [Net.watchWifi(update), Net.watchAccessPoints(syncForm)]
        update(); syncForm()
        return () => {
            if (apStrengthId) safeDisconnect(ap, apStrengthId)
            disposers.forEach(d => d())
        }
    })

    return page
}

// ── Ethernet detail subpage ───────────────────────────────────────────────────

function buildEthernetDetailPage(): Gtk.Widget {
    const page = pageBox("network-ethernet-detail-page")

    const { box: infoBox, listBox: infoList } = listGroup(t("settings.network.detail.group.info"))
    const stateLabel = staticLabel("---")
    const ifaceLabel = staticLabel("---")
    const macLabel   = staticLabel("---")
    const speedLabel = staticLabel("---")
    infoList.append(createRow(t("widget.ethernet.row.status"), t("settings.network.ethernet.status.desc"), stateLabel))
    infoList.append(createRow(t("settings.network.interface"), t("settings.network.kernel-device.desc"),   ifaceLabel))
    infoList.append(createRow(t("settings.network.detail.mac"), t("settings.network.detail.mac.desc"),     macLabel))
    infoList.append(createRow(t("settings.network.speed"),     t("settings.network.detail.speed.desc"),    speedLabel))
    page.append(infoBox)

    // Always there: with no profile yet (a cable never plugged in), Apply makes one.
    page.append(buildIpSettings(Net.wiredIpTarget()))

    const update = () => {
        const w = Net.wired()
        stateLabel.label = Net.wiredStateText()
        ifaceLabel.label = w?.device.get_iface() || "---"
        macLabel.label   = w?.device.get_hw_address() || "---"
        speedLabel.label = Net.wiredState() === "connected" ? Net.linkSpeed(w?.speed ?? 0) || "---" : "---"
    }
    bindWhileRealized(page, () => { const off = Net.watchWired(update); update(); return off })
    return page
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NetworkPage(nav?: SettingsNav) {
    // No NetworkManager at all is a different answer from "no adapter": there is
    // nothing to watch, so the page says so once instead of switching placeholders.
    if (!Net.available()) return new Gtk.Label({ label: t("settings.network.error.no-service") })

    const page = pageBox("network-page")

    // Settings builds every page once and caches it for the window's lifetime, so
    // hardware presence cannot be a build-time check — and it WAS one here until
    // NetworkService stopped going through AstalNetwork (tech-debt #22/#71): the
    // old singleton resolved its Wi-Fi/Ethernet wrappers in `construct` and never
    // re-scanned, so the question was unanswerable a second time. It reads
    // NetworkManager directly now, and `watchDevices` fires when an adapter
    // appears or disappears. Every section below is therefore BUILT ALWAYS and
    // switched live at the bottom of this function, the same shape Bluetooth uses
    // for its no-adapter banner. Do not put a device behind an `if` here again.

    // ── Ethernet ──────────────────────────────────────────────────────────────
    // The switch (GNOME's Wired toggle — it holds across a
    // restart, see Net.setWiredEnabled), the state in words, and the details: the
    // adapter's facts and the IP/DNS form.
    const { box: ethBox, listBox: ethList } = listGroup(t("settings.network.group.ethernet"))

    const ethSwitch = new Gtk.Switch({ active: Net.wiredEnabled(), valign: Gtk.Align.CENTER })
    ethSwitch.update_property([Gtk.AccessibleProperty.LABEL], [t("cc.ethernet.name")])
    // Same guard as the Wi-Fi switch below: GtkSwitch emits state-set for a
    // programmatic `active` too, and the write-back must not re-issue the command.
    let ethSyncing = false
    ethSwitch.connect("state-set", (_sw, on) => {
        if (!ethSyncing) Net.setWiredEnabled(on).catch(e => console.error("[Network] Ethernet switch:", e))
        return false
    })
    ethList.append(createRow(t("cc.ethernet.name"), t("settings.network.ethernet.switch.desc"), ethSwitch))

    const wiredStatus = staticLabel("---")
    const ethDetails = VeltrixButton({ label: t("settings.network.ethernet.details"), variant: "secondary", pill: true, valign: Gtk.Align.CENTER })
    ethDetails.visible = !!nav
    ethDetails.connect("clicked", () => nav?.pushSubpage({
        id: "network/ethernet",
        title: t("cc.ethernet.name"),
        parentId: "network",
        build: buildEthernetDetailPage,
    }))
    const statusBox = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })
    statusBox.append(wiredStatus)
    statusBox.append(ethDetails)
    ethList.append(createRow(t("widget.ethernet.row.status"), t("settings.network.ethernet.status.desc"), statusBox))

    const updateWired = () => {
        const on = Net.wiredEnabled()
        if (ethSwitch.active !== on) { ethSyncing = true; ethSwitch.active = on; ethSyncing = false }
        wiredStatus.label = Net.wiredStateText()
    }
    page.append(ethBox)

    // ── Wi-Fi ─────────────────────────────────────────────────────────────────
    const { box: wifiBox, listBox: wifiList } = listGroup(t("settings.network.group.wi-fi"))

    const wifiSwitch = new Gtk.Switch({ active: Net.wifiEnabled(), valign: Gtk.Align.CENTER })
    wifiSwitch.update_property([Gtk.AccessibleProperty.LABEL], [t("settings.network.group.wi-fi")])   // #615
    // state-set issues the radio command; the switch's visible state is driven
    // back from the radio flag so it stays truthful if the radio is toggled
    // elsewhere (CC tile, nmcli) and doesn't fight the command. `syncing` marks
    // the write-back, because GtkSwitch emits state-set for a programmatic
    // `active` too — without it, an external toggle would spawn an nmcli that
    // re-commands the state we are merely reflecting.
    let syncing = false
    wifiSwitch.connect("state-set", (_sw, state) => { if (!syncing) Net.setWifiEnabled(state); return false })

    wifiList.append(createRow(t("settings.network.enable-wifi"), t("settings.network.enable-wifi.desc"), wifiSwitch))

    const ssidLabel  = staticLabel("---")
    const wifiIpLabel = staticLabel("---")
    const speedLabel = staticLabel("---")
    const ifaceLabel = staticLabel("---")

    const updateWifi = () => {
        const w = Net.wifi()

        const enabled = Net.wifiEnabled(w)
        if (wifiSwitch.active !== enabled) { syncing = true; wifiSwitch.active = enabled; syncing = false }

        ifaceLabel.label  = w?.device.get_iface() || "---"
        ssidLabel.label   = w?.ssid || t("settings.network.status.disconnected-hw")
        wifiIpLabel.label = ipOf(w)
        // Link speed is the NM device's bitrate (kb/s); nothing higher up carries it.
        const kbps        = w?.device.bitrate ?? 0
        speedLabel.label  = kbps > 0 ? `${Math.round(kbps / 1000)} Mbps` : "---"
    }

    wifiList.append(createRow(t("settings.network.interface"),    t("settings.network.wireless-interface.desc"), ifaceLabel))
    wifiList.append(createRow(t("settings.network.access-point"), t("settings.network.connected-network.desc"),  ssidLabel))
    wifiList.append(createRow(t("settings.network.ip"),           t("settings.network.access-point.desc"),       wifiIpLabel))
    wifiList.append(createRow(t("settings.network.speed"),        t("settings.network.speed.desc"),              speedLabel))
    page.append(wifiBox)

    // ── AP list ───────────────────────────────────────────────────────────────
    const { box: apBox, listBox: apList } = listGroup(t("settings.network.group.access-points"))

    const scanBtn = VeltrixButton({
        label: t("settings.network.ap.scan"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.END,
    })

    const headerBox = new Gtk.Box({ spacing: 0, hexpand: true })
    const groupTitleLabel = new Gtk.Label({
        label: t("settings.network.group.access-points").toUpperCase(),
        css_classes: ["veltrix-list-title"],
        halign: Gtk.Align.START,
        hexpand: true,
        margin_start: 20,
    })
    // A hidden network is not in the list to click; libnma's form names it.
    const otherBtn = VeltrixButton({
        label: t("settings.network.ap.other"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.END,
    })
    otherBtn.margin_end = 8
    otherBtn.connect("clicked", () => {
        joinOtherNetwork().catch(e => { if (e?.reason !== "cancelled") console.error("[Network] hidden network:", e) })
    })

    headerBox.append(groupTitleLabel)
    headerBox.append(otherBtn)
    headerBox.append(scanBtn)

    // Replace the plain title in apBox with the header+scan button row
    const firstChild = apBox.get_first_child()
    if (firstChild) apBox.remove(firstChild)
    apBox.prepend(headerBox)

    // Synchronous end to end (saved profiles are read from libnm, not an nmcli
    // spawn), so overlapping refreshes cannot interleave and duplicate rows.
    function refreshAps() {
        const wifi = Net.wifi()
        if (!wifi) { apBox.visible = false; return }

        const enabled     = wifi.enabled
        const activeAp    = wifi.active_access_point
        const activeBssid = activeAp?.bssid

        const aps: any[] = (wifi.get_access_points() || [])
            .filter((ap: any) => !!Net.apSsid(ap))
            .sort((a: any, b: any) => b.strength - a.strength)
            .slice(0, 12)

        // The connected AP must always be shown, even if it fell outside top-12.
        if (activeAp && activeBssid && !aps.some((ap: any) => ap.bssid === activeBssid)) {
            aps.unshift(activeAp)
        }

        const savedSsids = Net.savedWifiSsids()

        let child = apList.get_first_child()
        while (child) { apList.remove(child); child = apList.get_first_child() }

        for (const ap of aps) {
            const ssid = Net.apSsid(ap)
            const onDetails = nav
                ? () => nav.pushSubpage({
                    id: `network/ap/${ap.bssid}`,
                    title: ssid,
                    parentId: "network",
                    build: () => buildApDetailPage(ap),
                })
                : undefined
            apList.append(buildApRow(
                ap,
                savedSsids.has(ssid),
                refreshAps,
                onDetails,
            ))
        }

        // The Scan button lives in this group's header, so the group must stay
        // visible whenever Wi-Fi is on — otherwise there's no way to scan for
        // the first network. Show an empty placeholder when nothing is found.
        if (aps.length === 0) apList.append(VeltrixEmptyRow(t("settings.network.ap.empty")))

        apBox.visible = enabled
    }

    scanBtn.connect("clicked", () => {
        scanBtn.sensitive = false
        Net.rescan().then(() => {
            setTimeout(() => {
                refreshAps()
                scanBtn.sensitive = true
            }, 2000)
        })
    })
    page.append(apBox)

    // ── No wireless adapter ───────────────────────────────────────────────────
    const { box: noWifiBox, listBox: noWifiList } = listGroup(t("settings.network.group.wireless"))
    noWifiList.append(createRow(
        t("settings.network.hw-status"),
        t("settings.network.no-adapter.desc"),
        staticLabel(t("settings.network.error.no-wifi-hw"))
    ))
    page.append(noWifiBox)

    // ── Adapter presence ──────────────────────────────────────────────────────
    // The banner ↔ content switch. Called on every realize and on every
    // device-added/device-removed, so plugging a USB dongle in with this page
    // open swaps the "no adapter" group for the live one without a shell reload.
    const applyDevices = () => {
        const hasWired = !!Net.wired()
        const hasWifi  = !!Net.wifi()

        ethBox.visible    = hasWired
        wifiBox.visible   = hasWifi
        noWifiBox.visible = !hasWifi

        if (hasWired) updateWired()
        if (hasWifi) { updateWifi(); refreshAps() }
        else apBox.visible = false
    }

    // Armed per VISIT, not per window: Settings only `remove()`s a page when you
    // navigate away, which unrealizes it without destroying it. Subscribing at
    // build time meant these were torn down the first time the user left and
    // never re-armed — the page came back looking alive but frozen. It also
    // leaked: none of the old handlers were ever disconnected.
    bindWhileRealized(page, () => {
        const disposers = [
            Net.watchDevices(applyDevices),
            Net.watchWired(updateWired),
            Net.watchWifi(updateWifi),
            Net.watchAccessPoints(refreshAps),
        ]
        applyDevices()
        return () => disposers.forEach(d => d())
    })

    // ── Free VPN services ───────────────────────────────────────────────────
    // Only the providers vetted in core/FreeVpnProviders.ts (Proton VPN
    // Free, RiseupVPN) — each with its honest catch: Proton needs a free
    // account, Riseup has no independent no-logs audit and runs through its
    // own app, not NetworkManager. "How to set up" opens the steps; nothing
    // here connects on its own, and no other "free" VPN is listed — a VPN
    // provider sees all your traffic, so a shady free one is worse than none.
    const { box: freeVpnBox, listBox: freeVpnList } = listGroup(
        t("settings.network.group.free-vpn"),
        t("settings.network.free-vpn.footer"),
    )
    for (const provider of FREE_VPN_PROVIDERS) {
        const setupBtn = VeltrixButton({
            label: t("settings.network.free-vpn.setup-btn"),
            variant: "secondary",
            pill: true,
            valign: Gtk.Align.CENTER,
        })
        setupBtn.connect("clicked", () => {
            showVeltrixAlert({
                parent: setupBtn.get_root() as Gtk.Window | null,
                heading: t(provider.nameKey),
                body: t(provider.setupKey),
                responses: [{ id: "close", label: t("settings.network.free-vpn.setup-close"), suggested: true }],
                onResponse: () => {},
            })
        })
        freeVpnList.append(createRow(
            t(provider.nameKey),
            `${t(provider.descKey)} · ${t(provider.accountKey)}`,
            setupBtn,
        ))
    }
    page.append(freeVpnBox)

    // ── VPN ───────────────────────────────────────────────────────────────────
    const { box: vpnBox, listBox: vpnList } = listGroup(t("settings.network.group.vpn"))

    // "Add VPN" — importing the user's own .conf/.ovpn (Net.importVpnProfile).
    // The header carries the button the way the access-points group carries
    // Scan, so it is there even when the list is empty.
    const addVpnBtn = VeltrixButton({
        label: t("settings.network.vpn.add"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.END,
    })
    const vpnHeaderBox = new Gtk.Box({ spacing: 0, hexpand: true })
    const vpnGroupTitleLabel = new Gtk.Label({
        label: t("settings.network.group.vpn").toUpperCase(),
        css_classes: ["veltrix-list-title"],
        halign: Gtk.Align.START,
        hexpand: true,
        margin_start: 20,
    })
    vpnHeaderBox.append(vpnGroupTitleLabel)
    // Type the server details in by hand (WireGuard) instead of importing
    // a file — the keys go to NetworkManager the same way, via a 0600 temp
    // file that is deleted right after import. See openManualVpnDialog.
    const manualVpnBtn = VeltrixButton({
        label: t("settings.network.vpn.add-manual"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.END,
    })
    manualVpnBtn.margin_end = 8
    manualVpnBtn.connect("clicked", () => {
        openManualVpnDialog(
            manualVpnBtn.get_root() as Gtk.Window | null,
            refreshVpn,
            showVpnStatus,
        )
    })
    vpnHeaderBox.append(manualVpnBtn)
    vpnHeaderBox.append(addVpnBtn)
    const vpnFirstChild = vpnBox.get_first_child()
    if (vpnFirstChild) vpnBox.remove(vpnFirstChild)
    vpnBox.prepend(vpnHeaderBox)

    // One-line outcome of the last import, in the Users-page shape (wrapping
    // label, hidden until there is something to say). The detail is nmcli's
    // own first line — it names the failure (bad file, missing OpenVPN
    // plugin), never a secret: no password or key is ever passed to nmcli.
    const vpnStatusLabel = new Gtk.Label({
        label: "", css_classes: ["veltrix-row-subtitle"], visible: false,
        halign: Gtk.Align.FILL, hexpand: true, xalign: 0, wrap: true,
        margin_start: 20, margin_end: 20, margin_top: 8,
    })
    vpnBox.append(vpnStatusLabel)
    const showVpnStatus = (msg: string) => {
        vpnStatusLabel.label = msg
        vpnStatusLabel.visible = true
    }

    addVpnBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({ title: t("settings.network.vpn.dialog.title"), modal: true })
        const wgFilter = new Gtk.FileFilter()
        wgFilter.add_suffix("conf")
        wgFilter.set_name("WireGuard (.conf)")
        const ovpnFilter = new Gtk.FileFilter()
        ovpnFilter.add_suffix("ovpn")
        ovpnFilter.set_name("OpenVPN (.ovpn)")
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(wgFilter)
        filters.append(ovpnFilter)
        dialog.set_filters(filters)
        const win = addVpnBtn.get_root() as Gtk.Window
        dialog.open(win, null, (_: any, result: any) => {
            let path: string | null = null
            try { path = dialog.open_finish(result)?.get_path() ?? null } catch { /* cancelled */ }
            if (!path) return
            if (!Net.vpnImportKindForPath(path)) {
                showVpnStatus(t("settings.network.vpn.import.unsupported"))
                return
            }
            addVpnBtn.sensitive = false
            Net.importVpnProfile(path).then(res => {
                addVpnBtn.sensitive = true
                if (res.ok && res.name) {
                    showVpnStatus(t("settings.network.vpn.import.added").replace("%s", res.name))
                    refreshVpn()
                } else if (res.error === "unsupported") {
                    showVpnStatus(t("settings.network.vpn.import.unsupported"))
                } else {
                    // First line only, capped: nmcli's error names the failure
                    // (bad file, missing plugin) and never carries a secret.
                    const detail = (res.error ?? "").split("\n")[0]?.slice(0, 160) ?? ""
                    showVpnStatus(`${t("settings.network.vpn.import.failed")}${detail ? `: ${detail}` : ""}`)
                }
            })
        })
    })

    // Bumped on every refresh. `listVpnProfiles` is an async nmcli call and this
    // list is now re-read on every visit, so two refreshes can overlap: without a
    // generation guard the second one clears the list, both promises resolve, and
    // every profile appears twice.
    let vpnGen = 0
    const refreshVpn = () => {
        const gen = ++vpnGen

        Net.listVpnProfiles().then(profiles => {
            if (gen !== vpnGen) return   // a newer refresh already ran

            let child = vpnList.get_first_child()
            while (child) { vpnList.remove(child); child = vpnList.get_first_child() }

            if (profiles.length === 0) {
                // Built fresh each time, not once and re-appended: the label above was a
                // module-level widget re-parented into a new row on every refresh, which
                // only worked because the old row was removed first.
                vpnList.append(VeltrixEmptyRow(t("settings.network.vpn.no-profiles")))
            } else {
                profiles.forEach(p => vpnList.append(buildVpnRow(p, refreshVpn, showVpnStatus)))
            }
        })
    }
    // Wi-Fi, Ethernet and the AP list are SUBSCRIBED (NM signals), so they keep
    // themselves current. The VPN list is not: it is an `nmcli connection show`
    // that was asked exactly once, at build. Since the page is cached and the
    // window hides rather than closes, a profile added with `nmcli`, imported from
    // a .ovpn, or brought up outside Veltrix stayed invisible — and a profile's
    // Connect/Disconnect state was frozen at whatever it was the first time this
    // page was opened. It is a question, so it is re-asked on every visit.
    onPageShown(refreshVpn)
    page.append(vpnBox)

    return page
}
