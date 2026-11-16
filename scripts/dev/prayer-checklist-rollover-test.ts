// Dev-only regression test — NOT shipped, no bundle references this file.
//
// Day-rollover test for the prayer checklist (code review §3.1, fix
// pass #1): GTK emits `toggled` when set_active() changes a chip, so
// a bare `chip.active = …` inside refresh() used to run the toggle
// handler and resurrect yesterday's checks under today's date. The
// fix is the `syncing` guard in PrayerChecklist.ts; this test proves
// it against the real widget.
//
// The bug needs a LONG-LIVED panel: the chips must be checked (from
// yesterday's taps) when the day rolls over and refresh() re-reads an
// empty today. A fresh construction starts with inactive chips, so
// the test builds that state explicitly:
//
//   1. Build the real checklist bar; check Fajr + Isha through
//      set_active(true) — the same `toggled` signal a real tap
//      delivers — and assert the file holds today with both.
//   2. Overwrite the file directly with YESTERDAY's record
//      ({date: yesterday, done: {Fajr, Isha}}) — this is the day
//      rolling over while the panel object lives on.
//   3. Call refresh() (today's date) and assert the file on disk is
//      byte-identical to the yesterday seed — refresh() must not
//      write anything — and every chip is inactive with a hollow mark.
//      WITHOUT the guard, step 3 flips Fajr and Isha back to done
//      and SAVES them under today's date (verified: the test FAILS
//      on a guard-less build — see the fix report).
//   4. Positive control: flip one chip (set_active, the same signal
//      a tap delivers) and assert the file now holds TODAY with only
//      that prayer done, written mode 0600 (F11).
//
// Run under Xvfb with gjs -m, bundled like the other dev harnesses
// (scripts/bundle.sh --kit-external=ui/lib/veltrix-kit/build/js):
//
//   XDG_DATA_HOME=/tmp/checklist-test-data XDG_RUNTIME_DIR=/tmp \
//   DISPLAY=:99 gjs -m /tmp/prayer-checklist-rollover-test.js
//
// Exit code is read from the final line (ALL PASSED vs FAILURE(S)):
// gjs -m has no portable ESM exit() here, so the wrapper greps it.
// XDG_DATA_HOME must point at an empty temp dir: the test writes the
// seed file there and reads it back.

import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

const pad = (n: number) => String(n).padStart(2, "0")
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = new Date()
const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
    print(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`)
    if (!cond) failures++
}

const app = new Gtk.Application({ application_id: "org.veltrix.checklist-rollover-test" })
app.connect("activate", async () => {
    const win = new Gtk.ApplicationWindow({ application: app })
    win.set_default_size(800, 200)
    win.present()
    const { createPrayerChecklistBar, toggleChecklist } = await import("../../ui/shell/surfaces/ipad-mode/PrayerChecklist")

    const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), "veltrix"])
    GLib.mkdir_with_parents(dataDir, 0o700)
    const statePath = GLib.build_filenamev([dataDir, "prayer-checklist.json"])
    const readFile = (): string => {
        const [ok, bytes] = GLib.file_get_contents(statePath)
        return ok && bytes ? new TextDecoder().decode(bytes) : "<unreadable>"
    }
    // Find the five toggle buttons: the row is title label, chips box,
    // note label; the chips box holds the toggle buttons in order.
    const findChips = (bar: { widget: Gtk.Widget }): Gtk.ToggleButton[] => {
        const row = bar.widget as Gtk.Box
        let chipsBox: Gtk.Box | null = null
        for (let c = row.get_first_child(); c; c = c.get_next_sibling()) {
            if (c instanceof Gtk.Box && c !== row) chipsBox = c as Gtk.Box
        }
        const chips: Gtk.ToggleButton[] = []
        if (chipsBox) {
            for (let c = chipsBox.get_first_child(); c; c = c.get_next_sibling()) {
                if (c instanceof Gtk.ToggleButton) chips.push(c as Gtk.ToggleButton)
            }
        }
        return chips
    }
    const markOf = (chip: Gtk.ToggleButton): string => {
        const inner = chip.get_child() as Gtk.Box | null
        const mark = inner?.get_first_child() as Gtk.Label | null
        return mark?.label ?? "?"
    }

    const bar = createPrayerChecklistBar()
    win.set_child(bar.widget)
    const chips = findChips(bar)
    check("five chips present", chips.length === 5, `found ${chips.length}`)

    // Phase 1 — yesterday's taps, in the live panel: check Fajr + Isha
    // the way a user does (the `toggled` signal), and confirm the file.
    chips[0].set_active(true)
    chips[4].set_active(true)
    const afterTaps = readFile()
    check("setup writes today with Fajr+Isha", afterTaps === JSON.stringify({ date: key(today), done: { Fajr: true, Isha: true } }), afterTaps)

    // Phase 2 — the day rolls over while the panel lives on: the file
    // now says yesterday, the chips are still checked from "yesterday".
    const seed = JSON.stringify({ date: key(yesterday), done: { Fajr: true, Isha: true } })
    GLib.file_set_contents(statePath, seed)
    print(`TEST: rolled over to ${key(today)}; file now yesterday: ${seed}`)

    // The bug: refresh() re-reads (today = empty), sets the checked
    // chips inactive, each `toggled` re-marks it done and SAVES.
    bar.refresh()

    check("refresh() does not rewrite the file", readFile() === seed, `file now: ${readFile()}`)
    chips.forEach((chip, i) => {
        check(`chip ${i + 1} inactive after rollover`, !chip.active)
        check(`chip ${i + 1} mark hollow after rollover`, markOf(chip) === "○", `mark: ${markOf(chip)}`)
    })

    // Phase 3 — positive control: a real tap after the rollover must
    // mark exactly that prayer TODAY, written mode 0600 (F11).
    chips[0].set_active(true)
    const afterTap = readFile()
    const parsed = JSON.parse(afterTap) as { date: string; done: Record<string, boolean> }
    check("tap writes today's date", parsed.date === key(today), `date: ${parsed.date}`)
    check("tap marks exactly one prayer", Object.keys(parsed.done).length === 1 && parsed.done.Fajr === true, afterTap)
    const info = Gio.File.new_for_path(statePath).query_info("unix::mode", Gio.FileQueryInfoFlags.NONE, null)
    check("checklist file is mode 0600", (info.get_attribute_uint32("unix::mode") & 0o777) === 0o600, `mode: ${(info.get_attribute_uint32("unix::mode") & 0o777).toString(8)}`)

    // Phase 4 — the NO-refresh tap (Nov 14 sweep #4): the panel was
    // mounted yesterday and never refreshed, so its state still holds
    // yesterday's record when the user taps after midnight. The tap
    // itself is the first thing that notices the day changed: today
    // starts empty and only the tapped prayer is marked. WITHOUT the
    // date guard in toggleChecklist, this saves yesterday's Fajr+Isha
    // under today's date alongside Dhuhr.
    const stale = { date: key(yesterday), done: { Fajr: true, Isha: true } }
    const afterStaleTap = toggleChecklist(stale as any, "Dhuhr")
    check("stale tap writes today's date", afterStaleTap.date === key(today), `date: ${afterStaleTap.date}`)
    check("stale tap drops yesterday's checks",
        Object.keys(afterStaleTap.done).length === 1 && (afterStaleTap.done as any).Dhuhr === true,
        JSON.stringify(afterStaleTap))
    const afterStaleFile = JSON.parse(readFile()) as { date: string; done: Record<string, boolean> }
    check("stale tap file holds today with only Dhuhr",
        afterStaleFile.date === key(today) && Object.keys(afterStaleFile.done).length === 1 && afterStaleFile.done.Dhuhr === true,
        readFile())

    // Phase 5 — the guard must not change the normal path: a tap with a
    // current-date state keeps the other checks.
    const fresh = { date: key(today), done: { Fajr: true } }
    const afterFreshTap = toggleChecklist(fresh as any, "Dhuhr")
    check("fresh tap keeps today's other checks",
        afterFreshTap.date === key(today) && (afterFreshTap.done as any).Fajr === true && (afterFreshTap.done as any).Dhuhr === true,
        JSON.stringify(afterFreshTap))

    print(failures === 0 ? "TEST: ALL PASSED" : `TEST: ${failures} FAILURE(S)`)
    // Exit code: gjs -m has no portable ESM exit() here, so the wrapper
    // greps the line above (ALL PASSED vs FAILURE(S)) for its exit code.
    app.quit()
})
app.run([])
