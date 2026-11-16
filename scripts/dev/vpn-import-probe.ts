// vpn-import-probe — `nmcli connection import` output is parsed by UUID,
// not by its English words (Nov 14 sweep #12).
//
//   scripts/bundle.sh scripts/dev/vpn-import-probe.ts /tmp/vpn-import-probe
//   /tmp/vpn-import-probe                       # under gjs, like the other probes
//
// Or under plain node (the module under test has no imports):
//   npx esbuild --bundle scripts/dev/vpn-import-probe.ts --format=esm \
//     --platform=node --outfile=/tmp/vpn-import-probe.mjs && node /tmp/vpn-import-probe.mjs
//
// nmcli's success line is localised — German, Arabic, … — so a regex on
// "Connection '…'" only works in English. In every other locale the name
// fell back to the file name, the autoconnect-off call addressed a
// connection that does not exist, and its failure was swallowed, so the
// imported VPN silently kept auto-connect on. The UUID in parentheses is
// not localised, so it is the modify target now; the name is display-only.
//
// Fixtures below are the real shapes: English (nmcli's own message),
// German (same line, translated), a line with no UUID (old nmcli), and
// a line with no quoted name at all (fallback to the file basename).
// The control proves the OLD regex fails the German line — a probe that
// passes on the old code is not testing the fix.

import { parseNmcliImportOutput } from "../../ui/shell/core/nmcli-parse"

// `print` is the GJS global; under node it does not exist.
const print = (globalThis as any).print ?? ((...a: unknown[]) => console.log(...a))

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
    print(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`)
    if (!cond) failures++
}

const UUID = "2f1a0c6e-9a53-4b4e-8a57-2c1f0d3b9e11"

const en = parseNmcliImportOutput(
    `Connection 'Proton DE' (${UUID}) successfully added.`, "/tmp/proton-de.conf")
check("English: UUID parsed", en.uuid === UUID, en.uuid ?? "null")
check("English: name parsed", en.name === "Proton DE", en.name)

const de = parseNmcliImportOutput(
    `Verbindung 'Proton DE' (${UUID}) erfolgreich hinzugefügt.`, "/tmp/proton-de.conf")
check("German: UUID parsed", de.uuid === UUID, de.uuid ?? "null")
check("German: name parsed", de.name === "Proton DE", de.name)

const ar = parseNmcliImportOutput(
    `تمت إضافة الاتصال 'Proton DE' (${UUID}) بنجاح.`, "/tmp/proton-de.conf")
check("Arabic: UUID parsed", ar.uuid === UUID, ar.uuid ?? "null")
check("Arabic: name parsed", ar.name === "Proton DE", ar.name)

const noUuid = parseNmcliImportOutput(
    "Connection 'Old VPN' successfully added.", "/tmp/old.conf")
check("no UUID in line: uuid is null", noUuid.uuid === null, noUuid.uuid ?? "null")
check("no UUID in line: name still parsed", noUuid.name === "Old VPN", noUuid.name)

const bare = parseNmcliImportOutput("added.", "/home/adnan/Downloads/my-vpn.conf")
check("no name in line: falls back to file basename", bare.name === "my-vpn.conf", bare.name)
check("no name in line: uuid is null", bare.uuid === null, bare.uuid ?? "null")

// Control: the OLD English-only regex on the German line finds no name,
// so the old code modified a connection named after the FILE — which
// does not exist — and swallowed the failure.
const oldName = `Verbindung 'Proton DE' (${UUID}) erfolgreich hinzugefügt.`.match(/Connection '([^']+)'/)?.[1]
    ?? "/tmp/proton-de.conf".split("/").pop()
check("control: old regex misses the German name", oldName === "proton-de.conf", oldName)

print(failures === 0 ? "TEST: ALL PASSED" : `TEST: ${failures} FAILURE(S)`)
