import Gtk from "gi://Gtk?version=4.0"
import {
    VeltrixScrolled, VeltrixRow, VeltrixList, VeltrixBadge, VeltrixDropDownRow, VeltrixToggleRow, VeltrixButton,
    bindWhileRealized, showVeltrixAlert,
} from "../../../../lib/veltrix-kit"
import {
    PORTAL_PERMISSIONS, getPortalPermission, setPortalPermission, watchPortalPermission,
    type PortalPermissionKey, type PortalPermissionState,
} from "../../../core/PermissionStore"
import {
    INSTALL_PERMISSIONS, readInstallPermissions, setInstallPermission, resetInstallPermissions,
    watchInstallPermissions, type InstallPermission,
} from "../../../core/FlatpakPermissions"
import appService, { type AppData } from "../../../core/AppService"
import { describeUninstall, uninstallApp, type UninstallPlan } from "../../../core/AppUninstall"
import { pageBox, listGroup, imagePickerRow, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import { uiIcon } from "../../../core/Icons"
import { loadPixbuf, makeIconImage } from "./AppIconImage"

// ── Isolation: the one fact every app page leads with (#535) ────────────────────
// A Flatpak is sandboxed: it reaches the camera, the microphone, the files only
// through the portal, so per-app permissions BIND it. Anything else runs unconfined
// and a permission switch would promise what it cannot enforce — the page says so
// instead. A snap is neither labelled isolated nor not: its confinement varies.

function isolationBadge(app: AppData, showUnconfined: boolean): Gtk.Widget | null {
    const origin = appService.getAppOrigin(app.id)
    if (origin === "flatpak") return VeltrixBadge(t("settings.apps.badge.sandboxed"), uiIcon("nd-network-vpn"))
    if (showUnconfined && (origin === "system" || origin === "user"))
        return VeltrixBadge(t("settings.apps.badge.unsandboxed"), uiIcon("nd-network-vpn-disconnected"))
    return null
}

function originLabel(app: AppData): string {
    switch (appService.getAppOrigin(app.id)) {
        case "flatpak": return t("settings.apps.origin.flatpak")
        case "snap":    return t("settings.apps.origin.snap")
        case "user":    return t("settings.apps.origin.user")
        case "system":  return t("settings.apps.origin.system")
        default:        return ""
    }
}

/** The page's header card: who this app is and where it comes from. Not a control. */
function appHeader(app: AppData): Gtk.Widget {
    const { box, listBox } = VeltrixList()
    const icon = makeIconImage(appService.getCanonicalIconName(app.icon ?? ""), 56)
    const subtitle = [app.id, originLabel(app)].filter(Boolean).join(" · ")
    const row = VeltrixRow(app.name, subtitle, isolationBadge(app, true) ?? undefined,
                          ["settings-app-header"], undefined, icon)
    row.activatable = false
    row.selectable = false
    listBox.append(row)
    return box
}

// ── Permissions an isolated app asks for (#535 part 2) ──────────────────────────
// Three states, exactly as the portal's PermissionStore has them (core/PermissionStore):
// Ask = no decision recorded, so the consent prompt appears next time. Only for a
// Flatpak — an unconfined app is not bound by these, and a switch here would lie.
// The row follows the store live: answering the prompt with Settings open moves it.

function permissionRow(appId: string, label: string, key: PortalPermissionKey): Gtk.Widget {
    const labels: Record<PortalPermissionState, string> = {
        ask: t("settings.apps.permissions.ask"),
        allow: t("settings.apps.permissions.allow"),
        deny: t("settings.apps.permissions.deny"),
    }
    const order: PortalPermissionState[] = ["ask", "allow", "deny"]
    return VeltrixDropDownRow(label, "", labels.ask, order.map(o => labels[o]),
        (_v, index) => {
            const state = order[index ?? 0]
            setPortalPermission(key, appId, state)
                .catch(e => console.error(`[apps] could not set ${key.table}/${key.id} for ${appId}:`, e))
        },
        (apply) => {
            // The real value arrives asynchronously; the row opens on "Ask" and moves.
            getPortalPermission(key, appId).then(st => apply(labels[st]))
            return watchPortalPermission(key, appId, st => apply(labels[st]))
        },
    )
}

function permissionsGroup(app: AppData): Gtk.Widget | null {
    if (appService.getAppOrigin(app.id) !== "flatpak") return null
    const { box, listBox } = listGroup(t("settings.apps.permissions.group"), t("settings.apps.permissions.footer"))
    listBox.append(permissionRow(app.id, t("settings.apps.permissions.camera"), PORTAL_PERMISSIONS.camera))
    listBox.append(permissionRow(app.id, t("settings.apps.permissions.wallpaper"), PORTAL_PERMISSIONS.wallpaper))
    return box
}

// ── What an isolated app was given at install (#535 part 3) ─────────────────────
// Not asked for at run time, so never prompted: network, sound, the GPU and the home
// folder hold from the moment the Flatpak is installed (core/FlatpakPermissions).
// On/off, because that is all they are — and each row says whether the app asked for
// it, so "Restore" has something visible to restore TO. Changes reach the app on its
// next launch; the footer says so, since a switch that does nothing now reads broken.

const INSTALL_LABELS = {
    network: "settings.apps.install.network",
    // One socket carries both directions: turning it off also silences the microphone.
    sound: "settings.apps.install.sound",
    gpu: "settings.apps.install.gpu",
    home: "settings.apps.install.home",
} as const satisfies Record<InstallPermission, string>

function installGroup(app: AppData): Gtk.Widget | null {
    const flatpakId = appService.getFlatpakId(app.id)
    const initial = flatpakId ? readInstallPermissions(flatpakId) : null
    if (!flatpakId || !initial) return null

    const { box, listBox } = listGroup(t("settings.apps.install.group"), t("settings.apps.install.footer"))
    for (const permission of INSTALL_PERMISSIONS) {
        listBox.append(VeltrixToggleRow(
            t(INSTALL_LABELS[permission]),
            initial.declared[permission] ? t("settings.apps.install.requested") : t("settings.apps.install.not-requested"),
            initial.effective[permission],
            (on) => {
                setInstallPermission(flatpakId, permission, on)
                    .catch(e => console.error(`[apps] could not set ${permission} for ${flatpakId}:`, e))
            },
            (apply) => {
                const sync = () => {
                    const now = readInstallPermissions(flatpakId)
                    if (now) apply(now.effective[permission])
                }
                sync()
                return watchInstallPermissions(flatpakId, sync)
            },
        ))
    }

    const restore = VeltrixButton({ label: t("settings.apps.restore"), valign: Gtk.Align.CENTER })
    restore.connect("clicked", () => {
        resetInstallPermissions(flatpakId)
            .catch(e => console.error(`[apps] could not restore ${flatpakId}:`, e))
    })
    const restoreRow = VeltrixRow(t("settings.apps.install.restore"), t("settings.apps.install.restore.desc"), restore)
    restoreRow.activatable = false
    const syncRestore = () => {
        const now = readInstallPermissions(flatpakId)
        restore.sensitive = !!now && INSTALL_PERMISSIONS.some(p => now.declared[p] !== now.effective[p])
    }
    bindWhileRealized(restore, () => {
        syncRestore()
        return watchInstallPermissions(flatpakId, syncRestore)
    })
    listBox.append(restoreRow)
    return box
}

// ── Uninstall ─────────────────────────────────────────────────────────────────
// The plan is async (it asks pacman who owns the launcher), so the group starts
// as a "Checking…" row and swaps in the real one once the plan lands. A system
// app the desktop needs gets a disabled row with the reason, never a button
// that fails after a password prompt. On success the caller removes the app's
// row from the list (onUninstalled) — the list itself is built once, so nothing
// here re-reads it.

function uninstallSubtitle(plan: UninstallPlan): string {
    switch (plan.kind) {
        case "pacman": return t("settings.apps.uninstall.subtitle.pacman").replace("%s", plan.target)
        case "flatpak-user":
        case "flatpak-system": return t("settings.apps.uninstall.subtitle.flatpak").replace("%s", plan.target)
        case "desktop-file": return t("settings.apps.uninstall.subtitle.launcher")
        default: return uninstallReason(plan.reason)
    }
}

function uninstallReason(reason?: string): string {
    switch (reason) {
        case "protected": return t("settings.apps.uninstall.protected")
        case "snap": return t("settings.apps.uninstall.snap")
        case "no-owner": return t("settings.apps.uninstall.no-owner")
        case "no-desktop-file": return t("settings.apps.uninstall.no-desktop-file")
        default: return t("settings.apps.uninstall.unsupported")
    }
}

function uninstallConfirmBody(plan: UninstallPlan): string {
    switch (plan.kind) {
        case "pacman": return t("settings.apps.uninstall.confirm.pacman").replace("%s", plan.target)
        case "flatpak-user":
        case "flatpak-system": return t("settings.apps.uninstall.confirm.flatpak").replace("%s", plan.target)
        case "desktop-file": return t("settings.apps.uninstall.confirm.launcher")
        default: return ""
    }
}

function uninstallGroup(app: AppData, onUninstalled?: () => void): Gtk.Widget {
    const { box, listBox } = listGroup(t("settings.apps.uninstall.group"), t("settings.apps.uninstall.footer"))
    let current: Gtk.ListBoxRow | null = null
    const showRow = (row: Gtk.ListBoxRow) => {
        if (current) listBox.remove(current)
        current = row
        listBox.append(row)
    }

    const checking = VeltrixRow(t("settings.apps.uninstall.title"), t("settings.apps.uninstall.checking"))
    checking.activatable = false
    showRow(checking)

    describeUninstall(app).then(plan => {
        if (plan.kind === "unsupported") {
            const row = VeltrixRow(t("settings.apps.uninstall.title"), uninstallReason(plan.reason))
            row.activatable = false
            showRow(row)
            return
        }

        const btn = VeltrixButton({
            label: t("settings.apps.uninstall.button"),
            variant: "danger",
            valign: Gtk.Align.CENTER,
        })
        const row = VeltrixRow(t("settings.apps.uninstall.title"), uninstallSubtitle(plan), btn)
        row.activatable = false
        showRow(row)

        btn.connect("clicked", () => {
            const root = row.get_root()
            showVeltrixAlert({
                parent: root instanceof Gtk.Window && root.visible ? root : null,
                heading: t("settings.apps.uninstall.confirm.heading").replace("%s", app.name),
                body: uninstallConfirmBody(plan),
                responses: [
                    { id: "cancel", label: t("settings.native.cancel") },
                    { id: "uninstall", label: t("settings.apps.uninstall.button"), destructive: true },
                ],
                onResponse: (id) => {
                    if (id !== "uninstall") return
                    btn.sensitive = false
                    const busy = VeltrixRow(t("settings.apps.uninstall.title"), t("settings.apps.uninstall.uninstalling"))
                    busy.activatable = false
                    showRow(busy)
                    uninstallApp(plan).then(res => {
                        if (res.ok) {
                            onUninstalled?.()
                            return
                        }
                        // Back to the button row, and the failure in a dialog —
                        // the tool's own stderr, not an invented reason.
                        showRow(row)
                        btn.sensitive = true
                        const failRoot = row.get_root()
                        showVeltrixAlert({
                            parent: failRoot instanceof Gtk.Window && failRoot.visible ? failRoot : null,
                            heading: t("settings.apps.uninstall.failed.heading"),
                            body: res.message,
                            responses: [{ id: "ok", label: t("settings.apps.uninstall.failed.dismiss"), suggested: true }],
                            onResponse: () => { /* dismiss only */ },
                        })
                    })
                },
            })
        })
    }).catch(e => {
        console.error(`[apps] could not work out how to uninstall ${app.id}:`, e)
        const row = VeltrixRow(t("settings.apps.uninstall.title"), t("settings.apps.uninstall.no-owner"))
        row.activatable = false
        showRow(row)
    })

    return box
}

// ── Per-app detail subpage ──────────────────────────────────────────────────────
// Each app drills into its own subpage (nav.pushSubpage) rather than a modal — more
// room, and a foundation for future per-app settings beyond just the icon. Changes
// apply immediately (no Apply/Cancel step), matching every other Settings row.

export function buildAppIconDetailPage(app: AppData, syncRow: () => void, onUninstalled?: () => void): Gtk.Widget {
    const page = pageBox("app-icon-detail-page")
    // The app's own page: everything that concerns this app lives here (icon today;
    // permissions, notifications and defaults next — see the mockup in #535).
    page.append(appHeader(app))
    const permissions = permissionsGroup(app)
    if (permissions) page.append(permissions)
    const install = installGroup(app)
    if (install) page.append(install)
    const { box, listBox } = listGroup(t("settings.apps.detail.group.icon"))

    // Choose image — the single, primary way to set an icon. The user picks an
    // IMAGE FILE — never an icon-theme name (a prior free-text field was a
    // confusing power-user trap; prior art Windows/GNOME = pick an image).
    // The row shape (preview leading, text, buttons trailing) and the dialog live
    // in `imagePickerRow`; only what the icon IS and what setting one does are here.
    listBox.append(imagePickerRow(
        t("settings.apps.dialog.icon"),
        t("settings.apps.detail.icon.desc"),
        {
            renderPreview: (img) => {
                // Re-reads fresh state the same way the row's syncRow does — app.icon
                // gets canonicalized to the override path once one exists, so re-fetch
                // by id rather than trust the (possibly now-stale) closure value.
                const iconRef = appService.getAppData(app.id)?.icon ?? appService.getCanonicalIconName(app.icon ?? "")
                app.icon = iconRef
                const pb = loadPixbuf(iconRef, 40)
                if (pb) img.set_from_pixbuf(pb)
                else img.icon_name = iconRef ?? "application-x-executable"
            },
            isCustom: () => !!appService.getIconOverridePath(app.icon ?? ""),
            onPick: (path) => {
                if (!appService.setIconOverride(app.icon ?? "", path)) return false
                syncRow()
            },
            onReset: () => { appService.removeIconOverride(app.icon ?? ""); syncRow() },
            resetLabel: t("settings.apps.restore"),
            resetTooltip: t("settings.apps.tooltip.remove-override"),
            // The icon IS the subject of this page, so it gets more room than the
            // 32px app-identity default.
            previewSize: 40,
        },
    ))
    page.append(box)

    // Destructive last: the uninstall group sits under everything else.
    page.append(uninstallGroup(app, onUninstalled))

    return page
}

// ── App row ───────────────────────────────────────────────────────────────────

function buildAppRow(app: AppData, nav: SettingsNav, onUninstalled: (row: Gtk.ListBoxRow) => void): Gtk.ListBoxRow {
    const canonical = appService.getCanonicalIconName(app.icon ?? "")
    const rowIcon = makeIconImage(canonical, 32)

    // Override badge
    const badge = new Gtk.Label({
        label: t("settings.apps.badge.override"),
        css_classes: ["veltrix-row-subtitle", "app-override-badge"],
        visible: !!appService.getIconOverridePath(app.icon ?? ""),
        valign: Gtk.Align.CENTER,
    })

    // Re-reads fresh state (setIconOverride/removeIconOverride call reload()
    // synchronously) and re-syncs the row's icon + badge. Passed to the detail
    // page so apply/restore reflect immediately — the row's own app.icon is a
    // stale canonical snapshot (an override path, deleted on restore), so we
    // re-fetch the freshly re-canonicalized icon from the service by id. (The
    // id subtitle never changes, so it's not touched here.)
    const syncRow = () => {
        const iconRef = appService.getAppData(app.id)?.icon ?? appService.getCanonicalIconName(app.icon ?? "")
        // Sync the closure's app.icon with the freshly re-canonicalized value, so
        // RE-OPENING the picker resolves a live icon rather than a now-deleted
        // override path (which would render as a broken "not found" glyph).
        app.icon = iconRef
        const pb = loadPixbuf(iconRef, 32)
        if (pb) rowIcon.set_from_pixbuf(pb)
        else rowIcon.icon_name = iconRef ?? "application-x-executable"
        badge.visible = !!appService.getIconOverridePath(iconRef ?? "")
    }

    // Each row drills into its own subpage (nav.pushSubpage) — see
    // buildAppIconDetailPage. Decorative chevron mirrors Apps.tsx's navRow; the
    // whole row is the click target since nothing else in it is interactive.
    const chevron = new Gtk.Image({
        gicon: uiIcon("nd-pan-end"), pixel_size: 16,
        opacity: 0.4, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"],
    })

    const trailing = new Gtk.Box({ spacing: 16, valign: Gtk.Align.CENTER })
    trailing.append(badge)
    // Only the isolated apps are marked in the LIST: a column of "Not isolated" on
    // nearly every row is noise, and the app's own page states it either way.
    const isolation = isolationBadge(app, false)
    if (isolation) trailing.append(isolation)
    trailing.append(chevron)

    // VeltrixRow, not createRow: this list is every installed app, rebuilt from the
    // app service — the search index holds settings, not the machine's contents.
    // The `.desktop` id rides as the subtitle, so it now wraps in the column instead
    // of ellipsising at its own natural width.
    const row = VeltrixRow(app.name, app.id, trailing, [], undefined, rowIcon)
    row.set_cursor_from_name("pointer")

    const open = () => nav.pushSubpage({
        id: `apps/icons/${app.id}`,
        title: app.name,
        parentId: "apps/icons",
        build: () => buildAppIconDetailPage(app, syncRow, () => onUninstalled(row)),
    })
    const click = new Gtk.GestureClick()
    click.connect("released", open)
    row.add_controller(click)
    // The same door from outside the list (`openApp` below): the page has to get the
    // row's own `syncRow`, or an icon changed there leaves this row showing the old one.
    ;(row as any)._open = open

    // Tag for filter
    ;(row as any)._appName = app.name.toLowerCase()
    ;(row as any)._appId = app.id.toLowerCase()

    return row
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AppIconsPage(nav: SettingsNav) {
    const page = pageBox("apps-page")

    // NOTE: the search box + scrollable app list below are intentionally duplicated
    // in Autostart.tsx's app picker (same classes, same filter idiom) — the scaffold
    // carries page-specific tuning and hard-won fixes. On a THIRD consumer, extract
    // a shared builder instead of copying again.

    // Search — custom box with our nd-icon magnifier + Gtk.Text. Gtk.SearchEntry
    // would force the icon theme's magnifier glyph; this matches the Settings
    // sidebar search (Settings.tsx) and the rest of the shell.
    const searchInput = new Gtk.Text({
        placeholder_text: t("settings.apps.entry.search"),
        css_classes: ["settings-search-text"],
        hexpand: true,
        valign: Gtk.Align.CENTER,
    })
    const searchEntry = new Gtk.Box({
        css_classes: ["settings-search"],
        spacing: 8,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        margin_bottom: 4,
    })
    searchEntry.append(new Gtk.Image({
        gicon: uiIcon("nd-system-search"),
        pixel_size: 15,
        css_classes: ["nd-icon", "settings-search-icon"],
        valign: Gtk.Align.CENTER,
    }))
    searchEntry.append(searchInput)

    page.append(searchEntry)

    // App list — build the group manually so we can wrap the ListBox in a ScrolledWindow.
    // No title label: the page's own breadcrumb already reads "Installed Apps"
    // (settings.apps.title), so a group header repeating it would be redundant —
    // same call VeltrixList makes when passed an empty title (list.ts).
    const groupBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, css_classes: ["veltrix-list-group"] })

    // No card chrome on the ListBox itself — it SCROLLS, so its rounded top/bottom
    // would scroll out of the viewport (the "cut-off background" bug). The card
    // lives on the fixed ScrolledWindow below (.apps-list-scroll); the list is
    // transparent and just scrolls inside it.
    const appList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ["apps-list"],
    })

    // The LAUNCHABLE apps — the same set the app grid shows (`listApps()`, i.e.
    // g_app_info_should_show), not the whole registry. `getAllApps()` also holds
    // NoDisplay/Hidden entries (a PolicyKit agent, xdg-user-dirs' updater…), which
    // name windows and own icons but are not apps anybody opens, and a page about
    // "the apps on this machine" listing them read as clutter (#535). Same call GNOME
    // Settings makes.
    const apps = appService.listApps()
    const rows = apps.map(app => buildAppRow(app, nav, (row) => {
        // The app is gone: drop its row from the list (and from `rows`, so
        // openApp can't re-open a detail page for it) and go back to the list.
        const idx = rows.indexOf(row)
        if (idx >= 0) rows.splice(idx, 1)
        appList.remove(row)
        nav.goBack()
    }))
    rows.forEach(row => appList.append(row))
    // Open one app's page as a click on its row would — the window menu's "App
    // Settings…" lands here (Settings' `navigateToApp`). False when the app is not
    // in the list (no entry, or one nobody opens), and the list is where you stay.
    ;(page as any).openApp = (appId: string): boolean => {
        const row = rows.find(r => (r as any)._appId === appId.toLowerCase())
        if (!row) return false
        ;(row as any)._open()
        return true
    }

    // Filter
    appList.set_filter_func((row: Gtk.ListBoxRow) => {
        const q = searchInput.text.trim().toLowerCase()
        if (!q) return true
        const r = row as any
        return r._appName?.includes(q) || r._appId?.includes(q)
    })
    searchInput.connect("changed", () => appList.invalidate_filter())

    // VeltrixScrolled reserves the lane itself, so the rows' trailing chevron is never
    // under the bar — that is what `overlay_scrolling: false` used to buy, without
    // the gutter appearing and resizing the list the moment it starts overflowing.
    const { widget: scrollWidget, scrolled: scroll } = VeltrixScrolled({
        child: appList,
        minContentHeight: 400,
        cssClasses: ["apps-list-scroll"],
    })
    scroll.vexpand = true; scrollWidget.vexpand = true
    groupBox.append(scrollWidget)

    page.append(groupBox)

    return page
}
