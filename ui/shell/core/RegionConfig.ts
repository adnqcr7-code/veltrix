import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { readFile, writeFile } from "../../lib/veltrix-kit/platform/file"
import { execAsync } from "../../lib/process"
import { formatDatePart, foldEasternDigits } from "../../lib/date-names"
import { defineSettings } from "./configFile"

export type TimeFormat = "24h" | "12h"
export type DateFormat = "none" | "short" | "short-year" | "long" | "numeric" | "iso"

export interface RegionSettings {
    timeFormat: TimeFormat
    dateFormat: DateFormat
    timezone: string
    showSeconds: boolean
    regionalLocale: string  // e.g. "es_ES.UTF-8"; "" = same as LANG
}

// Path where Veltrix writes user-level LC_* overrides, picked up by systemd/PAM on login
const LOCALE_ENV_PATH = `${GLib.get_user_config_dir()}/environment.d/veltrix-locale.conf`

// Variables that represent "regional format" (not UI language)
const REGIONAL_LC_VARS = [
    "LC_TIME", "LC_NUMERIC", "LC_MONETARY",
    "LC_PAPER", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT",
]

// ── Where each of these lives (#573) ─────────────────────────────────────────
// Only the four clock preferences are STORED, in GSettings `org.veltrix.region`.
// The other two fields of RegionSettings each had a home before region.json copied
// them, and a copy is a second answer that can disagree:
//  - timezone → the SYSTEM's (/etc/localtime, set with timedatectl), read live;
//  - regionalLocale → ~/.config/environment.d/veltrix-locale.conf, the file systemd
//    reads at login, which is what actually decides the regional format.
// region.json was imported once by migrations/2026-09-14d-widgets-pinned-region.sh.
//
// `dateFormat` defaults to "short" (owner, 2026-09-28; it was "long", what veltrix-setup
// used to seed). It is the BAR's date only: the lock screen and the greeter always
// show the long one (ui/lib/clock.ts): a lock screen keeps its own clock.
//
// `timeFormat` defaults to "12h" (Phase 1, macOS-style: macOS shows "6:44 PM",
// no leading zero — see formatClock). A person who explicitly chose 24h keeps
// it: the schema default only decides what a fresh install reads.
//
// `hijriOffset` (Phase 1) is the moon-sighting adjustment for the bar's Hijri
// date, −1 / 0 / +1 day: Umm al-Qura is calculated, and a real month can start
// a day earlier or later than the table says (ARCHITECTURE.md §5 I2).
const DATE_FORMATS: readonly DateFormat[] = ["none", "short", "short-year", "long", "numeric", "iso"]
const clock = defineSettings<{ timeFormat: TimeFormat; dateFormat: DateFormat; showSeconds: boolean; hijriOffset: number }>("region", {
    timeFormat: "12h",
    dateFormat: "short",
    showSeconds: false,
    hijriOffset: 0,
}, {
    timeFormat: v => v === "24h" || v === "12h",
    dateFormat: v => DATE_FORMATS.includes(v),
    hijriOffset: v => Number.isInteger(v) && v >= -1 && v <= 1,
})

class RegionConfigManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "RegionConfigManager",
            Signals: { "changed": {} },
        }, this)
    }

    private _regionalLocale = ""

    constructor() {
        super()
        this._regionalLocale = this._readRegionalLocaleFromFile()
        // A change from any process — Settings, or `gsettings set` — restyles the clock.
        // The greeter's copy of it is written by the shell alone, core/RegionSync.ts (#571).
        clock.subscribeAll(() => this.emit("changed"))
    }

    /** Reads LC_TIME from the environment.d file to detect the saved regional locale. */
    private _readRegionalLocaleFromFile(): string {
        try {
            if (!GLib.file_test(LOCALE_ENV_PATH, GLib.FileTest.EXISTS)) return ""
            const content = readFile(LOCALE_ENV_PATH)
            for (const line of content.split("\n")) {
                const m = line.match(/^LC_TIME=(.+)$/)
                if (m) return m[1].trim()
            }
        } catch {}
        return ""
    }

    /**
     * Reads the active timezone from /etc/localtime symlink.
     * Returns empty string if undetectable.
     */
    detectTimezone(): string {
        try {
            const link = GLib.file_read_link("/etc/localtime")
            const match = link?.match(/zoneinfo\/(.+)$/)
            return match ? match[1] : ""
        } catch {}
        return ""
    }

    get timeFormat(): TimeFormat      { return clock.get("timeFormat") }
    get dateFormat(): DateFormat      { return clock.get("dateFormat") }
    get hijriOffset(): number         { return clock.get("hijriOffset") }
    get timezone(): string            { return this.detectTimezone() }
    get showSeconds(): boolean        { return clock.get("showSeconds") }
    get regionalLocale(): string      { return this._regionalLocale }

    /**
     * Writes all REGIONAL_LC_VARS to ~/.config/environment.d/veltrix-locale.conf.
     * Pass "" to remove the file (LC_* fall back to LANG).
     * Takes effect on next login (systemd/PAM reads environment.d).
     */
    setRegionalLocale(locale: string) {
        // The unchanged-guard every sibling setter here has, and the only one that
        // was missing it — which mattered more here than anywhere else, because
        // this setter does not just save: it rewrites (or DELETES) a file the
        // systemd user manager reads at login.
        if (this._regionalLocale === locale) return
        this._regionalLocale = locale
        try {
            const dir = `${GLib.get_user_config_dir()}/environment.d`
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(dir, 0o755)
            if (!locale) {
                if (GLib.file_test(LOCALE_ENV_PATH, GLib.FileTest.EXISTS))
                    GLib.unlink(LOCALE_ENV_PATH)
            } else {
                const content = REGIONAL_LC_VARS.map(v => `${v}=${locale}`).join("\n") + "\n"
                writeFile(LOCALE_ENV_PATH, content)
            }
        } catch (e) {
            console.error("[RegionConfig] Failed to write locale env:", e)
        }
        this.emit("changed")
    }

    // The store notifies synchronously, and the subscription in the constructor
    // emits "changed" — so a setter only writes.
    setTimeFormat(v: TimeFormat)  { clock.set("timeFormat", v) }
    setDateFormat(v: DateFormat)  { clock.set("dateFormat", v) }
    setShowSeconds(v: boolean)    { clock.set("showSeconds", v) }
    setHijriOffset(v: number)     { if (!Number.isFinite(v)) return; clock.set("hijriOffset", Math.max(-1, Math.min(1, Math.round(v)))) }

    setTimezone(tz: string) {
        if (!tz || this.timezone === tz) return
        // The system's timezone IS the setting — requires polkit / sudo or
        // user-level timedatectl. Nothing to store: the getter reads it back.
        execAsync(["timedatectl", "set-timezone", tz])
            .then(() => this.emit("changed"))
            .catch(e => console.error("[RegionConfig] Failed to set timezone:", e))
    }

    /**
     * Returns a fully formatted clock string. The date portion (names + field
     * order) follows the system regional format — LC_TIME via ui/lib/date-names.ts,
     * like Gtk.Calendar — not the in-app UI language.
     *
     * 12-hour time is macOS-style: "6:44 PM", no leading zero on the hour.
     * GLib's %I zero-pads ("06:44 PM"), so the leading zero is stripped here
     * (Phase 1). 24-hour time keeps its zero ("06:44"), as macOS does in 24h.
     * The date is macOS-shaped too: no comma after the weekday, one space
     * between date and time ("Wed Sep 27 6:44 PM", Phase 1 fix). The FIELD
     * ORDER still follows the system regional format (day-first locales read
     * "Thu 12 Nov 6:44 PM") — macOS follows the region's order too; only the
     * comma and the double space were the bug, never the order.
     */
    formatClock(dt?: GLib.DateTime): string {
        const now = dt ?? GLib.DateTime.new_now_local()
        const sec = this.showSeconds ? ":%S" : ""
        const timeFmt = this.timeFormat === "12h" ? `%I:%M${sec} %p` : `%H:%M${sec}`
        let time = now.format(timeFmt) ?? ""
        if (this.timeFormat === "12h") time = time.replace(/^0/, "")
        if (this.dateFormat === "none") return foldEasternDigits(time)
        return foldEasternDigits(`${formatDatePart(this.dateFormat, now)} ${time}`)
    }

    /** @deprecated Use formatClock() — returns locale-independent output */
    getClockFormat(): string {
        const sec = this.showSeconds ? ":%S" : ""
        const timePart = this.timeFormat === "12h" ? `%I:%M${sec} %p` : `%H:%M${sec}`
        switch (this.dateFormat) {
            case "none":       return timePart
            case "short-year": return `%a %d %b %Y  ${timePart}`
            case "long":       return `%A, %d %b  ${timePart}`
            case "numeric":    return `%d/%m/%Y  ${timePart}`
            case "iso":        return `%Y-%m-%d  ${timePart}`
            default:           return `%a %d %b  ${timePart}`
        }
    }
}

export const regionConfig = new RegionConfigManager()
export default regionConfig
