import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import { VeltrixRow } from "../../../../lib/veltrix-kit"
import { listGroup, createRow, pageBox, onPageShown, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import { uiIcon } from "../../../core/Icons"
import { SUBPAGE_BUILDERS, subpagesOf } from "../subpages"
import appService, { type AppData } from "../../../core/AppService"
import appFrequency from "../../../core/AppFrequency"
import { makeIconImage } from "./AppIconImage"

// Apps landing — a parent page that drills into the three app-related screens
// (Default Apps, App Icons, Autostart) via subpages, so they share one sidebar
// entry. Note: subpage content isn't in the search index (subpages build lazily);
// the rows below are, so a search for "default apps"/"autostart" still lands here.
//
// It is also the App Manager's front door: the Shortcuts group above the
// subpages is the one-tap way to the apps this machine actually uses.

// ── Shortcuts ─────────────────────────────────────────────────────────────────
// One tap opens the app. The list is the user's own most-used apps first
// (AppFrequency, 14-day half-life — the same scores Prism ranks by), then the
// essentials that are always worth reaching fast: the file manager, the
// browser, and the terminal. Rebuilt on every visit (onPageShown): a fresh
// install has no usage data yet, so the essentials carry the list until the
// frequency scores arrive. Settings itself is never a shortcut — opening a
// second Settings window from inside Settings is not a shortcut to anywhere.

const MAX_SHORTCUTS = 8
const MAX_MOST_USED = 4
const TERMINAL_IDS = ["kitty", "org.gnome.console", "alacritty", "foot", "org.gnome.terminal"]

function collectShortcuts(): AppData[] {
    const apps = appService.listApps()
    const byNorm = new Map<string, AppData>()
    for (const a of apps) byNorm.set(a.id.toLowerCase().replace(/\.desktop$/, ""), a)
    const picked: AppData[] = []
    const push = (a?: AppData | null) => {
        if (!a || a.id.toLowerCase() === "veltrix-settings") return
        if (picked.some(p => p.id === a.id)) return
        picked.push(a)
    }

    // Most-used first.
    const freq = [...appFrequency.getFrequencies().entries()].sort((x, y) => y[1] - x[1])
    for (const [normId] of freq) {
        if (picked.length >= MAX_MOST_USED) break
        push(byNorm.get(normId))
    }

    // Essentials: the defaults, so the list is right even with no usage data.
    const defaultFor = (type: string): AppData | null => {
        try {
            const id = Gio.AppInfo.get_default_for_type(type, false)?.get_id() ?? ""
            return byNorm.get(id.toLowerCase().replace(/\.desktop$/, "")) ?? null
        } catch {
            return null
        }
    }
    push(defaultFor("inode/directory"))
    push(defaultFor("text/html"))
    for (const termId of TERMINAL_IDS) {
        const term = byNorm.get(termId)
        if (term) { push(term); break }
    }

    return picked.slice(0, MAX_SHORTCUTS)
}

function shortcutRow(app: AppData): Gtk.ListBoxRow {
    const icon = makeIconImage(appService.getCanonicalIconName(app.icon ?? ""), 32)
    // No chevron: a shortcut OPENS the app, it does not drill anywhere — the
    // whole row is the tap target.
    const row = VeltrixRow(app.name, app.id, undefined, [], undefined, icon)
    row.set_cursor_from_name("pointer")
    const click = new Gtk.GestureClick()
    click.connect("released", () => {
        appService.getResolvedApp(app.id)?.launch()
    })
    row.add_controller(click)
    return row
}

function navRow(
    nav: SettingsNav,
    label: string,
    subtitle: string,
    sub: { id: string; build: () => Gtk.Widget },
): Gtk.ListBoxRow {
    const chevron = new Gtk.Image({
        gicon: uiIcon("nd-pan-end"), pixel_size: 16,
        opacity: 0.4, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"],
    })
    const row = createRow(label, subtitle, chevron)
    row.set_cursor_from_name("pointer")

    const click = new Gtk.GestureClick()
    click.connect("released", () => {
        nav.pushSubpage({ id: sub.id, title: label, parentId: "apps", build: sub.build })
    })
    row.add_controller(click)
    return row
}

export default function AppsPage(nav: SettingsNav) {
    const page = pageBox("apps-page")

    // Shortcuts first: the fastest way back to what this machine uses most.
    // Hidden when empty (a bare system with no file manager, browser or
    // terminal and no launches yet) rather than showing an empty card.
    const { box: scBox, listBox: scList } = listGroup(
        t("settings.apps.shortcuts.group"),
        t("settings.apps.shortcuts.footer"),
    )
    const refreshShortcuts = () => {
        let child = scList.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            scList.remove(child)
            child = next
        }
        const shortcuts = collectShortcuts()
        for (const app of shortcuts) scList.append(shortcutRow(app))
        scBox.visible = shortcuts.length > 0
    }
    onPageShown(refreshShortcuts)
    page.append(scBox)

    const { box, listBox } = listGroup("")

    // The three rows come from the manifest, in its order: id, title and subtitle
    // are declared once and read here, rather than being written out again beside
    // the builder. A subpage that is added to the manifest appears here; one whose
    // `builder` has no entry in SUBPAGE_BUILDERS does not compile.
    for (const sub of subpagesOf("apps")) {
        const build = SUBPAGE_BUILDERS[sub.builder as keyof typeof SUBPAGE_BUILDERS]
        if (!build) continue
        listBox.append(navRow(
            nav,
            t(sub.label as any),
            t((sub.subtitle ?? "") as any),
            { id: sub.id, build: () => build(nav) },
        ))
    }

    page.append(box)
    return page
}
