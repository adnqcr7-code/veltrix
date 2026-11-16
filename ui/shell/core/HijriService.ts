import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { execAsync } from "../../lib/process"
import regionConfig from "./RegionConfig"

// ── The bar's Hijri date (Phase 1, ARCHITECTURE.md §5 I2) ───────────────────
// The fork's pattern for live values is a small core service fed by the
// system's own source: the clock reads GLib.DateTime, the tray reads
// NetworkManager/UPower over D-Bus. The Hijri calendar has no such system
// source, so this service shells out — once a minute, fixed argv, no shell —
// to `bin/veltrix-hijri-date`, a tiny Python helper around `hijridate` (PyPI,
// MIT, zero dependencies, fully offline Umm al-Qura table). Same shape as
// RegionConfig calling `timedatectl` / `localectl` via execAsync.
//
// The date is REAL data or nothing: when the helper is missing (hijridate
// not installed — exit 3) or fails, `hijri` stays null and the bar shows the
// Gregorian clock only. A failed refresh never blanks a good date either —
// the date only changes at midnight, so the last good value is kept and the
// next minute retries. Nothing here invents a date.
//
// The ±1-day moon-sighting offset (regionConfig.hijriOffset, GSettings
// org.veltrix.region `hijri-offset`, set in Settings → Top bar → Clock →
// Configure) is passed on every call, so a change re-reads immediately via
// the region "changed" signal — no restart, no waiting for the minute tick.

const REFRESH_MS = 60_000
/** A helper read that never returns is a hung bar, not a slow one. */
const HELPER_TIMEOUT_MS = 10_000

/** Arabic month names (Umm al-Qura), keyed by hijridate's exact English
 *  `month_name()` output — verified live 2026-11-12 (note the apostrophes:
 *  "Rabi' al-Awwal", "Sha'ban" — and "Dhu al-…", not "Dhul-…"). A key that
 *  does not match here means the Arabic date is simply absent, never wrong. */
const ARABIC_MONTHS: Record<string, string> = {
    "Muharram": "محرم",
    "Safar": "صفر",
    "Rabi' al-Awwal": "ربيع الأول",
    "Rabi' al-Thani": "ربيع الآخر",
    "Jumada al-Ula": "جمادى الأولى",
    "Jumada al-Akhirah": "جمادى الآخرة",
    "Rajab": "رجب",
    "Sha'ban": "شعبان",
    "Ramadan": "رمضان",
    "Shawwal": "شوال",
    "Dhu al-Qa'dah": "ذو القعدة",
    "Dhu al-Hijjah": "ذو الحجة",
}

/** The shifted Gregorian day (today + the moon-sighting offset) as YYYY-MM-DD
 *  — the day the stored Hijri date belongs to. The same shift the helper
 *  applies before converting, so the two agree across a month boundary. */
function shiftedToday(): string {
    const now = GLib.DateTime.new_now_local()
    const shifted = now.add_days(regionConfig.hijriOffset) ?? now
    return shifted.format("%Y-%m-%d") ?? ""
}

/**
 * Split the helper's "D Month Y" line into the English date and its
 * Arabic-month twin. Throws on malformed output — a failed refresh keeps the
 * last good date, it never stores a half-parsed one.
 */
function parseHijri(out: string): { en: string, ar: string | null } {
    const parts = out.trim().split(/\s+/)
    if (parts.length < 3) throw new Error(`veltrix-hijri-date printed malformed output: ${JSON.stringify(out)}`)
    const day = parts[0], year = parts[parts.length - 1]
    if (!/^\d+$/.test(day) || !/^\d+$/.test(year)) throw new Error(`veltrix-hijri-date printed malformed output: ${JSON.stringify(out)}`)
    const monthAr = ARABIC_MONTHS[parts.slice(1, -1).join(" ")]
    return { en: out.trim(), ar: monthAr ? `${day} ${monthAr} ${year}` : null }
}

class HijriService extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "HijriService",
            Signals: { "changed": {} },
        }, this)
    }

    private _hijri: string | null = null
    private _hijriArabic: string | null = null
    /** The shifted Gregorian day the stored date was read for — the rollover check. */
    private _readDay: string | null = null
    private _available = false
    private _started = false
    private _refreshing = false
    /** A failure has already been logged for the current outage. */
    private _warned = false

    /** The Hijri date as printed by the helper, e.g. "2 Jumada al-Akhirah 1448". Null when unknown. */
    get hijri(): string | null { return this._hijri }
    /** The same date with the Arabic month name, e.g. "2 جمادى الآخرة 1448". Null when unknown. */
    get hijriArabic(): string | null { return this._hijriArabic }
    /** False until the first successful read — the bar hides the label while false. */
    get available(): boolean { return this._available }

    /** Idempotent: start the minute timer and read once now. Called by Bar. */
    start(): void {
        if (this._started) return
        this._started = true
        regionConfig.connect("changed", () => void this.refresh())
        void this.refresh()
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
            void this.refresh()
            return GLib.SOURCE_CONTINUE
        })
    }

    async refresh(): Promise<void> {
        if (this._refreshing) return
        this._refreshing = true
        try {
            // Expire on day rollover (Phase 1 fix, halal M3): the date only
            // changes at midnight, and the minute refresh re-reads it — but if
            // that read fails, yesterday's date must not keep showing. A new
            // day clears the stored value BEFORE the helper runs, so the bar
            // shows the Gregorian clock only until a fresh read lands.
            const today = shiftedToday()
            if (this._readDay !== null && this._readDay !== today && this._hijri !== null) {
                this._hijri = null
                this._hijriArabic = null
                this._available = false
                this.emit("changed")
            }
            const out = await execAsync(["veltrix-hijri-date", "--offset", String(regionConfig.hijriOffset)], { timeoutMs: HELPER_TIMEOUT_MS })
            this._warned = false
            if (!out) return
            const parsed = parseHijri(out)
            if (parsed.en !== this._hijri || !this._available) {
                this._hijri = parsed.en
                this._hijriArabic = parsed.ar
                this._available = true
                this._readDay = today
                this.emit("changed")
            }
        } catch (e) {
            // Helper missing, timed out or failed: keep the last good date
            // (unless the rollover above already cleared it), never fake one.
            // Only the never-had-a-date state changes what the bar shows.
            if (!this._warned) {
                this._warned = true
                console.warn("[HijriService] veltrix-hijri-date failed (Hijri date unavailable):", e)
            }
        } finally {
            this._refreshing = false
        }
    }
}

export const hijriService = new HijriService()
export default hijriService
