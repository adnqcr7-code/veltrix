import { execAsync } from "../../lib/process"
import { halalAudioConfig } from "./HalalAudioConfig"

// Audio Filter — the Settings-side half of the integrated design
// (spec §12). The real work is `bin/veltrix-halal-audio` (unprivileged,
// user files only, no network at scan/play time — see its header and
// docs/halal-audio-spec.md). This file only shells out to it and parses
// the JSON it prints. The helper is the ORCHESTRATOR: vocals come from
// Adnan's VoiceOnly tool (imported, not re-implemented) and words from
// the parent's wordscan.py (invoked through its CLI contract).
//
// The flow (warn, don't block): the page calls scanHalalAudioFile
// first. wordscan checks its whitelist FIRST — a hit skips the scan
// and playback starts at once. A clean scan whitelists the song
// (file-bytes hash, on-device) and plays it through the VoiceOnly
// Fast vocal filter (centre-channel, mid = (L+R)/2 — "mostly voice",
// never "only voice"). The scan is what costs time on first play
// (measured ~5 s for a 6-second clip including model load; a 3-minute
// song on Dell-class CPU is unmeasured — the UI says first play takes
// a while and never claims instant). A flagged scan returns the words
// in the JSON (scan exits 0 when it ran — read `clean` — because
// execAsync discards stdout on a non-zero exit, and the warning dialog
// must name the words); the page shows "This is haram" and plays ONLY
// if the user taps "Play anyway" (playHalalAudioFile with
// playAnyway=true). A flagged song is never whitelisted. A scan that
// could not run is exit 3 and THROWS here (no stage_b_skipped on the
// scan shape — the caller shows the error, nothing plays unchecked).
//
// Two rules, both load-bearing:
//   - The helper is run with a LONG timeout (30 min): a first-play scan
//     of a long song takes minutes, and a 5 s default would kill every
//     real run and report it as a failure. Playback is a foreground
//     run of the same length — same timeout.
//   - A failed or skipped stage is NEVER hidden: the helper's JSON says
//     which vocal engine ran and what the scan skipped, and the page
//     shows it — the switch must never claim a Demucs separation the
//     user got as VoiceOnly Fast, and a clean-looking play must never
//     hide that the scan could not run.

export interface HalalAudioCapabilities {
    ffmpeg: boolean
    voiceonly: boolean
    voiceonly_path: string | null
    /** Null when the word-scan module is not installed — playback then
     *  refuses fail-safe (the helper exits 3, the page shows why). */
    wordscan: string | null
    faster_whisper_installed: boolean
    whisper_model_cached: boolean
    demucs: boolean
    demucs_weights_cached: boolean
    blacklist: string | null
    blacklist_words: number
    blacklist_error: string | null
    whitelist: string
    whitelist_count: number
}

/** What `scan` returns. `clean === false` with `flagged` non-empty is a
 *  warning, not an error — the scan ran and found a blacklisted word.
 *  Flagged words are plain strings (wordscan returns no timestamps —
 *  the warning names the words, not where they are). A scan that could
 *  not run THROWS instead of returning a report. */
export interface HalalAudioScan {
    input: string
    audio_hash: string | null
    flagged: string[]
    clean: boolean
    /** True when the song's audio hash was already on the whitelist —
     *  the scan was skipped and playback starts at once. */
    whitelisted?: boolean
    /** False on a whitelist hit, true when transcription actually ran. */
    scanned?: boolean
}

export interface HalalAudioPlay extends HalalAudioScan {
    whitelisted: boolean
    scanned: boolean
    vocal_engine: "demucs" | "voiceonly-fast"
    playback: "ffplay" | "dry-run"
    played: boolean
    /** Null on a play that ran (the scan ran or hit the whitelist); a
     *  scan that could not run is exit 3 and throws before a report is
     *  returned, so this is never non-null in practice — it is the
     *  helper's own report field, kept for parity with `process`. */
    stage_b_skipped: string | null
    play_seconds?: number
}

export interface HalalAudioResult {
    input: string
    output: string
    vocal_engine: "demucs" | "voiceonly-fast"
    /** Warned words, NOT muted words. The saved copy's audio is the
     *  vocal-filtered track with nothing silenced (v1 muted hits;
     *  muting was removed in the v2 redesign — warn, don't block). */
    flagged: string[]
    stage_b_skipped: string | null
}

/** Read-only capabilities probe (no processing, no downloads). */
export async function getHalalAudioCapabilities(): Promise<HalalAudioCapabilities | null> {
    try {
        const out = await execAsync(["veltrix-halal-audio", "check"], { timeoutMs: 10000 })
        return JSON.parse(out) as HalalAudioCapabilities
    } catch {
        return null
    }
}

/**
 * Install the word scanner (Whisper tiny model, ~75 MB). The ONLY network
 * step in this feature, explicit and user-triggered from the Settings
 * page's "Install word scanner" action — never automatic, never behind
 * the toggle. Long timeout (30 min, matching the helper's own). Demucs
 * weights are NOT fetched by this verb (best-quality mode, later) —
 * installing the scanner does not install Demucs. Throws on failure
 * (message is the helper's stderr). On success the caller re-reads
 * capabilities.
 */
export async function installWordScanner(): Promise<string> {
    const out = await execAsync(["veltrix-halal-audio", "download-models"], { timeoutMs: 30 * 60 * 1000 })
    return out.trim()
}

/** Scan one file's words. Throws on failure (message is the helper's
 *  stderr — scan-unavailable is exit 3). On a clean scan the helper
 *  adds the song to the whitelist; on a flagged scan it does not. */
export async function scanHalalAudioFile(path: string): Promise<HalalAudioScan> {
    if (!halalAudioConfig.enabled) {
        throw new Error("Audio filter is off — turn it on first.")
    }
    const out = await execAsync(["veltrix-halal-audio", "scan", path], { timeoutMs: 30 * 60 * 1000 })
    return JSON.parse(out) as HalalAudioScan
}

/**
 * Play one file through the VoiceOnly Fast vocal filter. wordscan
 * checks the whitelist first (a hit plays at once, no scan), otherwise
 * scans first and refuses a flagged song unless `playAnyway` is true —
 * the user's explicit choice after the "This is haram" warning, their
 * responsibility. Throws on failure (message is the helper's stderr):
 * a scan that could not run refuses playback fail-safe. On success
 * records a one-line summary in `lastProcessed` (local only) and
 * returns the parsed report. NOTE: this call lasts as long as the song
 * plays (foreground ffplay); the caller keeps its button insensitive
 * until it resolves.
 */
export async function playHalalAudioFile(path: string, playAnyway = false): Promise<HalalAudioPlay> {
    if (!halalAudioConfig.enabled) {
        throw new Error("Audio filter is off — turn it on first.")
    }
    const args = ["veltrix-halal-audio", "play", path]
    if (playAnyway) args.push("--play-anyway")
    const out = await execAsync(args, { timeoutMs: 30 * 60 * 1000 })
    const report = JSON.parse(out) as HalalAudioPlay
    const flagged = report.flagged.length === 1 ? "1 word flagged" : `${report.flagged.length} words flagged`
    halalAudioConfig.setLastProcessed(
        `${report.input.split("/").pop()} — played (${report.vocal_engine} vocals, ${flagged})`)
    return report
}

/** The whitelist (audio-hash -> {filename, added} — wordscan's format;
 *  the store is owned by wordscan.py, this only reads it). Local only. */
export async function getHalalAudioWhitelist(): Promise<Record<string, { filename: string; added: string }>> {
    try {
        const out = await execAsync(["veltrix-halal-audio", "whitelist"], { timeoutMs: 10000 })
        return JSON.parse(out) as Record<string, { filename: string; added: string }>
    } catch {
        return {}
    }
}

export async function clearHalalAudioWhitelist(): Promise<void> {
    await execAsync(["veltrix-halal-audio", "whitelist-clear"], { timeoutMs: 10000 })
}

/**
 * Save a filtered copy of one file (the v1 export tool, kept as an
 * optional action). Default vocal engine is VoiceOnly Fast; the report
 * lists `flagged` words — nothing is muted. The scan runs on the
 * original file through wordscan.py. Throws on failure (message is
 * the helper's stderr). On success records a one-line summary in
 * `lastProcessed` (local only) and returns the parsed report.
 */
export async function processHalalAudioFile(path: string): Promise<HalalAudioResult> {
    if (!halalAudioConfig.enabled) {
        throw new Error("Audio filter is off — turn it on first.")
    }
    const out = await execAsync(["veltrix-halal-audio", "process", path], { timeoutMs: 30 * 60 * 1000 })
    const report = JSON.parse(out) as HalalAudioResult
    const flagged = report.flagged.length === 1 ? "1 word flagged" : `${report.flagged.length} words flagged`
    const skipped = report.stage_b_skipped ? ` · word scan skipped: ${report.stage_b_skipped}` : ""
    halalAudioConfig.setLastProcessed(
        `${report.output.split("/").pop()} — ${report.vocal_engine} vocals, ${flagged}${skipped}`)
    return report
}
