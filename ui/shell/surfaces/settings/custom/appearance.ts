import { runSettingsAction } from "../SettingsErrors"
import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Theme from "../../../core/ThemeManager"
import { VeltrixButton, VeltrixFontButton, VeltrixRow } from "../../../../lib/veltrix-kit"
import NightLight from "../../../core/NightLightManager"
import Wallpaper from "../../../core/WallpaperManager"
import { getBundledWallpapers } from "../../../../lib/wallpaper"
import { createSlantedWallpaperGallery } from "./SlantedWallpaperGallery"
import { t } from "../../../core/i18n"
import { createRow, bindWhileRealized } from "../SettingsHelpers"
import { safeDisconnect } from "../../../core/signals"
import type { PageCtx, ItemBuilder } from "../PreferencePage"

export const build = (ctx: PageCtx) => {
    const onTheme = <T,>(read: () => T) => (apply: (v: T) => void) => {
        apply(read())
        const id = Theme.connect("changed", () => apply(read()))
        return () => safeDisconnect(Theme, id)
    }

    // ── Wallpaper Preview ───────────────────────────────────────────────────
    const preview = new Gtk.Picture({
        width_request: 320,
        height_request: 180,
        content_fit: Gtk.ContentFit.COVER,
        css_classes: ["wallpaper-preview"],
        halign: Gtk.Align.CENTER,
    })
    const updatePreview = (path: string) => {
        if (!path) return
        Wallpaper.getThumbnailTexture(path, 640, 360).then(tex => {
            if (tex) preview.set_paintable(tex)
        })
    }
    updatePreview(Wallpaper.current)
    Wallpaper.refreshFromDaemon()

    const previewCenter = new Gtk.CenterBox({
        center_widget: preview,
        hexpand: true,
    })
    const previewRow = new Gtk.ListBoxRow({
        css_classes: ["veltrix-row", "wallpaper-preview-row"],
        activatable: false,
        selectable: false,
    })
    previewRow.set_child(previewCenter)

    // ── Bundled Wallpapers Gallery (slanted panels) ─────────────────────────
    // The picker shows the bundled wallpapers inside overlapping slanted
    // parallelogram frames — the shape language of the reference picker Adnan
    // sent (misty mountains / dark forest / white dune / hexagons inside the
    // same slanted frames). One Cairo-painted DrawingArea, not a row of
    // buttons: the panels overlap, so only a single widget with a
    // point-in-parallelogram hit test can tell which panel a click landed on.
    const bundled = getBundledWallpapers().filter(p => !p.includes("wallpaper-greeter"))
    let refreshThumbActive: ((currentPath: string) => void) | null = null
    let galleryRow: Gtk.ListBoxRow

    if (bundled.length > 0) {
        const gallery = createSlantedWallpaperGallery(bundled, Wallpaper.current, (wallPath) => {
            void runSettingsAction(() => Wallpaper.setWallpaper(wallPath))
            updatePreview(wallPath)
            if (refreshThumbActive) refreshThumbActive(wallPath)
        })

        refreshThumbActive = (currentPath: string) => gallery.refresh(currentPath)

        const centerBox = new Gtk.CenterBox({
            center_widget: gallery.widget,
            hexpand: true,
        })
        galleryRow = new Gtk.ListBoxRow({
            css_classes: ["veltrix-row", "wallpaper-gallery-row"],
            activatable: false,
            selectable: false,
        })
        galleryRow.set_child(centerBox)
    } else {
        galleryRow = new Gtk.ListBoxRow({
            css_classes: ["veltrix-row", "wallpaper-gallery-row"],
            activatable: false,
            selectable: false,
            visible: false,
        })
    }

    // ── Wallpaper File Picker ───────────────────────────────────────────────
    const changeBtn = VeltrixButton({
        label: t("settings.appearance.browse"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    changeBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({
            title: t("settings.appearance.dialog.wallpaper"),
            modal: true,
        })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg")
        filter.add_mime_type("image/png")
        filter.add_mime_type("image/gif")
        filter.add_mime_type("image/webp")
        filter.add_mime_type("image/avif")
        filter.set_name(t("settings.appearance.filter.images"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        dialog.set_filters(filters)

        dialog.set_initial_folder(Gio.File.new_for_path(GLib.get_home_dir()))

        // Parent the dialog to the Settings window so it opens modal/centered over
        // it (like the font picker) instead of as an unparented, tiled toplevel.
        dialog.open(changeBtn.get_root() as Gtk.Window, null, (_: any, result: any) => {
            try {
                const file = dialog.open_finish(result)
                const path = file?.get_path()
                if (path) {
                    void runSettingsAction(() => Wallpaper.setWallpaper(path))
                    updatePreview(path)
                }
            } catch (_) { /* user cancelled */ }
        })
    })

    // Unconditionally follow wallpaper changes from external tools.
    // Use bindWhileRealized because Settings hides rather than destroys its window.
    bindWhileRealized(ctx.page, () => {
        updatePreview(Wallpaper.current)
        if (refreshThumbActive) refreshThumbActive(Wallpaper.current)
        const wallId = Wallpaper.connect("changed", () => {
            updatePreview(Wallpaper.current)
            if (refreshThumbActive) refreshThumbActive(Wallpaper.current)
        })
        return () => safeDisconnect(Wallpaper, wallId)
    })

    // ── Accent Color Picker ─────────────────────────────────────────────────
    // REMOVED (cyan-only, owner decision 2026-11-12): cyan #00E5FF is the only
    // accent and the picker is gone entirely — no swatches, no slot. The accent
    // itself still comes from Theme (always cyan); see core/ThemeManager.

    // ── Night Light Schedule Times ──────────────────────────────────────────
    const timePicker = (initial: string, onChange: (t: string) => void) => {
        const [ih, im] = initial.split(":").map(Number)
        const safeH = isNaN(ih) ? 20 : Math.max(0, Math.min(23, ih))
        const safeM = isNaN(im) ? 0  : Math.max(0, Math.min(59, im))

        const makeSpin = (lo: number, hi: number, val: number) => {
            const spin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({ lower: lo, upper: hi, step_increment: 1, value: val }),
                width_chars: 2, wrap: true, numeric: true, digits: 0,
                valign: Gtk.Align.CENTER,
                css_classes: ["time-spin"],
            })
            spin.connect("output", () => {
                spin.set_text(String(Math.round(spin.value)).padStart(2, "0"))
                return true
            })
            return spin
        }

        const hSpin = makeSpin(0, 23, safeH)
        const mSpin = makeSpin(0, 59, safeM)

        let syncing = false
        const emit = () => {
            if (syncing) return
            const h = String(Math.round(hSpin.value)).padStart(2, "0")
            const m = String(Math.round(mSpin.value)).padStart(2, "0")
            onChange(`${h}:${m}`)
        }
        hSpin.connect("value-changed", emit)
        mSpin.connect("value-changed", emit)

        const box = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER })
        box.append(hSpin)
        box.append(new Gtk.Label({ label: ":", css_classes: ["veltrix-row-subtitle"] }))
        box.append(mSpin)
        const sync = (time: string) => {
            const [h, m] = time.split(":").map(Number)
            if (isNaN(h) || isNaN(m)) return
            syncing = true
            hSpin.value = h
            mSpin.value = m
            syncing = false
        }
        return { box, sync }
    }

    const schedTimeBox = new Gtk.Box({ spacing: 24, valign: Gtk.Align.CENTER })

    const from = timePicker(NightLight.scheduleFrom, (v) => NightLight.setScheduleFrom(v))
    const to   = timePicker(NightLight.scheduleTo,   (v) => NightLight.setScheduleTo(v))

    const fromBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    fromBox.append(new Gtk.Label({ label: t("settings.appearance.night-light-from"), halign: Gtk.Align.START, css_classes: ["veltrix-row-subtitle"] }))
    fromBox.append(from.box)

    const toBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    toBox.append(new Gtk.Label({ label: t("settings.appearance.night-light-to"), halign: Gtk.Align.START, css_classes: ["veltrix-row-subtitle"] }))
    toBox.append(to.box)

    schedTimeBox.append(fromBox)
    schedTimeBox.append(toBox)

    const schedTimeRow = VeltrixRow("", "", schedTimeBox)

    const syncNightLightTimes = () => {
        from.sync(NightLight.scheduleFrom)
        to.sync(NightLight.scheduleTo)
    }
    bindWhileRealized(ctx.page, () => {
        syncNightLightTimes()
        const nlChangedId = NightLight.connect("changed", syncNightLightTimes)
        return () => safeDisconnect(NightLight, nlChangedId)
    })

    // ── Fonts ───────────────────────────────────────────────────────────────
    // Inside VeltrixFontButton, title is used in the font picker modal dialog.
    // The row label and subtitle are rendered via createRow from slot.title/slot.subtitle.
    const makeInterfaceFontBtn = (title: string) => VeltrixFontButton({
        font: Theme.interfaceFont,
        title,
        onFontSet: (f) => Theme.setFont(f),
        onExtChange: onTheme(() => Theme.interfaceFont),
    })

    const makeMonoFontBtn = (title: string) => VeltrixFontButton({
        font: Theme.monoFont,
        title,
        onFontSet: (f) => Theme.setMonoFont(f),
        onExtChange: onTheme(() => Theme.monoFont),
    })

    return {
        wallpaperPreview: () => previewRow,
        wallpaperGallery: () => galleryRow,
        wallpaperPicker: (slot) => createRow(slot.title, slot.subtitle, changeBtn),
        nightScheduleTimes: () => schedTimeRow,
        interfaceFont: (slot) => createRow(slot.title, slot.subtitle, makeInterfaceFontBtn(slot.title)),
        monoFont: (slot) => createRow(slot.title, slot.subtitle, makeMonoFontBtn(slot.title)),
    } satisfies Record<string, ItemBuilder>
}
