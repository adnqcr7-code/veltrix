#!/usr/bin/env node
/*
 * settings-css-check — the git-ignored Settings stylesheet must match its SCSS.
 *
 *   node scripts/ci/settings-css-check.mjs
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `ui/settings/style.css` is git-ignored build output (`.gitignore:200`),
 * but it is ALSO the file a dev reload / `run.sh` reads without rebuilding —
 * so when fix pass #1 changed the SCSS (Noto-only verse stack, the
 * `.veltrix-safety-attrib` rule) and nobody recompiled the tree copy, the
 * Settings page kept painting the OLD verse stack (Amiri still in it, no
 * attrib rule) and nobody noticed until the UI review (F1, fix pass #2).
 * Compiling the SCSS in CI was already gated — but compiling is not the
 * same as the tree copy matching, and nothing pinned the two together, so
 * the staleness could recur silently.
 *
 * This check closes the recurrence: it compiles `ui/settings/style.scss`
 * fresh with `sass` and diffs the result against the tree copy, ignoring
 * only the `sourceMappingURL` comment (which names the output file, so it
 * legitimately differs) and the `@charset` line (suppressed by the build's
 * own `--no-charset` flag and stripped from the tree copy). Any other
 * difference fails the check.
 *
 * Sass comes from `SASS_BIN` when set (local runs: point it at the shell's
 * own install, e.g. `ui/shell/node_modules/.bin/sass`), else from
 * `npx --yes sass@1.97.3` — the same version `ci.yml` pins.
 *
 * ── Controls ───────────────────────────────────────────────────────────────
 *
 * The check must FAIL when the two disagree in either direction:
 *   1. append a line to the tree CSS (or edit the SCSS without
 *      recompiling) → exit 1 naming the first differing line;
 *   2. restore the file (or recompile) → exit 0 again.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCSS = "ui/settings/style.scss"
const TREE_CSS = "ui/settings/style.css"

if (!existsSync(SCSS) || !existsSync(TREE_CSS)) {
    console.log("settings-css-check: run from the repo root — "
        + `${SCSS} or ${TREE_CSS} not found`)
    process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), "veltrix-settings-css-"))
const fresh = join(work, "style.css")
try {
    // The build's own sass step (install.sh, PKGBUILD) is
    // `sass --no-charset style.scss style.css` with the @charset line
    // stripped afterwards; the check does the same, so the comparison is
    // against exactly what a build produces.
    const sassBin = process.env.SASS_BIN
    const cmd = sassBin ? [sassBin] : ["npx", "--yes", "sass@1.97.3"]
    execFileSync(cmd[0], [...cmd.slice(1), "--no-charset", SCSS, fresh],
        { stdio: "pipe" })
} catch (e) {
    console.log("settings-css-check: sass failed to compile "
        + `${SCSS}: ${(e.stderr ?? e.message ?? e).toString().trim()}`)
    rmSync(work, { recursive: true, force: true })
    process.exit(1)
}

const strip = (text) => text
    .split("\n")
    .filter((line) => !line.startsWith("/*# sourceMappingURL="))
    .filter((line) => line.trim() !== "@charset \"UTF-8\";")
const freshLines = strip(readFileSync(fresh, "utf8"))
const treeLines = strip(readFileSync(TREE_CSS, "utf8"))
rmSync(work, { recursive: true, force: true })

if (freshLines.length !== treeLines.length
    || freshLines.some((line, i) => line !== treeLines[i])) {
    const first = freshLines.findIndex((line, i) => line !== treeLines[i])
    const n = first === -1 ? Math.min(freshLines.length, treeLines.length) + 1 : first + 1
    console.log(`settings-css-check: FAIL — ${TREE_CSS} does not match a fresh `
        + `compile of ${SCSS} (first difference at line ${n})`)
    console.log(`  fresh: ${JSON.stringify(freshLines[first] ?? "(missing)")}`)
    console.log(`  tree:  ${JSON.stringify(treeLines[first] ?? "(missing)")}`)
    console.log("  Recompile it the way the build does: "
        + "`cd ui/shell && npx sass --no-charset ../settings/style.scss "
        + "../settings/style.css && sed -i '/@charset/d' ../settings/style.css`")
    process.exit(1)
}

console.log(`settings-css-check: ok — ${TREE_CSS} matches a fresh compile of ${SCSS}`)
