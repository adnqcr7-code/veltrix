#!/usr/bin/env node
/*
 * process-name-check — every bundle's Linux process name fits in comm.
 *
 *   node scripts/ci/process-name-check.mjs [root]
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Linux's comm is 15 characters (16 bytes including NUL), and
 * `ui/lib/veltrix-kit/platform/process-name.ts` REJECTS anything longer —
 * it throws, by design, rather than truncate and make two processes share a
 * name. The throw happens in the kit host's `start()`, before `main()` runs,
 * so the process dies at startup and never opens a window.
 *
 * That is exactly what shipped in 1.3: the rename made Settings'
 * `processName` "veltrix-settings" — 16 characters ("masjid-settings" was
 * exactly 15) — so Settings died on launch on the Dell, and the shell's
 * dev-log watch reported it as `Invalid Linux process name: veltrix-settings`.
 * The other four bundles were 15 or fewer and kept working, which is why
 * only Settings was missing.
 *
 * So: the regex in process-name.ts is the single rule, and every
 * `processName: "…"` in every `ui/<bundle>/app.ts` must match it. A new bundle (or
 * a rename) that breaks the rule fails here, in CI, instead of on a user's
 * machine with a window that never opens.
 *
 * Control: run against a fixture tree with a 16-character processName and
 * the check must fail naming it:
 *
 *   node scripts/ci/process-name-check.mjs /tmp/pn-control
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const RULE_FILE = join(ROOT, "ui/lib/veltrix-kit/platform/process-name.ts")
const UI_DIR = join(ROOT, "ui")

let failed = false
const pass = (m) => console.log(`  ✓ ${m}`)
const error = (m) => { console.error(`  ✗ ${m}`); failed = true }

// ── 1. The rule, read from the source of truth ──────────────────────────────
let ruleSrc
try {
    ruleSrc = readFileSync(RULE_FILE, "utf8")
} catch {
    console.error(`process-name-check: cannot read ${RULE_FILE}.`)
    process.exit(1)
}
const ruleMatch = ruleSrc.match(/if \(!(\/[^/]+\/)\.test\(name\)\)/)
if (!ruleMatch) {
    console.error(`process-name-check: could not find the validation regex in ${RULE_FILE}.`)
    process.exit(1)
}
let rule
try {
    rule = eval(ruleMatch[1]) // the literal from the file, e.g. /^[a-z][a-z0-9-]{0,14}$/
} catch {
    console.error(`process-name-check: the regex in ${RULE_FILE} does not parse: ${ruleMatch[1]}`)
    process.exit(1)
}
if (!(rule instanceof RegExp)) {
    console.error(`process-name-check: expected a RegExp literal in ${RULE_FILE}, got ${ruleMatch[1]}.`)
    process.exit(1)
}

// ── 2. Every processName in every bundle entry ──────────────────────────────
const found = []
const scan = (dir) => {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const st = statSync(path)
        if (st.isDirectory()) {
            if (name === "node_modules" || name === "@girs" || name === "build") continue
            scan(path)
            continue
        }
        if (name !== "app.ts") continue
        const src = readFileSync(path, "utf8")
        const rel = path.slice(ROOT.length + 1)
        for (const m of src.matchAll(/processName:\s*"([^"]+)"/g)) {
            found.push({ file: rel, name: m[1] })
        }
    }
}
scan(UI_DIR)

if (found.length === 0) {
    console.error(`process-name-check: found no processName in ${UI_DIR} — the scan is broken, not clean.`)
    process.exit(1)
}

// ── 3. Each one must fit comm ───────────────────────────────────────────────
for (const { file, name } of found) {
    if (rule.test(name)) {
        pass(`${name} (${name.length} chars, ${file}) fits ${rule}`)
    } else {
        error(`${file}: processName "${name}" (${name.length} chars) does not match ${rule} — Linux comm is 15 chars, and setProcessName throws, so this bundle would die at startup.`)
    }
}

if (failed) process.exit(1)
console.log(`process-name-check: ${found.length} process name(s) OK.`)
