import { isSettingsProcess, settingsShellRequest } from "./SettingsProcess"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import compositor, { settings, type MonitorSetting } from "./CompositorState"

/**
 * The Display page's state: per monitor scale, rotation and mode, and the VRR choice — on
 * either compositor, through `settings` (CompositorState.ts). A change is applied live and
 * persisted in the compositor's own layer (`veltrix-monitor.lua` on Hyprland,
 * `hyalo-settings.toml` on Hyalo); a mode or a rotation is applied WITHOUT persisting until
 * the user confirms it (`commit`), so a mode the monitor cannot show is reverted before it
 * reaches the file.
 *
 * Mirroring is Hyprland-only (`mirror = "eDP-1"` on the output that shows another's
 * content); Hyalo has no mirror field and drops it. The mirror lives in the same
 * MonitorSetting as the rest, so a save never drops it — but the live monitor list
 * carries no mirror, so it is re-read from the persisted file (see _loadPersistedMirror)
 * instead of being rebuilt from the live list.
 *
 * VRR is read SYNCHRONOUSLY: `init()` is called with the monitor list and callers read
 * `.vrr` immediately after, so an async read would report "off" for a frame and the
 * Settings row would render the wrong state.
 */
class MonitorConfig extends GObject.Object {
    static {
        GObject.registerClass({ GTypeName: "MonitorConfigManager" }, this)
    }

    private state: Map<string, MonitorSetting> = new Map()
    private _vrr = 0
    private previews = new Map<string, string>()
    // Which output each monitor mirrors (Hyprland only). Kept apart from `state` so
    // `init()` — which rebuilds state from the live monitor list, where no mirror
    // exists — cannot clear it, and so the shell-side Settings handler (which has
    // no Display page and never calls init) still preserves mirrors in its saves.
    private _mirror = new Map<string, string>()
    private _mirrorLoaded = false

    /** Read the mirror choices back from the persisted file, once. The generated
     *  lines are ours (`hl.monitor({ output = "X", ..., mirror = "Y" })`), so a
     *  line-shaped match is enough; a hand-edited file keeps its mirror as long as
     *  it keeps that shape. Missing file = fresh install = no mirrors. */
    private _loadPersistedMirror() {
        if (this._mirrorLoaded) return
        this._mirrorLoaded = true
        try {
            const path = GLib.build_filenamev([GLib.get_home_dir(), ".config", "veltrix", "veltrix-monitor.lua"])
            const [ok, bytes] = GLib.file_get_contents(path)
            if (!ok) return
            const text = new TextDecoder().decode(bytes)
            for (const m of text.matchAll(/hl\.monitor\(\{\s*output\s*=\s*"([^"]+)"[^}]*?mirror\s*=\s*"([^"]+)"/g))
                this._mirror.set(m[1], m[2])
        } catch (e) { /* unreadable: treat as no mirrors */ }
    }

    getMirror(name: string) { this._loadPersistedMirror(); return this._mirror.get(name) }

    /** Record a mirror choice without applying it — the shell-side Settings handler
     *  owns the apply+save, this only keeps the map (and so every later snapshot)
     *  in sync with what was just written. */
    noteMirror(name: string, source?: string) {
        this._loadPersistedMirror()
        if (source) this._mirror.set(name, source)
        else this._mirror.delete(name)
    }

    constructor() {
        super()
        // Re-read the effective VRR when the compositor reloads its config (the user edited
        // their own file). Otherwise the next save would persist our stale value over it.
        compositor.connect("config-reloaded", () => { this._vrr = settings.readVrr(this._vrr) })
    }

    /** Call once with the monitor list (core/Displays.ts). */
    init(monitors: Array<{ name: string; scale?: number; transform?: number; vrr?: number }>) {
        this._loadPersistedMirror()
        this.state.clear()
        for (const mon of monitors) {
            const cfg: MonitorSetting = {
                scale: Math.round((mon.scale ?? 1.0) * 100) / 100,
                transform: mon.transform ?? 0,
            }
            const mirror = this._mirror.get(mon.name)
            if (mirror) cfg.mirror = mirror
            this.state.set(mon.name, cfg)
        }
        // The compositor's own value, not a monitor's flag: on Hyprland VRR is one global
        // (0 off, 1 always, 2 fullscreen only); on Hyalo it is per output, and "on" when any is.
        this._vrr = settings.readVrr(this._vrr)
    }

    getScale(name: string) { return this.state.get(name)?.scale ?? 1.0 }
    getTransform(name: string) { return this.state.get(name)?.transform ?? 0 }
    getMode(name: string) { return this.state.get(name)?.mode }
    get vrr() { return this._vrr }

    private _apply(name: string, cfg: MonitorSetting) {
        settings.applyMonitor(name, cfg)
    }

    async setScale(name: string, scale: number) {
        if (isSettingsProcess) {
            await settingsShellRequest(["settingsMonitor", "scale", name, String(scale)])
            const cfg = this.state.get(name) ?? { scale: 1, transform: 0 }
            cfg.scale = scale; this.state.set(name, cfg); return
        }
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.scale = scale
        this.state.set(name, cfg)
        this._apply(name, cfg)
        this._save()
    }

    setTransform(name: string, transform: number) {
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.transform = transform
        this.state.set(name, cfg)
        this._apply(name, cfg)
        this._save()
    }

    /** Apply a resolution/refresh mode WITHOUT persisting — pair with commit() once
     *  the user confirms (so a bad mode can be reverted before it reaches the file). */
    async applyMode(name: string, mode: string) {
        if (isSettingsProcess) {
            const token = await settingsShellRequest(["settingsMonitor", "mode", name, mode])
            this.previews.set(name, token)
            const cfg = this.state.get(name) ?? { scale: 1, transform: 0 }
            cfg.mode = mode; this.state.set(name, cfg); return
        }
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.mode = mode
        this.state.set(name, cfg)
        this._apply(name, cfg)
    }

    /** Apply a rotation WITHOUT persisting — pair with commit() (revert-safe). */
    async applyTransform(name: string, transform: number) {
        if (isSettingsProcess) {
            const token = await settingsShellRequest(["settingsMonitor", "transform", name, String(transform)])
            this.previews.set(name, token)
            const cfg = this.state.get(name) ?? { scale: 1, transform: 0 }
            cfg.transform = transform; this.state.set(name, cfg); return
        }
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        cfg.transform = transform
        this.state.set(name, cfg)
        this._apply(name, cfg)
    }

    /** Persist what is applied now (the confirm half of applyMode/applyTransform). */
    async commit(output?: string) {
        if (!isSettingsProcess) { this._save(); return }
        if (!output) throw Error("Confirm one display preview at a time")
        const token = this.previews.get(output)
        if (!token) throw Error("Display preview is no longer pending")
        await settingsShellRequest(["settingsMonitor", "commit", token])
        this.previews.delete(output)
    }

    async revert(name: string) {
        const token = this.previews.get(name)
        if (!token) return
        try { await settingsShellRequest(["settingsMonitor", "revert", token]) }
        catch (e) { if (!String(e).includes("expired")) throw e }
        finally { this.previews.delete(name) }
    }

    async setVrr(val: number) {
        if (isSettingsProcess) {
            await settingsShellRequest(["settingsMonitor", "vrr", "all", String(val)])
            this._vrr = val; return
        }
        this._vrr = val
        settings.applyVrr(val)
        this._save()
    }

    /** Mirror this output onto another monitor's content, live + persisted.
     *  Pass null to go back to extending. Hyprland only — Hyalo drops the field. */
    async setMirror(name: string, source: string | null) {
        this._loadPersistedMirror()
        if (isSettingsProcess) {
            await settingsShellRequest(["settingsMonitor", "mirror", name, source ?? ""])
            const cfg = this.state.get(name) ?? { scale: 1, transform: 0 }
            if (source) { cfg.mirror = source; this._mirror.set(name, source) }
            else { delete cfg.mirror; this._mirror.delete(name) }
            this.state.set(name, cfg); return
        }
        const cfg = this.state.get(name) ?? { scale: 1.0, transform: 0 }
        if (source) { cfg.mirror = source; this._mirror.set(name, source) }
        else { delete cfg.mirror; this._mirror.delete(name) }
        this.state.set(name, cfg)
        this._apply(name, cfg)
        this._save()
    }

    private _save() {
        settings.saveMonitors(this.state, this._vrr)
    }
}

const monitorConfig = new MonitorConfig()
export default monitorConfig
