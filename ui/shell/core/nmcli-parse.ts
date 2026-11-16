// SPDX-License-Identifier: GPL-3.0-or-later
// Pure parsing of `nmcli connection import` output — no imports, so a
// probe can exercise it without NetworkManager or a locale.
//
// nmcli reports a successful import as one human line, e.g. English:
//   Connection 'Proton DE' (2f1a0c6e-9a53-4b4e-8a57-2c1f0d3b9e11) successfully added.
// The words are LOCALISED (German, Arabic, …), so a regex on "Connection
// '…'" only works in English — in every other locale the name fell back
// to the file name, the follow-up `nmcli connection modify <name> …`
// addressed a connection that does not exist, and its failure was
// swallowed, so the imported VPN silently kept auto-connect on
// (Nov 14 sweep #12). The UUID in parentheses is NOT localised: it is
// the stable handle, so parse it and modify by UUID.
//
// Returns the UUID (when present) and the best name available: the
// quoted name from nmcli's line when it parses, else the file's basename
// (the caller's fallback — same as before, but now only used for
// display, never as the modify target).

export interface NmcliImportResult {
    /** The new connection's UUID, or null when the line carries none. */
    uuid: string | null
    /** Display name: nmcli's quoted name, else the file basename. */
    name: string
}

const UUID_RE = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i
const QUOTED_NAME_RE = /'([^']+)'/

export function parseNmcliImportOutput(output: string, fallbackPath: string): NmcliImportResult {
    const uuid = UUID_RE.exec(output)?.[1] ?? null
    const name = QUOTED_NAME_RE.exec(output)?.[1] ?? fallbackPath.split("/").pop() ?? fallbackPath
    return { uuid, name }
}
