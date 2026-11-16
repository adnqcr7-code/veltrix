// dock-restore-probe — a dock click restores the LONGEST-hidden window
// (Nov 14 sweep #7).
//
//   scripts/bundle.sh scripts/dev/dock-restore-probe.ts /tmp/dock-restore-probe
//   /tmp/dock-restore-probe                      # under gjs, like the other probes
//
// Or under plain node (the module under test has no imports):
//   npx esbuild --bundle scripts/dev/dock-restore-probe.ts --format=esm \
//     --platform=node --outfile=/tmp/dock-restore-probe.mjs && node /tmp/dock-restore-probe.mjs
//
// The trap: hide A, then B. Click restores the most recently hidden (B);
// B is now shown and focused, so the next click HIDES it again
// (click-to-minimize); the click after that restores the most recently
// hidden — B again. A is never restored: the click oscillates on the
// newest window forever. Longest-hidden-first breaks it: hide A, B, C
// and the clicks restore A, then B, then C, then A again — every hidden
// window is reachable. The single-hidden-window case is unchanged.
//
// The cycle simulation below mirrors DockItem exactly: a hide order map
// that hands out increasing sequence numbers, `pickRestoreTarget` for the
// pick, and the entry deleted on restore — and it ALSO proves the OLD
// pick (largest order first) traps on B, so the probe fails on the old
// code rather than passing on anything.

import { pickRestoreTarget } from "../../ui/shell/surfaces/dock/restore-order"

// `print` is the GJS global; under node it does not exist.
const print = (globalThis as any).print ?? ((...a: unknown[]) => console.log(...a))

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
    print(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`)
    if (!cond) failures++
}

type W = { address: string }

const orderOf = (order: Map<string, number>) => (c: W) => order.get(c.address) ?? 0
const A: W = { address: "A" }
const B: W = { address: "B" }
const C: W = { address: "C" }

check("empty hidden list restores nothing",
    pickRestoreTarget([], orderOf(new Map())) === undefined)
check("single hidden window is restored",
    pickRestoreTarget([A], orderOf(new Map([["A", 1]]))) === A)
check("longest-hidden first, not most-recently-hidden",
    pickRestoreTarget([A, B], orderOf(new Map([["A", 1], ["B", 2]]))) === A)
check("array order does not matter, hide order does",
    pickRestoreTarget([B, A], orderOf(new Map([["A", 1], ["B", 2]]))) === A)
check("a tie keeps the earliest in the array",
    pickRestoreTarget([A, B], orderOf(new Map([["A", 1], ["B", 1]]))) === A)

// Full-cycle simulation: hide A, B, C, then click repeatedly. Each click
// restores the pick and the next click hides it again (it is focused), so
// the restored window gets a FRESH, higher hide order — exactly the trap
// the old pick fell into. The fixed pick must visit A, B, C, then A.
{
    const order = new Map<string, number>()
    let seq = 0
    const hide = (w: W) => order.set(w.address, ++seq)
    const hidden = [A, B, C]
    hide(A); hide(B); hide(C)
    const restored: string[] = []
    for (let i = 0; i < 4; i++) {
        const pick = pickRestoreTarget(hidden, orderOf(order))!
        restored.push(pick.address)
        order.delete(pick.address) // restoreAppWindow deletes the entry
        hide(pick)                 // the next click hides it again (focused)
    }
    check("clicks cycle through every hidden window", restored.join(",") === "A,B,C,A", restored.join(","))
}

// Control: the OLD pick (largest order first) on the same simulation
// restores B, then B again — the reported oscillation.
{
    const order = new Map<string, number>()
    let seq = 0
    const hide = (w: W) => order.set(w.address, ++seq)
    const hidden = [A, B]
    hide(A); hide(B)
    const oldPick = (list: W[]) =>
        [...list].sort((a, b) => (order.get(b.address) ?? 0) - (order.get(a.address) ?? 0))[0]
    const restored: string[] = []
    for (let i = 0; i < 3; i++) {
        const pick = oldPick(hidden)!
        restored.push(pick.address)
        order.delete(pick.address)
        hide(pick)
    }
    check("control: old pick oscillates on the newest", restored.join(",") === "B,B,B", restored.join(","))
}

print(failures === 0 ? "TEST: ALL PASSED" : `TEST: ${failures} FAILURE(S)`)
