#!/usr/bin/env node
// locale-fontconfig-check — the Arabic fontconfig rule and the five locale
// detection chains are load-bearing and drift silently.
//
//   node scripts/ci/locale-fontconfig-check.mjs [--root <dir>]
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The Arabic face rule (`config/fontconfig/65-0-veltrix-noto-arabic.conf`) is
// the only thing standing between Arabic text and DejaVu Sans: with a weak
// prepend the rule fires and still loses. A future edit could add an
// `<include>`, flip an edit to `mode="assign"`, retarget a match at
// `target="font"`, or name a third face, and no gate would catch it — the
// symptom is a user reading the wrong face, with no error anywhere.
//
// The five detection chains are the same kind of silent agreement: the shell,
// the greeter, the lockscreen, the installer and the native Settings
// (`toolkit/crates/nk-platform`) each map a LANG prefix to one of the same 13
// locale tags, and the installer and the desktop it installs would disagree
// about what "pt" means if any one of them drifted. (The installer holds two
// sites — `languages.ts`'s list + `languageFor`, and `i18n.ts`'s
// `localeFromLang` — counted as one chain; this check covers both, so it
// reads six files for the five chains.)
//
// So this checks, mechanically:
//
//   1. the Arabic fontconfig file contains no `<include>`, no
//      `mode="assign"` (either quote style), no `target="font"`, every
//      `<edit>` is exactly `mode="prepend" binding="strong"` (a weak
//      prepend loses to DejaVu; an append lands the faces after the
//      generic family instead of before it), and its `<edit
//      name="family">` values are exactly the two expected faces
//      (Noto Sans Arabic, Noto Naskh Arabic);
//   2. every detection chain maps the same 13 LANG prefixes to the same 13
//      locale tags, in the same order (pt_br before the generic pt rule),
//      verified by parsing each chain out of its source file and running
//      the same probe LANG values through all of them.
//
// `--root <dir>` reads the files from under that directory instead of the
// repo root; CI's control step uses it to run the check against a mutated
// copy and require a failure. A check that has only ever printed "ok" has
// been run, not tested.

import { readFileSync } from "node:fs"
import { join } from "node:path"

const argv = process.argv.slice(2)
let root = process.cwd()
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) { root = argv[++i]; continue }
    console.error(`locale-fontconfig-check: unknown argument ${argv[i]}`)
    process.exit(1)
}
const read = (rel) => readFileSync(join(root, rel), "utf8")

let failed = false
const pass = (s) => console.log(`  ✓ ${s}`)
const fail = (s) => { failed = true; console.error(`  FAIL ${s}`) }

// ── The 13 tags ─────────────────────────────────────────────────────────────
// Ordered as the chains read them: pt_br must come before the generic pt
// rule, or Brazil gets pt-PT.
const EXPECTED = [
    ["en", "en"],
    ["es", "es"],
    ["fr", "fr"],
    ["de", "de"],
    ["pt_br", "pt-BR"],
    ["pt", "pt-PT"],
    ["it", "it"],
    ["pl", "pl"],
    ["nl", "nl"],
    ["ru", "ru"],
    ["zh", "zh-CN"],
    ["ja", "ja"],
    ["ar", "ar"],
]
const EXPECTED_LOCALES = EXPECTED.map(([, locale]) => locale)
// Probe LANG values, one per tag plus the fallback shapes: pt_AO follows the
// European norm, zh_TW still maps to zh-CN, and anything unrecognised (C,
// unknown, empty) falls back to en.
const PROBES = [
    ["en_US.UTF-8", "en"], ["es_ES.UTF-8", "es"], ["fr_FR.UTF-8", "fr"],
    ["de_DE.UTF-8", "de"], ["pt_BR.UTF-8", "pt-BR"], ["pt_PT.UTF-8", "pt-PT"],
    ["pt_AO.UTF-8", "pt-PT"], ["it_IT.UTF-8", "it"], ["pl_PL.UTF-8", "pl"],
    ["nl_NL.UTF-8", "nl"], ["ru_RU.UTF-8", "ru"], ["zh_CN.UTF-8", "zh-CN"],
    ["zh_TW.UTF-8", "zh-CN"], ["ja_JP.UTF-8", "ja"], ["ar_SA.UTF-8", "ar"],
    ["ar_EG.UTF-8", "ar"], ["C", "en"], ["xx_YY.UTF-8", "en"], ["", "en"],
]
const simulatePrefixChain = (pairs) => (lang) => {
    const l = lang.toLowerCase()
    for (const [prefix, locale] of pairs) if (l.startsWith(prefix)) return locale
    return "en"
}
const samePairs = (a, b) =>
    a.length === b.length && a.every(([p, l], i) => p === b[i][0] && l === b[i][1])

// ── 1. Fontconfig ────────────────────────────────────────────────────────────
const CONF = "config/fontconfig/65-0-veltrix-noto-arabic.conf"
const conf = read(CONF)
const EXPECTED_FAMILIES = ["Noto Sans Arabic", "Noto Naskh Arabic"]

for (const [pattern, what] of [
    [/<include\b/i, "<include>"],
    [/mode\s*=\s*["']assign["']/, 'mode="assign"'],
    [/target\s*=\s*["']font["']/, 'target="font"'],
]) {
    if (pattern.test(conf)) fail(`${CONF} contains ${what}`)
    else pass(`${CONF} has no ${what}`)
}
const familyEdits = [...conf.matchAll(/<edit[^>]*name="family"[^>]*>([\s\S]*?)<\/edit>/g)]
    .flatMap((m) => [...m[1].matchAll(/<string>([^<]+)<\/string>/g)].map((s) => s[1]))
const familiesOk = familyEdits.length === EXPECTED_FAMILIES.length &&
    EXPECTED_FAMILIES.every((f) => familyEdits.includes(f))
if (!familiesOk) {
    fail(`${CONF} family edits are [${familyEdits.join(", ")}], expected [${EXPECTED_FAMILIES.join(", ")}]`)
} else {
    pass(`${CONF} names only ${EXPECTED_FAMILIES.join(" + ")}`)
}
const matchCount = (conf.match(/<match\b/g) || []).length
if (matchCount !== 2) fail(`${CONF} has ${matchCount} <match> blocks, expected 2`)
else pass(`${CONF} has exactly 2 <match> blocks`)
// Every <edit> must be exactly mode="prepend" binding="strong": the
// forbidden shapes above catch "assign", but a silent weakening to
// "append" (faces land after the generic family) or a dropped binding
// (weak prepend loses to DejaVu, verified 2026-11-12) would pass them.
// Quote-agnostic: fontconfig accepts single quotes too (security v3
// must-fix #1 — the guard was blind to both shapes).
const editTags = [...conf.matchAll(/<edit\b[^>]*>/g)].map((m) => m[0])
const editAttr = (tag, name) => {
    const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`))
    return m ? m[1] : null
}
const badEdits = editTags.filter((tag) => editAttr(tag, "mode") !== "prepend" || editAttr(tag, "binding") !== "strong")
if (editTags.length === 0) fail(`${CONF} has no <edit> elements, expected 2`)
else if (badEdits.length > 0) fail(`${CONF} has ${badEdits.length} <edit> not exactly mode="prepend" binding="strong": ${badEdits.join(" ")}`)
else pass(`${CONF} has ${editTags.length} <edit> elements, all mode="prepend" binding="strong"`)

// ── 2. The LANG-prefix chains (shell, greeter, lockscreen, installer i18n) ──
// The shell spells the `en` branch out (`startsWith("en")`); the other three
// return "en" as the fallthrough default instead of testing for it — same
// mapping, one fewer explicit branch. So the explicit pairs are compared
// against the 13-tag chain minus `en`, and the `en` fallback is checked
// separately (shell: `else activeLocale = "en"`; the rest: `return "en"`).
const PREFIX_CHAINS = [
    ["shell", "ui/shell/core/i18n/index.ts"],
    ["greeter", "ui/greeter/lib/i18n.ts"],
    ["lockscreen", "ui/lockscreen/lib/i18n.ts"],
    ["installer i18n", "ui/installer/lib/i18n.ts"],
]
const EXPECTED_EXPLICIT = EXPECTED.filter(([p]) => p !== "en")
const parsedChains = {}
for (const [name, rel] of PREFIX_CHAINS) {
    const src = read(rel)
    const pairs = [...src.matchAll(/startsWith\("([^"]+)"\)\)[^\n]*?(?:activeLocale\s*=\s*"([^"]+)"|return\s*"([^"]+)")/g)]
        .map((m) => [m[1], m[2] ?? m[3]])
        .filter(([p]) => p !== "en")
    const hasEn = /else activeLocale = "en"|return "en"|startsWith\("en"\)/.test(src)
    // The full chain the simulation runs on: explicit pairs plus the en
    // default, in chain order (en first — its prefix only matches en input,
    // so its position cannot change any probe).
    parsedChains[name] = [["en", "en"], ...pairs]
    // Order between branches only matters where prefixes overlap: pt_br
    // must precede the generic pt rule (it precedes it in every chain; the
    // shell puts `it` after pt, the others before it, and that changes
    // nothing since "it" and "pt" cannot both prefix-match). So compare the
    // branch SET, and check the one load-bearing order separately.
    const setOk = pairs.length === EXPECTED_EXPLICIT.length &&
        EXPECTED_EXPLICIT.every(([p, l]) => pairs.some(([p2, l2]) => p2 === p && l2 === l))
    const ptBrFirst = pairs.findIndex(([p]) => p === "pt_br") < pairs.findIndex(([p]) => p === "pt")
    if (!setOk) {
        fail(`${name} (${rel}) chain is [${pairs.map(([p, l]) => `${p}→${l}`).join(", ")}], expected the 12 explicit branches of the 13-tag chain`)
    } else if (!ptBrFirst) {
        fail(`${name} (${rel}) tests pt before pt_br — Brazil would get pt-PT`)
    } else if (!hasEn) {
        fail(`${name} (${rel}) has the 12 explicit branches but no "en" branch or fallback`)
    } else {
        pass(`${name} chain maps the 13 tags (12 branches + en fallback)`)
    }
}

// ── 3. The Rust chain (native Settings) ──────────────────────────────────────
const rust = read("toolkit/crates/nk-platform/src/exports.rs")
const chainStart = rust.indexOf("const CHAIN")
const chainEnd = chainStart === -1 ? -1 : rust.indexOf("];", chainStart)
if (chainStart === -1 || chainEnd === -1) {
    fail("toolkit/crates/nk-platform/src/exports.rs has no CHAIN array")
} else {
    const pairs = [...rust.slice(chainStart, chainEnd).matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)]
        .map((m) => [m[1], m[2]])
    parsedChains.rust = pairs
    if (!samePairs(pairs, EXPECTED)) {
        fail(`rust CHAIN is [${pairs.map(([p, l]) => `${p}→${l}`).join(", ")}], expected the 13-tag chain`)
    } else {
        pass("rust CHAIN maps the 13 tags in order")
    }
}

// ── 4. The installer list + languageFor ──────────────────────────────────────
const langs = read("ui/installer/lib/languages.ts")
const entries = [...langs.matchAll(/\{\s*key:\s*"([^"]+)",\s*lang:\s*"([^"]+)",\s*defaultLocale:\s*"([^"]+)"\s*\}/g)]
    .map((m) => ({ key: m[1], lang: m[2], defaultLocale: m[3] }))
const EXPECTED_GLIBC = {
    en: "en_US.UTF-8", es: "es_ES.UTF-8", fr: "fr_FR.UTF-8", de: "de_DE.UTF-8",
    "pt-BR": "pt_BR.UTF-8", "pt-PT": "pt_PT.UTF-8", it: "it_IT.UTF-8",
    pl: "pl_PL.UTF-8", nl: "nl_NL.UTF-8", ru: "ru_RU.UTF-8",
    "zh-CN": "zh_CN.UTF-8", ja: "ja_JP.UTF-8", ar: "ar_SA.UTF-8",
}
const keysOk = entries.length === 13 &&
    EXPECTED_LOCALES.every((k) => entries.some((e) => e.key === k))
const glibcOk = entries.every((e) => EXPECTED_GLIBC[e.key] === e.defaultLocale)
if (!keysOk) fail(`installer LANGUAGES keys are [${entries.map((e) => e.key).join(", ")}], expected the 13 tags`)
else pass("installer LANGUAGES lists the 13 tags")
if (!glibcOk) fail("installer LANGUAGES defaultLocale values do not match the 13 glibc locales")
else pass("installer LANGUAGES defaultLocale values match the 13 glibc locales")
const explicit = [...langs.matchAll(/if \(l\.startsWith\("([^"]+)"\)\) return LANGUAGES\.find\(x => x\.key === "([^"]+)"\)!/g)]
    .map((m) => [m[1], m[2]])
const LANGUAGEFOR_EXPLICIT = [["pt_br", "pt-BR"], ["pt", "pt-PT"], ["zh", "zh-CN"], ["ar", "ar"]]
if (!samePairs(explicit, LANGUAGEFOR_EXPLICIT)) {
    fail(`installer languageFor explicit branches are [${explicit.map(([p, l]) => `${p}→${l}`).join(", ")}], expected pt_br→pt-BR, pt→pt-PT, zh→zh-CN, ar→ar`)
} else {
    pass("installer languageFor explicit branches are pt_br/pt/zh/ar")
}
// Simulate languageFor: explicit branches first, then the first LANGUAGES
// entry whose lang is a prefix of the input, else the first entry (en).
const languageFor = (locale) => {
    const l = locale.toLowerCase()
    for (const [prefix, key] of explicit) if (l.startsWith(prefix)) return key
    return (entries.find((e) => l.startsWith(e.lang)) ?? entries[0]).key
}
parsedChains["installer list"] = PROBES.map(([probe]) => [probe, languageFor(probe)])

// ── 5. Every chain agrees on every probe ─────────────────────────────────────
for (const [probe, expected] of PROBES) {
    for (const [name, pairs] of Object.entries(parsedChains)) {
        const got = name === "installer list"
            ? pairs.find(([p]) => p === probe)[1]
            : simulatePrefixChain(pairs)(probe)
        if (got !== expected) {
            fail(`${name} maps ${JSON.stringify(probe)} to ${got}, expected ${expected}`)
        }
    }
}
pass(`all chains agree on ${PROBES.length} probe LANG values (incl. pt_AO→pt-PT, zh_TW→zh-CN, C→en)`)

if (failed) {
    console.error("\nlocale-fontconfig-check: FAILED — the Arabic fontconfig rule or a locale detection chain drifted.")
    process.exit(1)
}
console.log("\nlocale-fontconfig-check: Arabic fontconfig rule is minimal; all five detection chains map the same 13 tags.")
