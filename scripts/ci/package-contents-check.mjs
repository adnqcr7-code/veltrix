#!/usr/bin/env node
/*
 * package-contents-check — every helper the UI invokes is actually installed.
 *
 *   node scripts/ci/package-contents-check.mjs
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Content Safety shipped with its privileged helper `bin/veltrix-content-safety`
 * copied by install.sh (the dev path) but MISSING from the PKGBUILD's /usr/bin
 * loop — the only other content-safety line in the PKGBUILD was the blocklist.
 * On a packaged install every `pkexec veltrix-content-safety …` call failed
 * (exit 127), the Safety page footer permanently read "Could not check what
 * is blocked", and the feature was dead on the path users actually install
 * from. The build report even claimed the helper was "in the /usr/bin loop",
 * and nobody re-checked it — because nothing checked it.
 *
 * So this checks, mechanically, from the tree (no makepkg, no Arch):
 *
 *   1. every `bin/veltrix-*` helper that any file under ui/, bin/ or config/
 *      references by name is installed by the PKGBUILD (the /usr/bin loop
 *      or an explicit `install … $pkgdir/usr/bin/<name>` line) AND by
 *      install.sh (the dev path);
 *   2. every name in the PKGBUILD /usr/bin loop exists as a file in bin/
 *      (a typo there would install nothing, silently);
 *   3. the Content Safety blocklist and the polkit policy are installed by
 *      BOTH paths (a helper without its data file, or without its prompt
 *      text, is broken in the same silent way).
 *
 * The reference scan is deliberately narrow: it looks for the helper's name
 * as a word in text files, skipping build output, node_modules and the
 * helper's own file. A name referenced only in docs does not count as
 * "invoked" — the corpus is code and config, not prose. Files the package
 * installs from build output (veltrix-ipc, veltrix-input, the native hosts)
 * are covered by rule 1 through their explicit install lines.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, relative } from "node:path"

let failed = false
const log = (s) => console.log(s)
const pass = (s) => log(`  ✓ ${s}`)
const error = (s) => { failed = true; log(`  ✗ ${s}`) }

// ── 1. The installed sets ───────────────────────────────────────────────────
const pkgbuild = readFileSync("packaging/veltrix/PKGBUILD", "utf8")
const installSh = readFileSync("install.sh", "utf8")

// The /usr/bin loop: `for b in veltrix veltrix-ui … veltrix-weather; do` —
// possibly wrapped over several lines, ending at the `; do`.
const loop = pkgbuild.match(/for b in ([\s\S]*?); do/)
if (!loop) {
    log("package-contents-check: could not find the /usr/bin loop in the PKGBUILD")
    process.exit(1)
}
// The loop wraps over lines ending in `\` — those are continuations, not names.
const loopNames = new Set(loop[1].replace(/\\/g, " ").split(/\s+/).filter(Boolean))

// Explicit `install … "$pkgdir/usr/bin/<name>"` lines (veltrix-ipc,
// veltrix-input, the native hosts are not in the loop).
const explicitPkg = new Set(
    [...pkgbuild.matchAll(/"\$pkgdir\/usr\/bin\/([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]),
)
const pkgInstalled = new Set([...loopNames, ...explicitPkg])

// install.sh: `cp … /usr/bin/<name>` and `install … /usr/bin/<name>` —
// matched on the COMMAND, not on any mention (N4, fix pass #2): a helper
// named only in a `chmod +x` line, a comment, or a `bash /usr/bin/…`
// invocation is not installed by install.sh. `install -Dm644 …
// /usr/share/polkit-1/actions/…` lines carry no /usr/bin target and
// never match.
const devInstalled = new Set(
    installSh.split("\n")
        .filter((line) => /^\s*(sudo\s+)?(cp|install)\b/.test(line))
        .flatMap((line) => [...line.matchAll(/\/usr\/bin\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1])),
)

// ── 2. Which helpers are referenced ─────────────────────────────────────────
const BIN_DIR = "bin"
// Executable helpers only: bin/ also holds .service units and .c sources,
// which are not /usr/bin programs and are installed (or compiled) elsewhere.
const helpers = readdirSync(BIN_DIR)
    .filter((f) => f.startsWith("veltrix-")
        && statSync(join(BIN_DIR, f)).isFile()
        && (statSync(join(BIN_DIR, f)).mode & 0o111) !== 0)

// Package-only by design, not a gap: the Hyalo session launcher. Dev
// installs run Hyprland (Hyalo is a preview until #685), so install.sh
// never installs it — but the packaged wayland session names it, so the
// PKGBUILD must.
const PACKAGE_ONLY = new Set(["veltrix-hyalo-session"])

const CORPUS_DIRS = ["ui/shell", "ui/settings", "ui/greeter", "ui/lockscreen", "ui/installer", "ui/lib", "bin", "config"]
const SKIP_DIRS = new Set(["build", "node_modules", ".git", "__pycache__"])
const TEXT_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".sh", ".py", ".json", ".desktop", ".install", ""])

function* textFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            yield* textFiles(join(dir, entry.name))
            continue
        }
        const name = entry.name
        const dot = name.lastIndexOf(".")
        const ext = dot === -1 ? "" : name.slice(dot)
        if (!TEXT_EXTS.has(ext) && !name.startsWith("veltrix-")) continue
        yield join(dir, name)
    }
}

const corpus = []
for (const dir of CORPUS_DIRS) {
    if (!existsSync(dir)) continue
    for (const file of textFiles(dir)) corpus.push(file)
}

const referenced = new Map() // helper -> first file that references it
for (const helper of helpers) {
    const re = new RegExp(`\\b${helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
    for (const file of corpus) {
        if (file === join(BIN_DIR, helper)) continue
        let text
        try {
            text = readFileSync(file, "utf8")
        } catch {
            continue
        }
        if (re.test(text)) {
            referenced.set(helper, file)
            break
        }
    }
}

// ── 3. Assertions ──────────────────────────────────────────────────────────
for (const helper of [...referenced.keys()].sort()) {
    const from = relative(".", referenced.get(helper))
    if (!pkgInstalled.has(helper)) {
        error(`${helper} is referenced by ${from} but NOT installed by the PKGBUILD`)
    } else if (!devInstalled.has(helper) && !PACKAGE_ONLY.has(helper)) {
        error(`${helper} is referenced by ${from} but NOT installed by install.sh`)
    } else if (PACKAGE_ONLY.has(helper)) {
        pass(`${helper} is installed by the PKGBUILD only, by design (referenced by ${from})`)
    } else {
        pass(`${helper} is installed by both paths (referenced by ${from})`)
    }
}
if (referenced.has("veltrix-content-safety")) {
    if (loopNames.has("veltrix-content-safety")) {
        pass("veltrix-content-safety is in the PKGBUILD /usr/bin loop (the M1 regression)")
    } else if (explicitPkg.has("veltrix-content-safety")) {
        error("veltrix-content-safety is installed only by an explicit line, not the /usr/bin loop")
    } else {
        // N4: say what was actually found — the old line claimed an
        // explicit line existed even when the helper was installed by
        // neither path.
        error("veltrix-content-safety is referenced but NOT installed by the PKGBUILD at all (neither the /usr/bin loop nor an explicit line)")
    }
} else {
    error("veltrix-content-safety is not referenced anywhere — the scan is broken, not clean")
}

for (const name of [...loopNames].sort()) {
    if (!existsSync(join(BIN_DIR, name))) {
        error(`PKGBUILD /usr/bin loop names ${name}, but bin/${name} does not exist`)
    }
}
if ([...loopNames].every((n) => existsSync(join(BIN_DIR, n)))) {
    pass(`every name in the PKGBUILD /usr/bin loop exists in bin/ (${loopNames.size} names)`)
}

// The Content Safety data files, both paths.
const blocklistPkg = pkgbuild.includes("defaults/content-safety/blocklist.txt")
    && pkgbuild.includes("/usr/share/veltrix/content-safety/blocklist.txt")
const blocklistDev = installSh.includes("defaults/content-safety/blocklist.txt")
    && installSh.includes("/usr/share/veltrix/content-safety/blocklist.txt")
if (!blocklistPkg) error("blocklist.txt is not installed by the PKGBUILD")
else if (!blocklistDev) error("blocklist.txt is not installed by install.sh")
else pass("content-safety blocklist is installed by both paths")

const policyPkg = pkgbuild.includes("config/polkit/org.veltrix.content-safety.policy")
    && pkgbuild.includes("/usr/share/polkit-1/actions/org.veltrix.content-safety.policy")
const policyDev = installSh.includes("config/polkit/org.veltrix.content-safety.policy")
    && installSh.includes("/usr/share/polkit-1/actions/org.veltrix.content-safety.policy")
if (!policyPkg) error("content-safety polkit policy is not installed by the PKGBUILD")
else if (!policyDev) error("content-safety polkit policy is not installed by install.sh")
else pass("content-safety polkit policy is installed by both paths")

if (failed) {
    log("package-contents-check: FAILED")
    process.exit(1)
}
log("package-contents-check: ok")
