import Gtk from "gi://Gtk?version=4.0"
import { BAR_ICON_SIZE, BAR_ITEM_PAD, AtomicWidget, ContentBudget, WidgetSize } from "../common/widget-kit"
import { t } from "../core/i18n"
import { uiIcon } from "../core/Icons"
import { safeDisconnect } from "../core/signals"
import weatherService, { type WeatherData } from "../core/WeatherService"

// ── Weather in the menu bar (Phase 1 fix, fidelity §1 MUST) ────────────────
// macOS shows the weather in the menu bar (temperature + condition); the fork
// had no weather widget at all. This one is icon + temperature only in the
// bar — no text label like "22° Sunny" — with the condition in the tooltip
// and a small expanded panel (condition, temperature, place, source).
//
// It is a PRESENCE indicator (contract.ts `barActive`): it exists while there
// is weather to show, and hides itself while there is none — no network, no
// rate limit, stale data. It is never a placeholder temperature. The data
// comes from WeatherService (Open-Meteo via bin/veltrix-weather, London, ON,
// Celsius); the widget owns no fetching and no location. A Settings location
// picker is a later phase (Phase 6).

/** (condition, day?) → the `nd-weather-*` icon. Night has its own clear and
 *  partly icons (a sun at night is wrong); the rest are the same sky. */
function iconFor(w: WeatherData) {
    switch (w.condition) {
        case "clear":         return uiIcon(w.isDay ? "nd-weather-clear-day" : "nd-weather-clear-night")
        case "partly-cloudy": return uiIcon(w.isDay ? "nd-weather-partly-day" : "nd-weather-partly-night")
        case "cloudy":        return uiIcon("nd-weather-cloudy")
        case "fog":           return uiIcon("nd-weather-fog")
        case "rain":          return uiIcon("nd-weather-rain")
        case "snow":          return uiIcon("nd-weather-snow")
        case "thunderstorm":  return uiIcon("nd-weather-storm")
        default:              return uiIcon("nd-weather-cloudy")
    }
}

/** The condition's translated name. Static keys (not a template) so every
 *  `widget.weather.*` string is greppable from its use. */
function conditionName(condition: string): string {
    switch (condition) {
        case "clear":         return t("widget.weather.clear")
        case "partly-cloudy": return t("widget.weather.partly-cloudy")
        case "cloudy":        return t("widget.weather.cloudy")
        case "fog":           return t("widget.weather.fog")
        case "rain":          return t("widget.weather.rain")
        case "snow":          return t("widget.weather.snow")
        case "thunderstorm":  return t("widget.weather.thunderstorm")
        default:              return t("widget.weather.cloudy")
    }
}
const tempText = (tempC: number) => `${Math.round(tempC)}°`

function buildBarContent(): Gtk.Widget {
    const box = new Gtk.Box({ spacing: 4, margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD })
    const image = new Gtk.Image({ pixel_size: BAR_ICON_SIZE, css_classes: ["nd-icon"] })
    const temp = new Gtk.Label({ label: "", css_classes: ["bar-weather-temp"] })
    box.append(image)
    box.append(temp)
    // Hidden until the first REAL read — no data, no pill (the barActive
    // presence rule below is the same state; the box hides first so a
    // rebuild never flashes an empty pill).
    box.visible = false
    const sync = () => {
        const w = weatherService.weather
        box.visible = w !== null
        if (w) {
            const icon = iconFor(w)
            if (image.gicon !== icon) image.gicon = icon
            const next = tempText(w.tempC)
            if (temp.label !== next) temp.label = next
        }
    }
    sync()
    const id = weatherService.connect("changed", sync)
    box.connect("unrealize", () => safeDisconnect(weatherService, id))
    weatherService.start()
    return box
}

function buildContent(size: WidgetSize, _budget: ContentBudget): Gtk.Widget {
    // The widget lives in the bar only (locations ["bar"]) — this is the
    // catalog/Settings preview, the same icon + temperature as the bar.
    const box = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
    const image = new Gtk.Image({ pixel_size: BAR_ICON_SIZE, css_classes: ["nd-icon"] })
    const temp = new Gtk.Label({ label: "", css_classes: ["bar-weather-temp"] })
    box.append(image)
    box.append(temp)
    const sync = () => {
        const w = weatherService.weather
        if (w) {
            const icon = iconFor(w)
            if (image.gicon !== icon) image.gicon = icon
            const next = tempText(w.tempC)
            if (temp.label !== next) temp.label = next
        }
    }
    sync()
    const id = weatherService.connect("changed", sync)
    box.connect("unrealize", () => safeDisconnect(weatherService, id))
    weatherService.start()
    return box
}

function buildBarExpanded(_onClose: () => void): Gtk.Widget {
    const w = weatherService.weather
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 14, margin_end: 14, margin_top: 10, margin_bottom: 10 })
    if (!w) {
        // The pill only shows while there is data, so this is a race (the
        // data cleared between the click and the open) — say so, don't fake it.
        box.append(new Gtk.Label({ label: t("widget.weather.unavailable"), css_classes: ["veltrix-row-subtitle"], halign: Gtk.Align.START }))
        return box
    }
    const temp = new Gtk.Label({ label: tempText(w.tempC), css_classes: ["bar-weather-temp-large"], halign: Gtk.Align.START })
    const cond = new Gtk.Label({ label: conditionName(w.condition), css_classes: ["veltrix-menu-label"], halign: Gtk.Align.START })
    const src = new Gtk.Label({ label: "London, ON · Open-Meteo", css_classes: ["veltrix-row-subtitle"], halign: Gtk.Align.START })
    box.append(temp)
    box.append(cond)
    box.append(src)
    return box
}

const weatherWidget: AtomicWidget = {
    id: "weather",
    category: "system",
    // Near the right end, after Wi-Fi (80): weather sits next to the clock,
    // the way macOS puts it beside the date.
    barOrder: 85,
    name: t("widget.weather.name"),
    icon: uiIcon("nd-weather-cloudy"),
    locations: ["bar"],
    defaultInBar: true,
    // Presence, not hardware: show the pill only while there is weather to
    // show (contract.ts `barActive` alone — no choice to offer, the CC is
    // not where weather is turned on; the pill itself is the indicator).
    barActive: () => weatherService.available,
    watchBarActive: (cb) => {
        const id = weatherService.connect("changed", cb)
        return () => safeDisconnect(weatherService, id)
    },
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE],
    buildContent,
    buildBarContent,
    barTooltipState: () => {
        const w = weatherService.weather
        return w ? `${conditionName(w.condition)} · ${tempText(w.tempC)}` : null
    },
    buildBarExpanded,
}

export default weatherWidget
