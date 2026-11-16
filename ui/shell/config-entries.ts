// Registers the agent-facing config surface (core/ConfigRegistry) against the
// real services. Lives at the app level — NOT in core/ — because some settings
// (dock) are owned by widget-layer state; core must never import widget code.
// Called once from app.ts main().
//
// Adding a setting here is ALL it takes for agents to see it in
// `describeConfig` and use it via `getConfig`/`setConfig`. Keep descriptions
// real — they are the documentation agents read. First wave is a representative
// subset; grow it opportunistically as services gain setters.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Pango from "gi://Pango"
import PangoCairo from "gi://PangoCairo"
import { getBundledWallpapers } from "../lib/wallpaper"
import { registerConfig, type ConfigResult } from "./core/ConfigRegistry"
import { AGENT_PROVIDERS } from "./core/AgentProviders"
import Theme, { TEXT_SCALE_MIN, TEXT_SCALE_MAX } from "./core/ThemeManager"
import { ACCENT_PALETTE, type WindowBackground } from "./core/VeltrixTheme"
import NightLight from "./core/NightLightManager"
import Wallpaper, { TRANSITION_LABELS, TRANSITIONS, ROTATION_LABELS, ROTATIONS, type TransitionType, type RotationType } from "./core/WallpaperManager"
import notifConfig from "./core/NotifConfig"
import safetyConfig from "./core/SafetyConfig"
import { halalAudioConfig } from "./core/HalalAudioConfig"
const dontDisturb = () => notifConfig.doNotDisturb
const setDontDisturb = (on: boolean) => notifConfig.setDoNotDisturb(on)
import { reduceMotion, setReduceMotion, onReduceMotionChange } from "./core/ReduceMotion"
import recordingConfig, {
    FORMATS, QUALITIES, type RecordFormat, type RecordQuality,
} from "./core/RecordingConfig"
import agentConfig from "./core/AgentConfig"
import { dockSettings, updateDockSettings, onDockSettingChanged, type DockPosition } from "./surfaces/dock/state"
import { barConfig } from "./surfaces/bar/barState"
import regionConfig, { type DateFormat, type TimeFormat } from "./core/RegionConfig"
import { getIdleConfig, updateIdleConfig, onIdleChanged } from "./core/PowerConfig"
import autoSleepConfig, { AUTO_SLEEP_TIMEOUTS } from "./core/AutoSleep"
import { settings as compositorSettings } from "./core/CompositorState"
import { readWindowButtons, setWindowButtonsSide, onWindowButtonsChanged } from "./core/WindowButtons"
import inputConfig from "./core/InputConfig"
import { allKeyboards, keyboardById, keyboardId, parseKeyboardId } from "../lib/keyboards"
import { uiIcon, interfaceIconTheme, setInterfaceIconTheme, onInterfaceIconThemeChange, specIconThemes } from "./core/Icons"
import interfaceConfig from "./core/InterfaceMode"
import { safeDisconnect } from "./core/signals"
import { t } from "./core/i18n"
import workspaceModes, {
    WORKSPACE_MODES,
    WORKSPACE_OVERRIDE_MODES,
    type WorkspaceMode,
    type WorkspaceOverrideMode,
} from "./core/WorkspaceModes"

// ── Keyboards ────────────────────────────────────────────────────────────────
// The list used to live here: 28 rows typed out by hand, two of them variants.
// The installer derived its own from the system and the two never met, so
// installing with any of the other 36 left this row showing a raw code (#473).
// Both surfaces now read `ui/lib/keyboards.ts`. Settings takes the WHOLE
// catalogue — it writes the compositor's layout and nothing else, so unlike the
// installer it has no console keymap to be honest about and no reason to
// withhold a keyboard.

/**
 * The id of whatever the compositor currently holds — derived, not looked up.
 *
 * 🔑 It does not have to be IN the catalogue. `kb_layout` accepts things no list
 * offers ("es,us"), and the kit adds an unknown value to the dropdown rather than
 * rounding it down to item 0 (`ui/lib/veltrix-kit/rows.ts`), so the row keeps
 * saying what is actually in force.
 */
const currentKbLayoutId = (): string => keyboardId(inputConfig.kbLayout, inputConfig.kbVariant)

const kbLayoutLabel = (id: string): string => keyboardById(id)?.label ?? id

function brainProviderLabel(id: string): string {
    // VELTRIX: Ollama (local) is the only provider. Anything else stored in
    // a pre-fork config reads as its raw id, never as a hosted brand.
    if (!id) return t("settings.ai.brain.provider.off")
    if (id === "ollama") return t("settings.ai.brain.provider.ollama")
    return id
}

const powerScreenOffLabel = (s: string): string => {
    if (s === "0") return t("settings.power.opt.never")
    const mins = Math.round(Number(s) / 60)
    return `${mins} ${t("settings.power.time.min")}`
}

const powerLockLabel = (s: string): string => {
    if (s === "0") return t("settings.power.opt.never")
    const secs = Number(s)
    if (secs < 3600) {
        return `${Math.round(secs / 60)} ${t("settings.power.time.min")}`
    }
    const hours = Math.round(secs / 3600)
    return `${hours} ${hours === 1 ? t("settings.power.time.hour") : t("settings.power.time.hours")}`
}

const powerSuspendLabel = (s: string): string => {
    if (s === "0") return t("settings.power.opt.never")
    const secs = Number(s)
    if (secs < 3600) {
        return `${Math.round(secs / 60)} ${t("settings.power.time.min")}`
    }
    const hours = Math.round(secs / 3600)
    return `${hours} ${hours === 1 ? t("settings.power.time.hour") : t("settings.power.time.hours")}`
}

const onInputCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    const id = inputConfig.connect("changed", () => apply(read()))
    return () => safeDisconnect(inputConfig, id)
}

const onThemeCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    const id = Theme.connect("changed", () => apply(read()))
    return () => safeDisconnect(Theme, id)
}

const onWallpaperCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    const id = Wallpaper.connect("changed", () => apply(read()))
    return () => safeDisconnect(Wallpaper, id)
}

const onAiCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    return agentConfig.onChange(() => apply(read()))
}

const onPowerCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    return onIdleChanged(() => apply(read()))
}

// The picker's own types (custom/appearance.ts) — what awww is asked to show.
const WALLPAPER_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]

function validWallpaper(raw: string): ConfigResult {
    let path = raw.trim()
    if (path.startsWith("file://")) {
        try { path = GLib.filename_from_uri(path)[0] } catch { return { ok: false, error: `not a local file URI: ${raw}` } }
    }
    if (!GLib.path_is_absolute(path)) return { ok: false, error: `expected an absolute path, got: ${raw}` }
    if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR)) return { ok: false, error: `no such file: ${path}` }
    const [type] = Gio.content_type_guess(path, null)
    const mime = Gio.content_type_get_mime_type(type) ?? type
    if (!WALLPAPER_TYPES.includes(mime)) return { ok: false, error: `not a JPEG/PNG/GIF/WebP/AVIF image (${mime}): ${path}` }
    return { ok: true, value: path }
}

let fontFamilies: Set<string> | null = null
/** "Family [Style] Size": the size a positive number, the family one the system has. The
 *  family list is read once per shell — a font installed meanwhile needs a reload, as GTK's
 *  own chooser does. */
function validFont(raw: string): ConfigResult {
    const desc = Pango.FontDescription.from_string(raw.trim())
    const family = desc.get_family()
    if (!family || desc.get_size() <= 0) return { ok: false, error: `expected "Family Size" (points), got: ${raw}` }
    fontFamilies ??= new Set(PangoCairo.FontMap.get_default().list_families().map(f => f.get_name().toLowerCase()))
    if (!fontFamilies.has(family.toLowerCase())) return { ok: false, error: `no font family "${family}" on this system` }
    return { ok: true, value: raw.trim() }
}

export function registerConfigEntries() {
    // ── Appearance ────────────────────────────────────────────────────────
    registerConfig("appearance.darkMode", {
        desc: "Dark mode (false = light). Propagates to GTK apps and the portal.",
        type: "boolean",
        get: () => Theme.isDark,
        set: v => Theme.setDarkMode(v as boolean),
        subscribe: onThemeCfg(() => Theme.isDark),
        ui: {
            i18n: "settings.appearance.dark-mode",
        },
    })
    registerConfig("appearance.accent", {
        // The nearest preset NAME to the accent hex (owner, 2026-11-15: the
        // accent is a real setting again — any hex, picked in Studio). The
        // exact hex is `appearance.accentHex`; this key is the name the
        // outside world sees, and `set` routes through Theme.setAccentColor,
        // which resolves the name to its preset hex.
        desc: "Accent preset nearest to the active accent colour, used for active/selected state across the shell and libadwaita apps. The exact colour is appearance.accentHex; cyan #00E5FF is the default. (GNOME/libadwaita apps see it as the published blue: GNOME's accent enum has no cyan.)",
        type: "enum",
        enum: Object.keys(ACCENT_PALETTE),
        get: () => Theme.accentColor,
        set: v => void Theme.setAccentColor(v as string),
        // No `ui`: the picker lives in Studio, not in the shell's Settings;
        // but org.veltrix.Config1's `Changed` needs to hear it like every
        // other key.
        subscribe: onThemeCfg(() => Theme.accentColor),
    })
    registerConfig("appearance.accentHex", {
        desc: "Accent colour as #RRGGBB — the exact colour the shell paints for active/selected state. Any hex; cyan #00E5FF is the default. Setting it also moves appearance.accent to the nearest preset name and publishes the nearest GNOME accent name to libadwaita apps.",
        type: "string",
        validate: raw => /^#[0-9a-fA-F]{6}$/.test(raw.trim())
            ? { ok: true, value: raw.trim().toUpperCase() }
            : { ok: false, error: `expected #RRGGBB, got: ${raw}` },
        get: () => Theme.accentHex,
        set: v => void Theme.setAccentColor(v as string),
        subscribe: onThemeCfg(() => Theme.accentHex),
    })
    // Veltrix's windows (toolkit/PHASE1.md D6, owner 2026-10-18): one choice, opaque by default.
    // The colour is the app's; the opacity and the blur under it are this level's
    // (WINDOW_BACKGROUNDS), drawn by the compositor — AppearanceSync writes them into Hyalo.
    registerConfig("appearance.windowBackground", {
        desc: "Veltrix's own windows (Settings, About, the installer and toolkit apps that follow the setting): opaque; tinted — the colour of what is behind comes through, heavily blurred, subtle; or translucent — less opaque and less blurred, what is behind shows. A window that lets anything through is always blurred. Separate from the interface's glass. Ignored (opaque) while accessibility.reduceTransparency is on. Other apps' translucent windows always get the translucent blur.",
        type: "enum",
        enum: ["opaque", "tinted", "translucent"],
        get: () => Theme.windowBackground,
        set: v => void Theme.setWindowBackground(v as WindowBackground),
        subscribe: onThemeCfg(() => Theme.windowBackground),
        ui: {
            i18n: "settings.appearance.window-background",
            control: "segmented",
            optI18n: (v: string) => t(`settings.appearance.window-background.${v}` as any),
        },
    })
    // Where the window controls go (#708 point 5): the compositor draws them over the app's
    // header, on this side; the apps that draw their own title bar put theirs there too. The
    // side lives in `button-layout`, which the compositor follows (core/WindowButtons.ts). Only
    // where the compositor draws controls (Hyalo); Hyprland draws none.
    registerConfig("appearance.windowControls", {
        desc: "Which side of a window its controls (close, maximize; minimize where the compositor minimizes) go on: right, the Linux and Windows convention (close last), or left (close first; in a window with a sidebar shown, inside it). For every window: the compositor's controls over Veltrix's windows and its title bar, and the buttons of apps that draw their own title bar (GTK, Chrome's web apps, Telegram) — all read org.gnome.desktop.wm.preferences button-layout, which this writes.",
        type: "enum",
        enum: ["right", "left"],
        available: () => compositorSettings.caps.windowControls,
        get: () => readWindowButtons().side,
        set: v => setWindowButtonsSide(v as "right" | "left"),
        subscribe: (apply) => {
            apply(readWindowButtons().side)
            return onWindowButtonsChanged(() => apply(readWindowButtons().side))
        },
        ui: {
            i18n: "settings.appearance.window-controls",
            control: "segmented",
            optI18n: (v: string) => t(`settings.appearance.window-controls.${v}` as any),
        },
    })
    registerConfig("appearance.gtkTheme", {
        desc: "GTK theme for THIRD-PARTY apps only — Veltrix's own processes load no GTK theme (tech-debt #107).",
        type: "enum",
        enum: () => Theme.getAvailableGtkThemes(),
        get: () => Theme.themeFamily,
        set: v => Theme.setGtkTheme(v as string),
        subscribe: onThemeCfg(() => Theme.themeFamily),
        ui: {
            i18n: "settings.appearance.gtk-theme",
            optI18n: v => v,
        },
    })
    registerConfig("appearance.iconTheme", {
        desc: "System icon theme.",
        type: "enum",
        enum: () => Theme.getAvailableIconThemes(),
        get: () => Theme.iconTheme,
        set: v => Theme.setIconTheme(v as string),
        subscribe: onThemeCfg(() => Theme.iconTheme),
        ui: {
            i18n: "settings.appearance.icons",
            optI18n: v => v,
        },
    })
    // The theme for Veltrix's OWN icons (#587) — the bar, the menus, Settings —
    // beside `appearance.iconTheme` above, which is the one applications draw from.
    // "veltrix" is our own theme, the Veltrix icon theme (assets/icons/veltrix, linked
    // as /usr/share/icons/veltrix). It is stored as the empty string, which reads the
    // same files straight from assets/ — so it is listed once, first, and filtered
    // out of what `specIconThemes` finds. Only themes that declare Veltrix's icon spec
    // are offered: no other theme has an `nd-` name, so picking one would change
    // nothing. The row stays visible with "VELTRIX" alone — it is how a user learns
    // their own theme can go there.
    registerConfig("appearance.interfaceIconTheme", {
        desc: "Icon theme for Veltrix's own interface icons (bar, menus, Settings), separate from the app icon theme. 'veltrix' = Veltrix's own drawings (default). Only themes made for Veltrix's icon spec (X-Veltrix-Icon-Spec in index.theme, see ui/shell/assets/icons/veltrix/SPEC.md) are listed. Any icon the chosen theme lacks, or cannot draw, falls back to Veltrix's.",
        type: "enum",
        enum: (() => {
            const themes = specIconThemes().filter(n => n !== "veltrix")
            const current = interfaceIconTheme()
            if (current && current !== "veltrix" && !themes.includes(current)) themes.push(current)
            return ["veltrix", ...themes.sort()]
        })(),
        get: () => interfaceIconTheme() || "veltrix",
        set: v => setInterfaceIconTheme(v === "veltrix" ? "" : v as string),
        subscribe: (apply) => {
            apply(interfaceIconTheme() || "veltrix")
            return onInterfaceIconThemeChange(n => apply(n || "veltrix"))
        },
        ui: {
            i18n: "settings.appearance.interface-icons",
            optI18n: v => v === "veltrix" ? t("settings.appearance.interface-icons.opt.veltrix") : v,
        },
    })
    registerConfig("appearance.cursorTheme", {
        desc: "System cursor theme.",
        type: "enum",
        enum: () => Theme.getAvailableCursorThemes(),
        get: () => Theme.cursorTheme,
        set: v => Theme.setCursorTheme(v as string),
        subscribe: onThemeCfg(() => Theme.cursorTheme),
        ui: {
            i18n: "settings.appearance.cursor",
            optI18n: v => v,
        },
    })
    registerConfig("wallpaper.transition", {
        desc: "Wallpaper transition animation style.",
        type: "enum",
        enum: TRANSITIONS,
        get: () => Wallpaper.transition,
        set: v => Wallpaper.setTransition(v as TransitionType),
        subscribe: onWallpaperCfg(() => Wallpaper.transition),
        ui: {
            i18n: "settings.appearance.transition",
            optI18n: k => TRANSITION_LABELS[k as TransitionType] ?? k,
        },
    })
    registerConfig("wallpaper.rotation", {
        desc: "Change the wallpaper automatically: off (default), every hour in catalogue order, once on each lock-screen unlock, or a random bundled wallpaper every hour.",
        type: "enum",
        enum: ROTATIONS,
        get: () => Wallpaper.rotation,
        set: v => Wallpaper.setRotation(v as RotationType),
        subscribe: onWallpaperCfg(() => Wallpaper.rotation),
        ui: {
            i18n: "settings.appearance.rotation",
            optI18n: k => ROTATION_LABELS[k as RotationType] ?? k,
        },
    })
    // ── What Appearance's own controls change (toolkit/PHASE1.md D1 [A2]) ──────────
    // They had no key: the GTK Settings' custom builders call the services directly, so the
    // native Settings — which has no setting logic — could not reach them. No `ui`: each is
    // drawn by a named custom builder of the manifest, not by a generic row.
    registerConfig("wallpaper.current", {
        desc: "The wallpaper image: an absolute path (or file:// URI) to a JPEG, PNG, GIF, WebP or AVIF file. The bundled wallpapers are offered in `catalogue`; any readable image of those types is accepted.",
        type: "string",
        catalogue: () => getBundledWallpapers().filter(p => !p.includes("wallpaper-greeter")),
        validate: validWallpaper,
        get: () => Wallpaper.current,
        set: v => Wallpaper.setWallpaper(v as string, undefined, true),
        subscribe: onWallpaperCfg(() => Wallpaper.current),
    })
    for (const [key, which] of [["nightlight.scheduleFrom", "From"], ["nightlight.scheduleTo", "To"]] as const) {
        registerConfig(key, {
            desc: `Night light schedule: when it turns ${which === "From" ? "on" : "off"}, as HH:MM (24 h). Used while nightlight.scheduleEnabled is on.`,
            type: "string",
            validate: raw => /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.trim())
                ? { ok: true, value: raw.trim() }
                : { ok: false, error: `expected a time as HH:MM (00:00–23:59), got: ${raw}` },
            get: () => which === "From" ? NightLight.scheduleFrom : NightLight.scheduleTo,
            set: v => which === "From" ? NightLight.setScheduleFrom(v as string) : NightLight.setScheduleTo(v as string),
            subscribe: (apply) => {
                apply(which === "From" ? NightLight.scheduleFrom : NightLight.scheduleTo)
                return NightLight.subscribe(which === "From" ? "scheduleFrom" : "scheduleTo", apply)
            },
        })
    }
    for (const [key, mono] of [["appearance.interfaceFont", false], ["appearance.monoFont", true]] as const) {
        registerConfig(key, {
            desc: `The ${mono ? "monospace" : "interface"} font as a Pango description, "Family [Style] Size" in points (unscaled: the text scale applies on top), as org.gnome.desktop.interface stores it. A family the system does not have is refused.`,
            type: "string",
            validate: validFont,
            get: () => mono ? Theme.monoFont : Theme.interfaceFont,
            set: v => mono ? Theme.setMonoFont(v as string) : Theme.setFont(v as string),
            subscribe: onThemeCfg(() => mono ? Theme.monoFont : Theme.interfaceFont),
        })
    }

    // ── Interface ─────────────────────────────────────────────────────────
    // iPad Mode (Adnan, 2026-11-12): the whole screen becomes an iPad-style
    // home screen — macOS bar on top, macOS dock at the bottom, a big app
    // grid with widgets in the middle. OFF by default: the macOS desktop is
    // the default and stays exactly as it is. A live switch — Bar subscribes
    // to the store, so flipping it swaps the home screen at once, no
    // logout, no reload.
    registerConfig("interface.ipadMode", {
        desc: "iPad Mode: show an iPad-style home screen (big app grid with widgets between the macOS bar and dock) instead of the macOS desktop. Off by default; the macOS desktop is unchanged.",
        type: "boolean",
        get: () => interfaceConfig.ipadMode,
        set: v => interfaceConfig.setIpadMode(v as boolean),
        subscribe: (apply) => {
            apply(interfaceConfig.ipadMode)
            return interfaceConfig.subscribe("ipadMode", apply)
        },
        ui: {
            i18n: "settings.interface.ipad-mode",
        },
    })

    // ── Dock ──────────────────────────────────────────────────────────────
    registerConfig("dock.position", {
        desc: "Dock screen position.",
        type: "enum",
        enum: ["bottom", "left", "right"],
        get: () => dockSettings.position,
        set: v => updateDockSettings({ position: v as DockPosition }),
        subscribe: (apply) => {
            apply(dockSettings.position)
            return onDockSettingChanged("position", apply)
        },
        ui: {
            i18n: "settings.dock.position",
            optI18n: v => t(`settings.dock.opt.${v}` as any),
        },
    })
    registerConfig("dock.iconSize", {
        desc: "Dock icon size in pixels (32, 48, 64, 80, 96).",
        type: "number",
        min: 32,
        max: 96,
        get: () => dockSettings.iconSize,
        set: v => updateDockSettings({ iconSize: v as number }),
        subscribe: (apply) => {
            apply(dockSettings.iconSize)
            return onDockSettingChanged("iconSize", apply)
        },
        ui: {
            i18n: "settings.dock.icon-size",
            control: "preset",
            presets: [32, 48, 64, 80, 96],
            presetUnit: "px",
        },
    })
    registerConfig("dock.magnification", {
        desc: "Magnify dock icons on hover.",
        type: "boolean",
        get: () => dockSettings.magnification,
        set: v => updateDockSettings({ magnification: v as boolean }),
        subscribe: (apply) => {
            apply(dockSettings.magnification)
            return onDockSettingChanged("magnification", apply)
        },
        ui: {
            i18n: "settings.dock.magnification",
        },
    })
    registerConfig("dock.maxIconSize", {
        desc: "Maximum icon size on hover when magnification is enabled.",
        type: "number",
        min: 64,
        max: 128,
        get: () => dockSettings.maxIconSize,
        set: v => updateDockSettings({ maxIconSize: v as number }),
        subscribe: (apply) => {
            apply(dockSettings.maxIconSize)
            return onDockSettingChanged("maxIconSize", apply)
        },
        ui: {
            i18n: "settings.dock.max-size",
            slider: { unit: "px" },
        },
    })
    registerConfig("dock.autoHide", {
        desc: "Automatically hide the dock when windows overlap it.",
        type: "boolean",
        get: () => dockSettings.autoHide,
        set: v => updateDockSettings({ autoHide: v as boolean }),
        subscribe: (apply) => {
            apply(dockSettings.autoHide)
            return onDockSettingChanged("autoHide", apply)
        },
        ui: {
            i18n: "settings.dock.autohide",
        },
    })
    registerConfig("dock.indicators", {
        desc: "Show running-application indicator dots under dock icons.",
        type: "boolean",
        get: () => dockSettings.showIndicators,
        set: v => updateDockSettings({ showIndicators: v as boolean }),
        subscribe: (apply) => {
            apply(dockSettings.showIndicators)
            return onDockSettingChanged("showIndicators", apply)
        },
        ui: {
            i18n: "settings.dock.indicators",
        },
    })
    registerConfig("dock.hideDelay", {
        desc: "Delay in milliseconds before hiding the dock.",
        type: "number",
        min: 0,
        max: 2000,
        get: () => dockSettings.hideDelay,
        set: v => updateDockSettings({ hideDelay: Math.round(Number(v)) }),
        subscribe: (apply) => {
            apply(dockSettings.hideDelay)
            return onDockSettingChanged("hideDelay", apply)
        },
        ui: {
            i18n: "settings.dock.hide-delay",
            slider: { unit: "ms" },
        },
    })

    // ── Bar ───────────────────────────────────────────────────────────────
    registerConfig("bar.appTitle", {
        desc: "Show the active window title in the top bar.",
        type: "boolean",
        get: () => barConfig.get("showAppTitle"),
        set: v => barConfig.set("showAppTitle", v as boolean),
        subscribe: (apply) => {
            apply(barConfig.get("showAppTitle"))
            return barConfig.subscribe("showAppTitle", apply)
        },
        // No `ui`: its row is one of the Top bar list's (custom/bar.ts), in the same
        // check-icon-name format as every other item there.
    })

    registerConfig("bar.island.chipOpensPanel", {
        desc: "Clicking an Activity Island chip moves it into the capsule; true also opens its panel once it has (false: a second click, on the capsule, opens it).",
        type: "boolean",
        get: () => barConfig.get("chipOpensPanel"),
        set: v => barConfig.set("chipOpensPanel", v as boolean),
        subscribe: (apply) => {
            apply(barConfig.get("chipOpensPanel"))
            return barConfig.subscribe("chipOpensPanel", apply)
        },
        // No `ui` yet: its row belongs to the Activity Island's own entry in the Top bar
        // page, which the owner is designing (2026-10-07).
    })

    // ── Input: Mouse ──────────────────────────────────────────────────────
    registerConfig("input.mouse.speed", {
        desc: "Pointer sensitivity (-1.0 to 1.0).",
        type: "number",
        min: -1.0,
        max: 1.0,
        get: () => inputConfig.pointerSpeed,
        set: v => inputConfig.setPointerSpeed(v as number),
        subscribe: onInputCfg(() => inputConfig.pointerSpeed),
        ui: {
            i18n: "settings.input.mouse.speed",
            slider: {
                // Sink caro: `inputConfig` aplica en el compositor Y reescribe
                // su capa de ajustes entera (`veltrix-settings.lua`, `hyalo-settings.toml`) en cada confirmación. Con los 32 ms
                // de debounce del kit, arrastrar el pulgar son ~30 de esas por
                // segundo. `commitOnRelease` confirma UNA vez, al soltar; el valor
                // se sigue viendo moverse porque la etiqueta la pinta
                // `onValueChanged`, que no es la que escribe.
                commitOnRelease: true,
                icons: [uiIcon("nd-preferences-desktop-peripherals"), uiIcon("nd-preferences-desktop-peripherals")],
                pct: true,
            },
        },
    })
    registerConfig("input.mouse.accel", {
        desc: "Pointer acceleration profile: 'adaptive' or 'flat'.",
        type: "enum",
        enum: ["adaptive", "flat"],
        get: () => inputConfig.accelProfile,
        set: v => inputConfig.setAccelProfile(v as string),
        subscribe: onInputCfg(() => inputConfig.accelProfile),
        ui: {
            i18n: "settings.input.mouse.accel",
            optI18n: (v) => v,
        },
    })
    registerConfig("input.mouse.natural", {
        desc: "Invert mouse scroll direction (natural scrolling).",
        type: "boolean",
        get: () => inputConfig.mouseNaturalScroll,
        set: v => inputConfig.setMouseNaturalScroll(v as boolean),
        subscribe: onInputCfg(() => inputConfig.mouseNaturalScroll),
        ui: {
            i18n: "settings.input.mouse.natural",
        },
    })

    // ── Input: Touchpad ───────────────────────────────────────────────────
    registerConfig("input.touchpad.natural", {
        desc: "Invert touchpad scroll direction (natural scrolling).",
        type: "boolean",
        get: () => inputConfig.touchpadNaturalScroll,
        set: v => inputConfig.setTouchpadNaturalScroll(v as boolean),
        subscribe: onInputCfg(() => inputConfig.touchpadNaturalScroll),
        ui: {
            i18n: "settings.input.touchpad.natural",
        },
    })
    registerConfig("input.touchpad.tap", {
        desc: "Tap touchpad to click.",
        type: "boolean",
        get: () => inputConfig.touchpadTap,
        set: v => inputConfig.setTouchpadTap(v as boolean),
        subscribe: onInputCfg(() => inputConfig.touchpadTap),
        ui: {
            i18n: "settings.input.touchpad.tap",
        },
    })

    // ── Input: Keyboard ───────────────────────────────────────────────────
    registerConfig("input.keyboard.layout", {
        desc: "Keyboard layout: an xkb layout code, optionally '-' and a variant — 'us', "
            + "'us-colemak', 'de-nodeadkeys'. The whole xkb catalogue is offered "
            + "(/usr/share/X11/xkb/rules/base.lst). This is the GRAPHICAL layout only: it "
            + "never touches the text console, which the installer sets.",
        type: "enum",
        enum: allKeyboards().map(k => k.id),
        get: () => currentKbLayoutId(),
        // The id round-trips, so there is nothing to look up: an unknown value
        // (a comma-separated set Hyprland accepts, say) is passed through as the
        // layout rather than rejected, which is what the old hand-list did too.
        set: v => {
            const { layout, variant } = parseKeyboardId(String(v))
            return inputConfig.setKbLayout(layout, variant)
        },
        subscribe: onInputCfg(() => currentKbLayoutId()),
        ui: {
            i18n: "settings.input.keyboard.layout",
            optI18n: kbLayoutLabel,
        },
    })
    registerConfig("input.keyboard.numlock", {
        desc: "Enable NumLock on boot.",
        type: "boolean",
        get: () => inputConfig.numlockOnBoot,
        set: v => inputConfig.setNumlockOnBoot(v as boolean),
        subscribe: onInputCfg(() => inputConfig.numlockOnBoot),
        ui: {
            i18n: "settings.input.keyboard.numlock",
        },
    })
    registerConfig("input.keyboard.repeatDelay", {
        desc: "Keyboard repeat delay in milliseconds before repeating keys.",
        type: "number",
        min: 100,
        max: 2000,
        get: () => inputConfig.kbRepeatDelay,
        set: v => inputConfig.setKbRepeatDelay(v as number),
        subscribe: onInputCfg(() => inputConfig.kbRepeatDelay),
        ui: {
            i18n: "settings.input.keyboard.repeat-delay",
            // Sink caro: `inputConfig` aplica en el compositor Y reescribe
            // su capa de ajustes entera (`veltrix-settings.lua`, `hyalo-settings.toml`) en cada confirmación. Con los 32 ms de
            // debounce del kit, arrastrar el pulgar son ~30 de esas por segundo.
            // `commitOnRelease` confirma UNA vez, al soltar; el valor sigue
            // viéndose moverse porque la etiqueta la pinta `onValueChanged`, que
            // no es la que escribe.
            slider: { unit: "ms", commitOnRelease: true },
        },
    })
    registerConfig("input.keyboard.repeatRate", {
        desc: "Keyboard repeat rate in characters per second.",
        type: "number",
        min: 1,
        max: 100,
        get: () => inputConfig.kbRepeatRate,
        set: v => inputConfig.setKbRepeatRate(v as number),
        subscribe: onInputCfg(() => inputConfig.kbRepeatRate),
        ui: {
            i18n: "settings.input.keyboard.repeat-rate",
            // Sink caro: `inputConfig` aplica en el compositor Y reescribe
            // su capa de ajustes entera (`veltrix-settings.lua`, `hyalo-settings.toml`) en cada confirmación. Con los 32 ms de
            // debounce del kit, arrastrar el pulgar son ~30 de esas por segundo.
            // `commitOnRelease` confirma UNA vez, al soltar; el valor sigue
            // viéndose moverse porque la etiqueta la pinta `onValueChanged`, que
            // no es la que escribe.
            slider: { unit: "/s", commitOnRelease: true },
        },
    })

    // ── Night light ───────────────────────────────────────────────────────
    registerConfig("nightlight.enabled", {
        desc: "Blue-light filter (hyprsunset).",
        type: "boolean",
        get: () => NightLight.enabled,
        set: v => NightLight.setEnabled(v as boolean),
        subscribe: (apply) => {
            apply(NightLight.enabled)
            return NightLight.subscribe("enabled", apply)
        },
        ui: {
            i18n: "settings.appearance.night-light",
        },
    })
    registerConfig("nightlight.temperature", {
        desc: "Night light color temperature in Kelvin (lower = warmer).",
        type: "number",
        min: 2700,
        max: 6500,
        get: () => NightLight.temperature,
        set: v => NightLight.setTemperature(v as number),
        subscribe: (apply) => {
            apply(NightLight.temperature)
            return NightLight.subscribe("temperature", apply)
        },
        ui: {
            i18n: "settings.appearance.night-light-temp",
            // Live: the screen warms with the thumb (Hyalo coalesces the flood to one ramp per tick).
            slider: { unit: "K", icons: [uiIcon("nd-value-decrease"), uiIcon("nd-value-increase")], debounce: 0 },
        },
    })
    registerConfig("nightlight.scheduleEnabled", {
        desc: "Enable automatic night light schedule by time.",
        type: "boolean",
        get: () => NightLight.scheduleEnabled,
        set: v => NightLight.setScheduleEnabled(v as boolean),
        subscribe: (apply) => {
            apply(NightLight.scheduleEnabled)
            return NightLight.subscribe("scheduleEnabled", apply)
        },
        ui: {
            i18n: "settings.appearance.night-light-schedule",
        },
    })

    // ── Notifications ─────────────────────────────────────────────────────
    registerConfig("notifications.popupTimeout", {
        desc: "Seconds a notification popup stays on screen.",
        type: "number",
        min: 2,
        max: 15,
        get: () => notifConfig.popupTimeout,
        set: v => notifConfig.setPopupTimeout(v as number),
        subscribe: (apply) => {
            apply(notifConfig.popupTimeout)
            return notifConfig.subscribe("popupTimeout", apply)
        },
        ui: {
            i18n: "settings.notif.timeout",
            slider: { unit: "s" },
        },
    })
    registerConfig("notifications.doNotDisturb", {
        desc: "Do Not Disturb: suppress notification popups (critical ones still show). Persists across sessions until turned off.",
        type: "boolean",
        get: dontDisturb,
        set: v => setDontDisturb(v as boolean),
        subscribe: (apply) => {
            apply(dontDisturb())
            return notifConfig.subscribe("doNotDisturb", apply)
        },
        ui: {
            i18n: "settings.notif.dnd",
        },
    })

    // ── Safety ────────────────────────────────────────────────────────────
    // Content Safety (Settings → Safety): block adult websites with TWO
    // layers, applied and removed together by the privileged helper
    // `veltrix-content-safety` — CleanBrowsing Family DNS (185.228.168.168 /
    // 185.228.169.168) + a managed hosts-file blocklist (StevenBlack/hosts
    // "porn-only", MIT). Default ON (Adnan, 2026-11-12) — a deviation from
    // halal rubric 6.3 ("offered during setup, opt-in"), recorded in
    // docs/content-safety-report.md and BUILD_LOG.md.
    //
    // The Settings row is a CUSTOM toggle (surfaces/settings/custom/safety.ts):
    // turning it off opens the reflective interstitial first (verse + a real
    // 60-second pause). An agent `setConfig` here is an explicit instruction
    // from the user and applies directly — the interstitial is a UI flow for
    // an impulsive tap, not a second password.
    registerConfig("safety.contentFilter", {
        desc: "Block adult websites: CleanBrowsing Family DNS (over DNS-over-TLS) + a hosts-file blocklist of the most-visited adult domains, applied and removed together. Default ON. A helper, not a guarantee — a determined user can bypass it (VPN, DNS-over-HTTPS, editing /etc/hosts), and DNS queries go to CleanBrowsing's servers. If CleanBrowsing cannot be reached, name lookup stops working until protection is turned off. Turning it off in Settings asks for a moment of reflection first; an agent instruction to turn it off skips that pause. Protection is system-wide while this switch is per user.",
        type: "boolean",
        get: () => safetyConfig.contentFilter,
        set: v => safetyConfig.setContentFilter(v as boolean),
        subscribe: (apply) => {
            apply(safetyConfig.contentFilter)
            return safetyConfig.subscribe("contentFilter", apply)
        },
        ui: {
            i18n: "settings.safety.block",
        },
    })

    // ── Halal Audio ───────────────────────────────────────────────────────
    // Settings → Audio Filter: a playback-time filter
    // (bin/veltrix-halal-audio — VoiceOnly vocals + wordscan words). The
    // switch unlocks the "Play with filter…" action; it changes nothing
    // by itself — no live filtering, no playback modification, and
    // playing always starts with an explicit file pick. Default ON is
    // Adnan's explicit call (2026-11-12, 21:59 EST): the filter is a
    // halal protection, on unless the user deliberately turns it off —
    // and turning it off is guarded by the halal interstitial (verse +
    // 60-second pause, same friction as Content Safety), not a plain
    // toggle. The agent key only flips the same switch; processing
    // still needs a file picked in Settings.
    registerConfig("halalAudio.enabled", {
        desc: "Audio filter (vocal-only): unlocks playback-time filtering (Settings → Audio Filter). With it on, the user picks one audio file and plays it through the VoiceOnly Fast vocal filter (mostly voice, never only voice) after its words are scanned against a local list — clean songs are whitelisted by audio hash and play at once next time; a flagged song shows 'This is haram' and plays only if the user explicitly chooses to. A filtered copy can also be saved next to the original (warns, never mutes). The original is never modified. Default ON (Adnan, 2026-11-12); turning it off opens the halal interstitial (An-Nur 24:30 + 60-second pause) first. No live filtering, no Spotify filtering, no network at scan/play time — and it does not make a song halal: it reduces two haram elements, it does not certify the result.",
        type: "boolean",
        get: () => halalAudioConfig.enabled,
        set: v => halalAudioConfig.setEnabled(v as boolean),
        subscribe: (apply) => {
            apply(halalAudioConfig.enabled)
            return halalAudioConfig.subscribe("enabled", apply)
        },
        ui: {
            i18n: "settings.halalAudio.enable",
        },
    })

    // ── Accessibility ─────────────────────────────────────────────────────
    registerConfig("accessibility.textScale", {
        desc: "Text scale factor (0.75 to 1.50).",
        type: "number",
        min: TEXT_SCALE_MIN,
        max: TEXT_SCALE_MAX,
        get: () => Theme.textScaling,
        set: v => void Theme.setTextScaling(Number(v)),
        subscribe: onThemeCfg(() => Theme.textScaling),
        ui: {
            i18n: "settings.accessibility.text-scale",
            slider: {
                decimals: 2,
                step: 0.05,
                commitOnRelease: false,
                endpoints: [
                    new Gtk.Label({ label: "A", css_classes: ["slider-text-endpoint", "is-sm"], valign: Gtk.Align.CENTER }),
                    new Gtk.Label({ label: "A", css_classes: ["slider-text-endpoint", "is-lg"], valign: Gtk.Align.CENTER }),
                ],
            },
        },
    })
    registerConfig("accessibility.cursorSize", {
        desc: "Cursor size in pixels (16 to 96).",
        type: "number",
        min: 16,
        max: 96,
        get: () => Theme.cursorSize,
        set: v => Theme.setCursorSize(Math.round(Number(v))),
        subscribe: onThemeCfg(() => Theme.cursorSize),
        ui: {
            i18n: "settings.accessibility.cursor-size",
            slider: {
                unit: "px",
                icons: [uiIcon("nd-preferences-desktop-peripherals"), uiIcon("nd-preferences-desktop-peripherals")],
                commitOnRelease: true,
            },
        },
    })
    registerConfig("accessibility.reduceTransparency", {
        desc: "Reduce transparency: every glass surface — bar, panels, dock, menus, Veltrix's windows, the lock screen and the login screen — becomes solid.",
        type: "boolean",
        get: () => Theme.reduceTransparency,
        set: v => void Theme.setReduceTransparency(v as boolean),
        subscribe: onThemeCfg(() => Theme.reduceTransparency),
        ui: {
            i18n: "settings.accessibility.reduce-transparency",
        },
    })
    registerConfig("accessibility.reduceMotion", {
        desc: "Reduce motion: overlays appear without their pop, dock icons snap instead of springing, and the compositor's window/workspace animations are switched off.",
        type: "boolean",
        get: () => reduceMotion(),
        set: v => setReduceMotion(v as boolean),
        subscribe: (apply) => {
            apply(reduceMotion())
            return onReduceMotionChange(apply)
        },
        ui: {
            i18n: "settings.accessibility.reduce-motion",
        },
    })

    // ── Power / Idle ──────────────────────────────────────────────────────
    // Auto-sleep (2026-11-13): the toggle IS the effective suspend — on
    // means a suspend listener / nonzero Hyalo `suspend` is in force, off
    // means none — read back from the compositor's own config, never stored
    // separately, so the switch cannot disagree with reality. Flipping it
    // writes the effective value through updateIdleConfig, which regenerates
    // hypridle.conf and restarts hypridle (Hyprland) or patches Hyalo's
    // [idle] — immediate, no reboot. The timeout it restores lives in
    // AutoSleep.ts, so switching off never resets it.
    registerConfig("power.autoSleep", {
        desc: "Auto-sleep: suspend the computer after the suspend timeout below when nobody is using it. Off means it never suspends on its own.",
        type: "boolean",
        get: () => getIdleConfig().suspend > 0,
        set: v => updateIdleConfig({ suspend: v ? autoSleepConfig.timeout : 0 }),
        subscribe: onPowerCfg(() => getIdleConfig().suspend > 0),
        ui: {
            i18n: "settings.power.auto-sleep",
        },
    })
    registerConfig("power.screenOff", {
        desc: "Screen off timeout in seconds (0 = never).",
        type: "enum",
        enum: ["0", "120", "300", "600", "1200", "1800"],
        get: () => String(getIdleConfig().screenOff),
        set: v => updateIdleConfig({ screenOff: Number(v) }),
        subscribe: onPowerCfg(() => String(getIdleConfig().screenOff)),
        ui: {
            i18n: "settings.power.screen-off",
            optI18n: powerScreenOffLabel,
        },
    })
    registerConfig("power.lock", {
        desc: "Lock session timeout in seconds (0 = never).",
        type: "enum",
        enum: ["0", "300", "600", "1800", "3600", "7200"],
        get: () => String(getIdleConfig().lock),
        set: v => updateIdleConfig({ lock: Number(v) }),
        subscribe: onPowerCfg(() => String(getIdleConfig().lock)),
        ui: {
            i18n: "settings.power.lock",
            optI18n: powerLockLabel,
        },
    })
    registerConfig("power.suspend", {
        // The dropdown edits the REMEMBERED timeout (AutoSleep.ts), not the
        // effective one: with auto-sleep on it applies live as well; with
        // auto-sleep off it only remembers, so the timeout survives being
        // switched off. "Never" is the toggle above now, not an option here —
        // the enum has no 0, and the old `setConfig power.suspend 0` spelling
        // is `setConfig power.autoSleep false`.
        desc: "Suspend timeout in seconds — the idle time auto-sleep waits before suspending. Only applies while auto-sleep is on.",
        type: "enum",
        enum: AUTO_SLEEP_TIMEOUTS.map(String),
        get: () => String(autoSleepConfig.timeout),
        set: v => {
            const secs = Number(v)
            autoSleepConfig.setTimeout(secs)
            if (getIdleConfig().suspend > 0) updateIdleConfig({ suspend: secs })
        },
        subscribe: (apply) => {
            const offPower = onPowerCfg(() => String(autoSleepConfig.timeout))(apply)
            const offStore = autoSleepConfig.subscribe("autoSleepTimeout", () => apply(String(autoSleepConfig.timeout)))
            return () => { offPower(); offStore() }
        },
        ui: {
            i18n: "settings.power.suspend",
            optI18n: powerSuspendLabel,
        },
    })

    // ── Region ────────────────────────────────────────────────────────────
    registerConfig("region.timeFormat", {
        desc: "24- or 12-hour clock: the bar's, the lock screen's and the login screen's.",
        type: "enum",
        enum: ["24h", "12h"],
        get: () => regionConfig.timeFormat,
        set: v => regionConfig.setTimeFormat(v as TimeFormat),
        subscribe: (apply) => {
            apply(regionConfig.timeFormat)
            const id = regionConfig.connect("changed", () => apply(regionConfig.timeFormat))
            return () => safeDisconnect(regionConfig, id)
        },
        ui: {
            i18n: "settings.region.time.format",
            optI18n: k => t(`settings.region.time.${k}` as any),
        },
    })
    registerConfig("region.dateFormat", {
        desc: "The date beside the bar's clock: 'none', 'short' (Mon, Apr 6), 'short-year', 'long' (Monday, April 6), 'numeric' or 'iso'. Names and field order follow the regional format. The bar's only: the lock screen and the login screen always show the long date.",
        type: "enum",
        enum: ["none", "short", "short-year", "long", "numeric", "iso"],
        get: () => regionConfig.dateFormat,
        set: v => regionConfig.setDateFormat(v as DateFormat),
        subscribe: (apply) => {
            apply(regionConfig.dateFormat)
            const id = regionConfig.connect("changed", () => apply(regionConfig.dateFormat))
            return () => safeDisconnect(regionConfig, id)
        },
        ui: {
            i18n: "settings.region.date.format",
            optI18n: k => t(`settings.region.date.${k}` as any),
        },
    })
    registerConfig("region.showSeconds", {
        desc: "Show seconds in the clock display.",
        type: "boolean",
        get: () => regionConfig.showSeconds,
        set: v => regionConfig.setShowSeconds(v as boolean),
        subscribe: (apply) => {
            apply(regionConfig.showSeconds)
            const id = regionConfig.connect("changed", () => apply(regionConfig.showSeconds))
            return () => safeDisconnect(regionConfig, id)
        },
        ui: {
            i18n: "settings.region.time.seconds",
        },
    })
    registerConfig("region.hijriOffset", {
        desc: "Hijri date adjustment in days (−1 / 0 / +1) for local moon sighting. The bar's Hijri date comes from the Umm al-Qura table, which is calculated; a real month can start a day earlier or later than the table says. Changing it re-reads the Hijri date at once.",
        type: "enum",
        enum: ["-1", "0", "1"],
        get: () => String(regionConfig.hijriOffset),
        set: v => regionConfig.setHijriOffset(Number(v)),
        subscribe: (apply) => {
            apply(String(regionConfig.hijriOffset))
            const id = regionConfig.connect("changed", () => apply(String(regionConfig.hijriOffset)))
            return () => safeDisconnect(regionConfig, id)
        },
        ui: {
            i18n: "settings.region.hijri.offset",
            control: "segmented",
            optI18n: k => t(`settings.region.hijri.offset.${k}` as any),
        },
    })

    // ── Screen recording ──────────────────────────────────────────────────
    registerConfig("recording.audioSource", {
        desc: "What the capture panel's Audio switch records: '@system' (the default output's monitor — what you hear), '@mic' (the default input), or a literal PulseAudio source name from `pactl list short sources`. A named device that is no longer present falls back to '@system' rather than silently recording something else.",
        type: "string",
        get: () => recordingConfig.audioSource,
        set: v => recordingConfig.setAudioSource(v as string),
    })
    registerConfig("recording.quality", {
        desc: "Encoder quality preset for screen recordings. Trades file size against fidelity; the exact CRF/QP depends on the codec the format selects.",
        type: "enum",
        enum: QUALITIES,
        get: () => recordingConfig.quality,
        set: v => recordingConfig.setQuality(v as RecordQuality),
    })
    registerConfig("recording.framerate", {
        desc: "Recording frame rate. 0 = follow the compositor (a frame only when the screen changes — variable rate, smallest file); otherwise a constant rate.",
        type: "number",
        min: 0,
        max: 120,
        get: () => recordingConfig.framerate,
        set: v => recordingConfig.setFramerate(v as number),
    })
    registerConfig("recording.hardware", {
        desc: "Encode screen recordings on the GPU (VAAPI). Applies to the H.264 formats (mp4/mkv) only — webm always encodes in software, and the setting is ignored without a /dev/dri render node.",
        type: "boolean",
        get: () => recordingConfig.hardware,
        set: v => recordingConfig.setHardware(v as boolean),
    })
    // Hyalo's (`[cursor] recorded`), not the recorder's: wf-recorder always asks for the pointer.
    registerConfig("recording.showPointer", {
        desc: "Whether the mouse pointer is drawn into screen recordings. Applies from the next frame, also to a recording in progress. Only where the compositor has the switch (Hyalo); on Hyprland the pointer is always recorded.",
        type: "boolean",
        available: () => compositorSettings.caps.recordedPointer,
        get: () => compositorSettings.readRecordedPointer(),
        set: v => compositorSettings.setRecordedPointer(v as boolean),
    })
    registerConfig("recording.format", {
        desc: "Container for screen recordings. mp4/mkv record H.264, webm records VP9.",
        type: "enum",
        enum: FORMATS,
        get: () => recordingConfig.format,
        set: v => recordingConfig.setFormat(v as RecordFormat),
    })
    registerConfig("recording.saveDir", {
        desc: "Directory screen recordings are written to (created if missing).",
        type: "string",
        get: () => recordingConfig.saveDir,
        set: v => recordingConfig.setSaveDir(v as string),
    })

    // ── AI governance ─────────────────────────────────────────────────────
    // Visible so agents can SEE the gate, but not writable through the gate it
    // controls — flipping it is reserved to the Settings → AI page.
    registerConfig("ai.allowConfigWrite", {
        desc: "Whether agents may change settings via setConfig. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowConfigWrite,
        set: v => agentConfig.setAllowConfigWrite(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowConfigWrite),
        ui: {
            i18n: "settings.ai.allow-config-write",
        },
    })
    registerConfig("ai.allowScreenshot", {
        desc: "Whether agents may capture the screen via the screenshot IPC. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowScreenshot,
        set: v => agentConfig.setAllowScreenshot(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowScreenshot),
        ui: {
            i18n: "settings.ai.allow-screenshot",
        },
    })
    registerConfig("ai.allowWindowClose", {
        desc: "Whether agents may close windows via the closeWindow IPC. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowWindowClose,
        set: v => agentConfig.setAllowWindowClose(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowWindowClose),
        ui: {
            i18n: "settings.ai.allow-window-close",
        },
    })
    registerConfig("ai.allowMcp", {
        desc: "Whether veltrix-mcp serves tools to MCP clients. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowMcp,
        set: v => agentConfig.setAllowMcp(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowMcp),
        ui: {
            i18n: "settings.ai.allow-mcp",
        },
    })
    registerConfig("ai.allowComputerUse", {
        desc: "Whether agents may PERCEIVE other apps via the accessibility tree (veltrix-a11y, query_app). Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowComputerUse,
        set: v => agentConfig.setAllowComputerUse(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowComputerUse),
        ui: {
            i18n: "settings.ai.allow-computer-use",
        },
    })
    registerConfig("ai.allowComputerControl", {
        desc: "Whether agents may ACT in other apps — accessibility actions, synthetic keyboard and pointer (veltrix-act/type/click). Implies allowComputerUse. Toggle it in Settings → AI, or revoke it instantly with the kill switch (disableComputerControl).",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowComputerControl,
        set: v => agentConfig.setAllowComputerControl(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowComputerControl),
        ui: {
            i18n: "settings.ai.allow-computer-control",
        },
    })
    registerConfig("ai.allowFileRead", {
        desc: "Whether the built-in Assistant may READ Veltrix's own config, the shipped assets and the shell log (read_file/list_dir/search_files, prefix-limited). Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowFileRead,
        set: v => agentConfig.setAllowFileRead(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowFileRead),
        ui: {
            i18n: "settings.ai.allow-file-read",
        },
    })
    registerConfig("ai.allowFileWrite", {
        desc: "Whether the built-in Assistant may WRITE the three user-owned config files it is allowed to edit (edit_file/write_file, exact allowlist, every write committed to git). Implies allowFileRead. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowFileWrite,
        set: v => agentConfig.setAllowFileWrite(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowFileWrite),
        ui: {
            i18n: "settings.ai.allow-file-write",
        },
    })
    registerConfig("ai.assistantGlow", {
        desc: "Glow the border of the window the built-in Assistant is working in, for as long as a turn runs. Requires Hyprland 0.56+; makes Veltrix the owner of decoration:glow.",
        type: "boolean",
        writable: true,
        get: () => agentConfig.assistantGlow,
        set: v => agentConfig.setAssistantGlow(v as boolean),
        subscribe: onAiCfg(() => agentConfig.assistantGlow),
        ui: {
            i18n: "settings.ai.assistant-glow",
        },
    })
    registerConfig("ai.brainProvider", {
        desc: "Which provider the built-in Assistant talks to: '' (off) or 'ollama' (local Ollama, no key). Set it in Settings → AI.",
        type: "enum",
        enum: ["", ...AGENT_PROVIDERS.map(p => p.id)],
        writable: false,
        get: () => agentConfig.brainProvider,
        set: v => agentConfig.setBrainProvider(v as string),
        subscribe: onAiCfg(() => agentConfig.brainProvider),
        ui: {
            i18n: "settings.ai.brain.provider",
            optI18n: brainProviderLabel,
        },
    })
    registerConfig("ai.brainBackend", {
        desc: "Wire protocol derived from the provider: '' (off) or 'openai' (OpenAI-compatible, local Ollama only). Read-only — pick a provider instead.",
        type: "enum",
        enum: ["", "openai"],
        writable: false,
        get: () => agentConfig.brainBackend,
    })
    registerConfig("ai.brainModel", {
        desc: "Model id the built-in Assistant talks to (a local Ollama model name, e.g. llama3.1). Set it in Settings → AI.",
        type: "string",
        writable: false,
        get: () => agentConfig.brainModel,
    })

    // ── Workspace modes (#513) ───────────────────────────────────────────
    registerConfig("workspaces.defaultMode", {
        desc: "Default mode for workspaces: 'floating' or 'tiling'.",
        type: "enum",
        enum: WORKSPACE_MODES,
        writable: true,
        get: () => workspaceModes.defaultMode,
        set: v => workspaceModes.setDefaultMode(v as WorkspaceMode),
        subscribe: apply => {
            apply(workspaceModes.defaultMode)
            const id = workspaceModes.connect("changed", () => apply(workspaceModes.defaultMode))
            return () => safeDisconnect(workspaceModes, id)
        },
        ui: {
            i18n: "settings.desktop.default-mode",
            control: "segmented",
            optI18n: (v: string) => t(`settings.desktop.mode.${v}` as any),
        },
    })

    registerConfig("workspaces.workspace1Mode", {
        desc: "Window mode for workspace 1: 'default' (inherits default mode), 'floating', or 'tiling'.",
        type: "enum",
        enum: WORKSPACE_OVERRIDE_MODES,
        writable: true,
        get: () => workspaceModes.getWorkspaceModeSetting(1),
        set: v => workspaceModes.setWorkspaceMode(1, v as WorkspaceOverrideMode),
        subscribe: apply => {
            apply(workspaceModes.getWorkspaceModeSetting(1))
            const id = workspaceModes.connect("changed", () => apply(workspaceModes.getWorkspaceModeSetting(1)))
            return () => safeDisconnect(workspaceModes, id)
        },
        ui: {
            i18n: "settings.desktop.workspace-1",
            control: "segmented",
            optI18n: (v: string) => t(`settings.desktop.mode.${v}` as any),
        },
    })

    registerConfig("workspaces.workspace2Mode", {
        desc: "Window mode for workspace 2: 'default' (inherits default mode), 'floating', or 'tiling'.",
        type: "enum",
        enum: WORKSPACE_OVERRIDE_MODES,
        writable: true,
        get: () => workspaceModes.getWorkspaceModeSetting(2),
        set: v => workspaceModes.setWorkspaceMode(2, v as WorkspaceOverrideMode),
        subscribe: apply => {
            apply(workspaceModes.getWorkspaceModeSetting(2))
            const id = workspaceModes.connect("changed", () => apply(workspaceModes.getWorkspaceModeSetting(2)))
            return () => safeDisconnect(workspaceModes, id)
        },
        ui: {
            i18n: "settings.desktop.workspace-2",
            control: "segmented",
            optI18n: (v: string) => t(`settings.desktop.mode.${v}` as any),
        },
    })

    registerConfig("workspaces.workspace3Mode", {
        desc: "Window mode for workspace 3: 'default' (inherits default mode), 'floating', or 'tiling'.",
        type: "enum",
        enum: WORKSPACE_OVERRIDE_MODES,
        writable: true,
        get: () => workspaceModes.getWorkspaceModeSetting(3),
        set: v => workspaceModes.setWorkspaceMode(3, v as WorkspaceOverrideMode),
        subscribe: apply => {
            apply(workspaceModes.getWorkspaceModeSetting(3))
            const id = workspaceModes.connect("changed", () => apply(workspaceModes.getWorkspaceModeSetting(3)))
            return () => safeDisconnect(workspaceModes, id)
        },
        ui: {
            i18n: "settings.desktop.workspace-3",
            control: "segmented",
            optI18n: (v: string) => t(`settings.desktop.mode.${v}` as any),
        },
    })

    registerConfig("workspaces.workspace4Mode", {
        desc: "Window mode for workspace 4: 'default' (inherits default mode), 'floating', or 'tiling'.",
        type: "enum",
        enum: WORKSPACE_OVERRIDE_MODES,
        writable: true,
        get: () => workspaceModes.getWorkspaceModeSetting(4),
        set: v => workspaceModes.setWorkspaceMode(4, v as WorkspaceOverrideMode),
        subscribe: apply => {
            apply(workspaceModes.getWorkspaceModeSetting(4))
            const id = workspaceModes.connect("changed", () => apply(workspaceModes.getWorkspaceModeSetting(4)))
            return () => safeDisconnect(workspaceModes, id)
        },
        ui: {
            i18n: "settings.desktop.workspace-4",
            control: "segmented",
            optI18n: (v: string) => t(`settings.desktop.mode.${v}` as any),
        },
    })

    registerConfig("workspaces.workspace5Mode", {
        desc: "Window mode for workspace 5: 'default' (inherits default mode), 'floating', or 'tiling'.",
        type: "enum",
        enum: WORKSPACE_OVERRIDE_MODES,
        writable: true,
        get: () => workspaceModes.getWorkspaceModeSetting(5),
        set: v => workspaceModes.setWorkspaceMode(5, v as WorkspaceOverrideMode),
        subscribe: apply => {
            apply(workspaceModes.getWorkspaceModeSetting(5))
            const id = workspaceModes.connect("changed", () => apply(workspaceModes.getWorkspaceModeSetting(5)))
            return () => safeDisconnect(workspaceModes, id)
        },
        ui: {
            i18n: "settings.desktop.workspace-5",
            control: "segmented",
            optI18n: (v: string) => t(`settings.desktop.mode.${v}` as any),
        },
    })
}
