// Interface mode — which desktop the user sees.
//
// The macOS desktop is the default and stays exactly as it is. iPad Mode is
// the opt-in alternative (Settings → Interface, or the installer's "Choose
// your interface" screen): the whole screen becomes an iPad-style home
// screen — the macOS bar on top, the macOS dock at the bottom, a big app
// grid with widgets in the middle — still a computer with a mouse and a
// keyboard, no phone frame. (Adnan, 2026-11-12; corrected 18:51 the same
// day from a phone frame to the whole-screen iPad home screen.)
//
// 🔑 This bit is the ONLY home of the mode, same shape as NotifConfig's
// doNotDisturb and SafetyConfig's contentFilter: the Settings toggle, the
// installer seed and the agent key `interface.ipadMode` are three faces of
// this one bit. The shell reads it live (Bar subscribes), so flipping it
// switches the home screen at once — no logout, no reload.
//
// Stored in GSettings `org.veltrix.interface`, default false (macOS).
// A schema that is not installed gives a store that works in memory and
// persists nothing (see core/configFile.ts) — the mode then lasts until
// the shell restarts, and the Settings toggle still works for the session.

import { defineSettings } from "./configFile"

interface InterfaceSettings {
    /** Show the iPad-style home screen instead of the macOS desktop. */
    ipadMode: boolean // default false
}

const DEFAULTS: InterfaceSettings = {
    ipadMode: false,
}

const config = defineSettings("interface", DEFAULTS)

export const interfaceConfig = {
    get ipadMode() { return config.get("ipadMode") },

    setIpadMode(on: boolean): void {
        config.set("ipadMode", on)
    },

    onChange(fn: (key: keyof InterfaceSettings) => void): () => void {
        return config.subscribeAll(fn)
    },

    subscribe<K extends keyof InterfaceSettings>(key: K, cb: (v: InterfaceSettings[K]) => void): () => void {
        return config.subscribe(key, cb)
    },
}

export default interfaceConfig
