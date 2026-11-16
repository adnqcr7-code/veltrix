import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { callConn } from "./dbus"

// Set by bin/veltrix-settings BEFORE GJS imports any service; stripped from children.
export const isSettingsProcess = GLib.getenv("VELTRIX_SETTINGS_PROCESS") === "1"

/** No activation or replay: these actions need the current live shell. */
export async function settingsShellRequest(args: string[]): Promise<string> {
    const result = await callConn(Gio.DBus.session, "org.veltrix.Shell", "/org/veltrix/Shell",
        "org.veltrix.Shell", "Request", new GLib.Variant("(as)", [args]),
        new GLib.VariantType("(s)"), Gio.DBusCallFlags.NO_AUTO_START, 5000)
    const [text] = result.deep_unpack() as [string]
    if (text.startsWith("error:")) throw Error(text.slice(6).trim())
    return text
}
