import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { execAsync } from "../../lib/process"
import { getAnonymityStatus } from "./Anonymity"

// ── The bar's weather (Phase 1 fix, fidelity §1 MUST) ───────────────────────
// The fork's pattern for live values is a small core service fed by the
// system's own source. Weather has no system source, so this service shells
// out — every 15 minutes, fixed argv, no shell — to `bin/veltrix-weather`, a
// tiny Python helper around Open-Meteo (free, no key, documented JSON).
// Same shape as HijriService calling `veltrix-hijri-date`.
//
// TOR MODE PAUSE (v1.0): the fetch sends the machine's coordinates to
// Open-Meteo. In Tor mode that fetch would go through Tor (the IP hidden)
// but the coordinates still go to Open-Meteo — so refresh() skips the
// fetch while `veltrix-anonymity status` says mode=tor, and keeps the last
// good value instead (the staleness rule above still clears it after an
// hour). The bar never leaks a location lookup while the user is anonymous.
// The pause only applies when the module positively reports Tor mode: a
// missing helper or a failed status read means "not Tor", and the weather
// keeps working on a system without the module installed.
//
// The weather is REAL data or nothing: when the helper fails (no network,
// rate limit, bad response — exit 3) the last good value is kept for up to
// an hour and then cleared, so the bar never shows a placeholder
// temperature and never shows a stale one for long either. A failed refresh
// never blanks a fresh value, and the widget hides while there is none.

export interface WeatherData {
    tempC: number
    /** One of: clear, partly-cloudy, cloudy, fog, rain, snow, thunderstorm. */
    condition: string
    isDay: boolean
}

const REFRESH_MS = 15 * 60_000
/** A helper read that never returns is a hung bar, not a slow one. */
const HELPER_TIMEOUT_MS = 15_000
/** A temperature older than this is stale, not weather: clear it. */
const STALE_MS = 60 * 60_000

const CONDITIONS = new Set(["clear", "partly-cloudy", "cloudy", "fog", "rain", "snow", "thunderstorm"])

/** Parse the helper's JSON line. Throws on anything malformed or unusable —
 *  a failed refresh keeps the last good value, it never stores a half-parsed one. */
function parseWeather(out: string): WeatherData {
    let obj: any
    try {
        obj = JSON.parse(out)
    } catch {
        throw new Error(`veltrix-weather printed malformed JSON: ${JSON.stringify(out)}`)
    }
    if (typeof obj.temp_c !== "number" || !CONDITIONS.has(obj.condition)
            || (obj.is_day !== 0 && obj.is_day !== 1)) {
        throw new Error(`veltrix-weather printed unusable data: ${JSON.stringify(out)}`)
    }
    return { tempC: obj.temp_c, condition: obj.condition, isDay: obj.is_day === 1 }
}

class WeatherService extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "WeatherService",
            Signals: { "changed": {} },
        }, this)
    }

    private _weather: WeatherData | null = null
    private _lastGoodAt = 0
    private _available = false
    private _started = false
    private _refreshing = false
    /** A failure has already been logged for the current outage. */
    private _warned = false

    /** The current weather. Null when unknown (or stale — see STALE_MS). */
    get weather(): WeatherData | null { return this._weather }
    /** False until the first successful read — the bar hides the widget while false. */
    get available(): boolean { return this._available }

    /** Idempotent: start the 15-minute timer and read once now. Called by the weather widget. */
    start(): void {
        if (this._started) return
        this._started = true
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
            // Stale, not weather: a temperature older than an hour clears
            // before the new read, so the bar never wears yesterday's sky.
            // This runs BEFORE the Tor check below, so a value that went
            // stale during a long Tor session still clears on time.
            if (this._weather !== null && Date.now() - this._lastGoodAt > STALE_MS) {
                this._weather = null
                this._available = false
                this.emit("changed")
            }
            // Tor mode: do not fetch — the coordinates would go to
            // Open-Meteo even though the IP is hidden. Keep the last good
            // value (or none, if the staleness rule just cleared it). A
            // failed status read is "not Tor" (see the header): the
            // weather keeps working without the module installed.
            try {
                const anon = await getAnonymityStatus()
                if (anon?.mode === "tor") return
            } catch { /* not Tor — carry on */ }
            const out = await execAsync(["veltrix-weather"], { timeoutMs: HELPER_TIMEOUT_MS })
            this._warned = false
            if (!out) return
            const data = parseWeather(out)
            const cur = this._weather
            if (!cur || cur.tempC !== data.tempC || cur.condition !== data.condition
                    || cur.isDay !== data.isDay || !this._available) {
                this._weather = data
                this._lastGoodAt = Date.now()
                this._available = true
                this.emit("changed")
            } else {
                this._lastGoodAt = Date.now()
            }
        } catch (e) {
            // Helper missing or failed: keep the last good value (unless the
            // staleness check above already cleared it), never fake one.
            if (!this._warned) {
                this._warned = true
                console.warn("[WeatherService] veltrix-weather failed (weather unavailable):", e)
            }
        } finally {
            this._refreshing = false
        }
    }
}

export const weatherService = new WeatherService()
export default weatherService
