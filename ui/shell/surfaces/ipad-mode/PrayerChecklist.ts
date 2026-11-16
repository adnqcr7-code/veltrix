// Today's prayer checklist — the private "did I pray it" row on the
// iPad home screen.
//
// Five toggle chips, one per prayer. Tapping a chip marks that prayer
// as prayed TODAY; tapping again unmarks it. That is all it records:
//
//   · No streaks, no points, no leaderboards, no totals, no history.
//     Yesterday's record is overwritten when the date rolls over — the
//     file holds today only, so there is nothing to compare against.
//   · No auto-marking. A prayer whose time has passed, or whose lock
//     fired, is NOT checked for you: the check means "I prayed it", a
//     personal attestation, and the machine must never attest worship
//     on your behalf.
//   · Private by storage: one JSON file in the user's own data dir
//     (`~/.local/share/veltrix/prayer-checklist.json`), never synced,
//     never shown anywhere else. The row itself says "private, just for
//     you" so nobody mistakes it for a shared or scored thing.
//
// The widget is a plain row the iPad panel mounts under the widgets:
// "TODAY'S PRAYERS" + five chips + "N of 5 · private, just for you".
// It does not launch anything and it never shows a prayer time —
// times belong to the Next Prayer widget, which reads the helper.

import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { t } from "../../core/i18n"

export const PRAYER_CHECKLIST_ORDER = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const
export type ChecklistPrayer = (typeof PRAYER_CHECKLIST_ORDER)[number]

export interface ChecklistState {
    /** Local date the record belongs to, YYYY-MM-DD. */
    date: string
    /** Prayers marked as prayed today. */
    done: Partial<Record<ChecklistPrayer, boolean>>
}

function todayKey(date: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function statePath(): string {
    return GLib.build_filenamev([GLib.get_user_data_dir(), "veltrix", "prayer-checklist.json"])
}

/** Read today's record. A missing, corrupt or other-day file reads as empty. */
export function loadChecklist(date: Date = new Date()): ChecklistState {
    const today = todayKey(date)
    try {
        const [ok, bytes] = GLib.file_get_contents(statePath())
        if (!ok || !bytes) return { date: today, done: {} }
        const raw = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ChecklistState>
        if (raw?.date !== today || typeof raw?.done !== "object" || raw.done === null) {
            return { date: today, done: {} }
        }
        const done: Partial<Record<ChecklistPrayer, boolean>> = {}
        for (const name of PRAYER_CHECKLIST_ORDER) {
            if (raw.done[name] === true) done[name] = true
        }
        return { date: today, done }
    } catch {
        return { date: today, done: {} }
    }
}

function saveChecklist(state: ChecklistState): void {
    try {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), "veltrix"])
        GLib.mkdir_with_parents(dir, 0o700)
        // Explicit 0600, not the umask: this file is a personal worship
        // record on a possibly multi-user machine. file_set_contents_full
        // applies the mode only when creating the file, so chmod after
        // the write covers a file an older build created world-readable.
        GLib.file_set_contents_full(statePath(), JSON.stringify(state), GLib.FileSetContentsFlags.CONSISTENT, 0o600)
        GLib.chmod(statePath(), 0o600)
    } catch (e) {
        console.warn("[PrayerChecklist] could not save:", e)
    }
}

/** How many of today's five are marked. */
export function checklistCount(state: ChecklistState): number {
    return PRAYER_CHECKLIST_ORDER.filter(p => state.done[p]).length
}

/** Flip one prayer for today; returns the new state (already saved). */
export function toggleChecklist(state: ChecklistState, prayer: ChecklistPrayer): ChecklistState {
    // A row mounted before midnight carries YESTERDAY's record in `state`:
    // tapping a chip after the rollover without a refresh() in between
    // must not save yesterday's checks under today's date (Nov 14 sweep
    // #4). A stale record contributes nothing — today starts empty and
    // only the tapped prayer is marked. refresh() already re-reads, so
    // this is the no-refresh path: the tap itself is the first thing
    // that notices the day changed.
    const today = todayKey()
    const done = state.date === today ? { ...state.done } : {}
    if (done[prayer]) delete done[prayer]
    else done[prayer] = true
    const next = { date: today, done }
    saveChecklist(next)
    return next
}

/**
 * The checklist row: title + five toggle chips + the "N of 5 · private"
 * note. `onChange` fires after every tap with the new count, so the
 * panel can refresh anything that shows it (today: only this row).
 */
export function createPrayerChecklistBar(): { widget: Gtk.Widget; refresh: () => void } {
    let state = loadChecklist()

    const title = new Gtk.Label({
        label: t("ipad.checklist.title"),
        css_classes: ["ipad-checklist-title"],
        halign: Gtk.Align.START,
    })
    const chips = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 18,
        halign: Gtk.Align.CENTER,
        css_classes: ["ipad-checklist-chips"],
    })
    const note = new Gtk.Label({
        css_classes: ["ipad-checklist-note"],
        halign: Gtk.Align.END,
    })

    const chipButtons = new Map<ChecklistPrayer, Gtk.ToggleButton>()
    const chipMarks = new Map<ChecklistPrayer, Gtk.Label>()
    // Guard for programmatic sync (fix pass #1, code review §3.1): GTK
    // emits `toggled` when set_active() changes the state, so a bare
    // `chip.active = …` inside refresh() would run the handler below and
    // flip the prayer back to done AND SAVE it — resurrecting yesterday's
    // checks under today's date, the exact thing this file promises never
    // to do ("the machine must never attest worship on your behalf").
    // While `syncing` is true the handler is a no-op; refresh() updates
    // the mark labels itself, so nothing depends on the signal firing.
    let syncing = false
    for (const prayer of PRAYER_CHECKLIST_ORDER) {
        const name = t(`prayerlock.prayer.${prayer.toLowerCase()}` as any)
        const chip = new Gtk.ToggleButton({
            css_classes: ["ipad-checklist-chip"],
            active: state.done[prayer] === true,
        })
        const mark = new Gtk.Label({ label: state.done[prayer] ? "✓" : "○", css_classes: ["ipad-checklist-mark"] })
        const text = new Gtk.Label({ label: name, css_classes: ["ipad-checklist-name"] })
        const inner = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 })
        inner.append(mark)
        inner.append(text)
        chip.set_child(inner)
        chip.connect("toggled", () => {
            if (syncing) return
            state = toggleChecklist(state, prayer)
            mark.label = state.done[prayer] ? "✓" : "○"
            refreshNote()
        })
        chipButtons.set(prayer, chip)
        chipMarks.set(prayer, mark)
        chips.append(chip)
    }

    const refreshNote = () => {
        note.label = t("ipad.checklist.count")
            .replace("{done}", String(checklistCount(state)))
    }
    refreshNote()

    const refresh = () => {
        // A new day starts empty: re-read, do not carry yesterday over.
        // The syncing guard above is what makes this safe: without it,
        // setting a yesterday-checked chip inactive would fire `toggled`
        // and re-mark it done under today's date (code review §3.1).
        state = loadChecklist()
        syncing = true
        try {
            for (const [prayer, chip] of chipButtons) {
                const done = state.done[prayer] === true
                chip.active = done
                const mark = chipMarks.get(prayer)
                if (mark) mark.label = done ? "✓" : "○"
            }
        } finally {
            syncing = false
        }
        refreshNote()
    }

    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 24,
        halign: Gtk.Align.FILL,
        hexpand: true,
        css_classes: ["ipad-checklist"],
    })
    row.append(title)
    row.append(chips)
    row.append(note)
    return { widget: row, refresh }
}
