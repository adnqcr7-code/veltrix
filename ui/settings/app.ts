import { SHELL_ROOT } from "../shell/core/Paths"
import app from "../lib/veltrix-kit/platform/host"
import { useNoGtkTheme } from "../lib/veltrix-kit/platform/gtk-theme"
import { initAppearance } from "../lib/veltrix-kit/platform/appearance-css"
import { withKitSheet } from "../lib/veltrix-kit/platform/kit-css"
import { applyCrispFontRendering } from "../lib/veltrix-kit/platform/font-rendering"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import Settings from "../shell/surfaces/settings/Settings"
import { bindSettingsCursorRefresh } from "../shell/common/CursorRefresh"
import { currentLocale } from "../shell/core/i18n"
import { applyLocaleDirection } from "../lib/rtl"
import { registerConfigEntries } from "../shell/config-entries"
import { setWidgetCatalog } from "../shell/core/WidgetCatalog"
import { createRemoteWidgetCatalog } from "../shell/core/WidgetCatalogRemote"
import queryUI from "../shell/core/UITree"
import compositor from "../shell/core/CompositorState"

useNoGtkTheme()
let window: Gtk.Window | null = null
let initialized: Promise<void>
const raise = () => {
    if (!window) return
    window.present()
    const client = compositor.clients.find(c => c.class === "veltrix-settings" && c.title === "Veltrix Settings")
    if (client) compositor.focusWindow(client.address)
}
const interfaceXml = `<node><interface name="org.veltrix.Settings"><method name="Request">
    <arg type="as" direction="in"/><arg type="s" direction="out"/>
    </method></interface></node>`
app.start({
    applicationId: "org.veltrix.Settings", applicationName: "Veltrix Settings", logDomain: "veltrix-settings",
    // Linux comm is 15 chars (16 bytes incl. NUL): "veltrix-settings" is 16, so
    // setProcessName threw in start() and Settings never opened (1.3, Dell).
    // "masjid-settings" was exactly 15 — the rename broke it. Singular keeps
    // the comm recognisable; the app-id/desktop id stay "veltrix-settings".
    processName: "veltrix-setting",
    css: withKitSheet(`${GLib.getenv("VELTRIX_SETTINGS_ROOT") || SHELL_ROOT}/style.css`),
    activate: () => { void initialized?.then(raise).catch(e => console.error(String(e))) },
    main() {
        // First: the process-wide text direction, from the locale Settings'
        // own i18n layer resolved (shell core/i18n — Settings imports t from
        // it, so currentLocale() is the same answer the pages render in).
        // See ui/lib/rtl.ts.
        applyLocaleDirection(currentLocale())
        applyCrispFontRendering()
        initAppearance()
        registerConfigEntries()
        initialized = (async () => {
            const catalog = await createRemoteWidgetCatalog()
            await catalog.ready
            setWidgetCatalog(catalog)
            window = Settings()
            // The cursor theme/size is applied by the SHELL (`hyprctl setcursor`),
            // but only this process can name a shape on the Settings window — the
            // shell's refresh cannot reach a surface another process owns. Without
            // this, a cursor-size drag repaints nothing while the pointer sits in
            // Settings, and the change reads as dead. See common/CursorRefresh.ts.
            bindSettingsCursorRefresh(window)
            window.connect("close-request", () => { Gio.Settings.sync(); catalog.dispose(); app.quit(); return false })
            window.connect("notify::visible", () => {
                if (window && !window.visible) { Gio.Settings.sync(); catalog.dispose(); app.quit() }
            })
            raise()
        })()
        void initialized.catch(e => { console.error("[Settings] Startup:", String(e)); app.quit(1) })
        const exported = Gio.DBusExportedObject.wrapJSObject(interfaceXml, {
            RequestAsync([args]: [string[]], invocation: Gio.DBusMethodInvocation) {
                void initialized.then(() => {
                    let response = "ok"
                    const win = window as any
                    const [verb, id] = args
                    if (verb === "queryUI") return JSON.stringify(queryUI(id))
                    if (verb === "page") {
                        if (!id || !win.navigateToPage(id)) response = `unknown page: ${id ?? ""} — valid: ${win.pageIds.join(", ")}`
                    } else if (verb === "app") {
                        if (!id) response = "usage: settingsApp <desktop-id>"
                        else if (!win.navigateToApp(id)) response = `no page for app: ${id} — Settings shows the list of apps`
                    } else if (verb !== "open") throw Error("Unknown Settings request")
                    raise()
                    return response
                }).then(text => invocation.return_value(new GLib.Variant("(s)", [text])))
                  .catch(e => invocation.return_value(new GLib.Variant("(s)", [`error: ${e}`])))
            },
        })
        exported.export(Gio.DBus.session, "/org/veltrix/Settings")
    },
})
