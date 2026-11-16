import { defineSettings } from "./configFile"

// Audio Filter — Settings → Audio Filter (integrated design, spec §12).
//
// `enabled` is the MASTER switch, not a live filter: with it off, the
// play/save actions refuse; with it on, the user picks ONE file and
// `bin/veltrix-halal-audio` plays it through the VoiceOnly Fast vocal
// filter after scanning its words (or saves a filtered copy next to
// it). Nothing is ever modified silently, nothing plays through a
// filter without a scan-or-whitelist-hit, and the original is never
// overwritten (see HalalAudio.ts + the helper's own header).
//
// Default ON is Adnan's explicit call (2026-11-12, 21:59 EST): the
// filter is a halal protection, on unless the user deliberately turns
// it off — and turning it off is guarded, not a plain toggle: the
// Settings page opens the halal interstitial (An-Nur 24:30 + a real
// 60-second pause + "Keep protection on" primary, the same friction as
// Content Safety) and only applies OFF after the user confirms. The
// v1 reasoning for OFF (consent at two levels) is superseded by that
// call; the consent now lives in the guarded off-switch, not the
// default. Do not flip this back to false without Adnan.
interface HalalAudioSettings {
    enabled: boolean // default true (Adnan, 2026-11-12)
    lastProcessed: string // human summary of the last run; "" = never
}

const DEFAULTS: HalalAudioSettings = {
    enabled: true,
    lastProcessed: "",
}

type HalalAudioKey = keyof HalalAudioSettings

const config = defineSettings("halal-audio", DEFAULTS)

export const halalAudioConfig = {
    get enabled() { return config.get("enabled") },
    get lastProcessed() { return config.get("lastProcessed") },

    setEnabled(v: boolean) { config.set("enabled", v) },
    setLastProcessed(v: string) { config.set("lastProcessed", v) },

    subscribe<K extends HalalAudioKey>(key: K, cb: (v: HalalAudioSettings[K]) => void) {
        return config.subscribe(key, cb)
    },
}
