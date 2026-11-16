// move-window-probe.ts — `Compositor.moveWindowTo` (the bar pill's drag handle)
// must reach Hyprland as exactly one dispatch, with absolute pixels.
//
//   scripts/bundle.sh scripts/dev/move-window-probe.ts /tmp/move-window-probe
//   /tmp/move-window-probe
//
// The probe plants a fake `hyprctl` on PATH (it logs its argv, exits 0) and
// drives `createHyprlandState().moveWindowTo` against it — no Hyprland needed:
// without HYPRLAND_INSTANCE_SIGNATURE the state's socket reads fall back to
// empty, and the dispatch is the only thing that shells out.
//
// What it has to show, in order:
//   - the dispatch is `hl.dsp.window.move({ x, y, relative = false, window })`
//     (Hyprland wiki, Dispatchers: `move({ window?, x, y, relative? })`);
//   - the coordinates are ABSOLUTE pixels, not deltas (the booru-viewer
//     HYPRLAND.md gotcha: `move`/`resize` take absolute pixels despite
//     `relative` existing — the pill's arithmetic starts from the position the
//     drag started at, and this dispatch must not re-add anything);
//   - a `0x`-prefixed address is not double-prefixed;
//   - fractional pixels are rounded to integers before dispatch.
//
// ⚠️ Prove it can FAIL before believing a green run. The `--broken` control
// re-runs the SAME assertions against a wrong expectation (`relative = true`):
// it must FAIL. If it passes, the assertions are not reading the log.
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createHyprlandState } from "../../ui/shell/core/HyprlandState"

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
    if (ok) { pass++; print(`  ok — ${name}${detail ? ` (${detail})` : ""}`) }
    else { fail++; print(`  FAIL — ${name}${detail ? ` (${detail})` : ""}`) }
}

const BROKEN = ARGV.includes("--broken")

const dir = GLib.dir_make_tmp("move-window-probe-XXXXXX")!
const logPath = `${dir}/hyprctl.log`
const fake = `${dir}/hyprctl`
GLib.file_set_contents(fake,
    "#!/bin/sh\n" +
    "printf '%s\\n' \"$*\" >> \"" + logPath + "\"\n" +
    "exit 0\n")
Gio.File.new_for_path(fake).set_attribute_uint32("unix::mode", 0o755, Gio.FileQueryInfoFlags.NONE, null)
GLib.setenv("PATH", `${dir}:${GLib.getenv("PATH") ?? ""}`, true)

async function readLog(): Promise<string[]> {
    try {
        const [ok, bytes] = GLib.file_get_contents(logPath)
        if (!ok || !bytes) return []
        return new TextDecoder().decode(bytes).trim().split("\n").filter(l => l.length > 0)
    } catch { return [] }
}

async function main() {
    const state = createHyprlandState()
    await state.moveWindowTo("ab12", 100, 200)
    await state.moveWindowTo("0xab12", 100.6, 200.4)
    await state.moveWindowTo("ab12", -50, -20)
    const lines = await readLog()

    const expect = (x: number, y: number) =>
        `dispatch hl.dsp.window.move({ x = ${x}, y = ${y}, relative = false, window = 'address:0xab12' })`
    const want = [expect(100, 200), expect(101, 200), expect(-50, -20)]
    if (BROKEN) want[0] = want[0].replace("relative = false", "relative = true")

    check("three dispatches reached hyprctl", lines.length === 3, `${lines.length} logged`)
    want.forEach((w, i) => check(`dispatch ${i + 1} is exactly "${w}"`, lines[i] === w, lines[i] ?? "missing"))
    check("no dispatch carries a relative move", lines.every(l => !l.includes("relative = true")))
    check("no address is double-prefixed", lines.every(l => !l.includes("0x0x")))

    print(`move-window-probe — ${BROKEN ? "NEGATIVE CONTROL (wrong expectation)" : "moveWindowTo dispatch"}`)
    print(`PROBE-RESULT ${fail === 0 ? "ALL PASS" : "FAIL"} — ${pass} passed, ${fail} failed`)
}

const loop = new GLib.MainLoop(null, false)
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10_000, () => {
    print("PROBE-RESULT FAIL — timed out waiting for the dispatches")
    loop.quit()
    return GLib.SOURCE_REMOVE
})
main().then(() => loop.quit()).catch((e) => { print(`PROBE-RESULT FAIL — ${e}`); loop.quit() })
loop.run()
