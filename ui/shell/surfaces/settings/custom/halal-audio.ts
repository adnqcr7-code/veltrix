import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { VeltrixButton, showVeltrixAlert } from "../../../../lib/veltrix-kit"
import { t } from "../../../core/i18n"
import { halalAudioConfig } from "../../../core/HalalAudioConfig"
import { clearHalalAudioWhitelist, getHalalAudioCapabilities, installWordScanner, playHalalAudioFile, processHalalAudioFile, scanHalalAudioFile } from "../../../core/HalalAudio"
import { bindWhileRealized, createRow, onPageShown } from "../SettingsHelpers"
import { runSettingsAction } from "../SettingsErrors"
import { openHalalInterstitial } from "../halal-interstitial"
import type { PageCtx, SlotDecl } from "../PreferencePage"

// ── Audio Filter page builders (integrated design — spec §12) ──────────────
// Two custom items. The master switch is a CUSTOM toggle, not settingRow:
// the filter is DEFAULT ON (Adnan, 2026-11-12) and turning it OFF must
// open the halal interstitial (An-Nur 24:30 + a real 60-second pause +
// "Keep protection on" primary — the shared mechanism in
// ../halal-interstitial.ts, same friction as Content Safety) instead of
// applying at once; the switch is vetoed until the user confirms. An ON
// tap applies immediately, no interstitial on the way on. The second
// item is the "Play with filter…" action; the buttons are sensitive
// only while the switch is on (manifest sensitiveWhen).
//
// The flow (warn, don't block): Play → wordscan scans the song's words
// first (unless its audio hash is already on the whitelist, in which
// case playback starts at once — no scan, no wait). A clean scan
// whitelists the song and plays it through the VoiceOnly Fast vocal
// filter (centre-channel, mid = (L+R)/2 — "mostly voice", never "only
// voice"). A flagged scan opens the "This is haram" dialog: "Don't
// play" (the suggested action) or "Play anyway" (the user's explicit
// choice, their responsibility). A flagged song is NEVER whitelisted.
// A scan that could not run throws (wordscan missing, model missing,
// transcription failed) — nothing plays unchecked, and the error is
// shown, not hidden. First-play scanning takes a while (measured ~5 s
// for a short clip including model load; a 3-minute song on Dell-class
// CPU is unmeasured) — the status line says so while it runs; never
// claim instant first-play scanning.
//
// The row's footer shows the live capabilities (word scanner installed?
// how many words on the list? how many songs already checked?) and the
// last run's summary, plus ghost buttons: "Save filtered copy…" (the v1
// offline export tool, kept as an optional action — warns, never mutes),
// "Install word scanner" (downloads the Whisper tiny model, ~75 MB —
// the ONLY network step, explicit and user-triggered; Demucs weights
// are NOT fetched by it), and "Clear checked list" (visible only when
// the whitelist is non-empty — it deletes the local whitelist file).
// All three inherit the row's sensitiveWhen: they wait for the switch,
// which is consistent (models without the switch on buy nothing) and
// harmless. The page re-reads on every visit (onPageShown) and whenever
// the switch flips.
//
// Honesty rule, enforced here as well as in the helper: the status line
// names the vocal engine that WILL run ("VoiceOnly Fast (real-time,
// mostly voice)"), and the limits footer (manifest,
// settings.halalAudio.limits) says the filter does not make a song
// halal. No string in this file claims "instruments removed" or "now
// halal". Playback is a foreground run of the song's own duration —
// there is no Cancel (same standing gap as v1's no-cancel on long
// Demucs runs); the button stays insensitive until playback ends.
export const build = (ctx: PageCtx) => {
    return {
        // The protection toggle. A CUSTOM item, not settingRow: settingRow's
        // toggle would apply OFF the moment it is tapped, and turning this
        // off must open the interstitial first. Same veto pattern as
        // Content Safety's safetyToggle (custom/safety.ts): the switch
        // only ever shows OFF once the store really is off, and only
        // shows ON once the store really is on.
        halalAudioToggle: (slot: SlotDecl) => {
            const sw = new Gtk.Switch({ active: halalAudioConfig.enabled, valign: Gtk.Align.CENTER })
            // The row's words sit beside the switch and nothing connects the
            // two, so the title IS the switch's accessible name (same reason
            // as VeltrixToggleRow in the kit).
            sw.update_property([Gtk.AccessibleProperty.LABEL], [slot.title])

            let programmatic = false
            sw.connect("state-set", (_sw: any, state: boolean) => {
                if (programmatic) return false
                if (state === true) {
                    // Veto the tap: the switch stays OFF until the store
                    // says on, and the subscription below paints it ON
                    // then. (No interstitial on the way on.)
                    halalAudioConfig.setEnabled(true)
                    return true
                }
                if (halalAudioConfig.enabled) {
                    openHalalInterstitial(ctx.page.get_root() as Gtk.Window | null, {
                        note: t("settings.halalAudio.interstitial.note"),
                        onConfirm: () => halalAudioConfig.setEnabled(false),
                    })
                    return true // veto: the switch stays ON until confirmed
                }
                return false
            })

            const row = createRow(slot.title, slot.subtitle, sw)
            bindWhileRealized(row, () => {
                return halalAudioConfig.subscribe("enabled", (v) => {
                    programmatic = true
                    sw.set_active(v)
                    programmatic = false
                })
            })
            return row
        },
        halalAudioProcess: (slot: SlotDecl) => {
            const statusLabel = new Gtk.Label({
                label: "",
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                css_classes: ["dimmed"],
                halign: Gtk.Align.FILL,
                hexpand: true,
                xalign: 0,
            })
            const button = VeltrixButton({
                label: t("settings.halalAudio.play"),
                variant: "primary", size: "compact",
                halign: Gtk.Align.END, valign: Gtk.Align.CENTER,
            })
            const saveButton = VeltrixButton({
                label: t("settings.halalAudio.saveCopy"),
                variant: "ghost", size: "compact",
                halign: Gtk.Align.END, valign: Gtk.Align.CENTER,
            })
            const installButton = VeltrixButton({
                label: t("settings.halalAudio.install"),
                variant: "ghost", size: "compact",
                halign: Gtk.Align.END, valign: Gtk.Align.CENTER,
            })
            const clearButton = VeltrixButton({
                label: t("settings.halalAudio.whitelist.clear"),
                variant: "ghost", size: "compact",
                halign: Gtk.Align.END, valign: Gtk.Align.CENTER,
            })
            // Hidden until refreshStatus finds a non-empty whitelist.
            clearButton.visible = false
            const footerBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
            footerBox.append(statusLabel)
            footerBox.append(saveButton)
            footerBox.append(installButton)
            footerBox.append(clearButton)

            const refreshStatus = () => {
                void getHalalAudioCapabilities().then((caps) => {
                    if (!caps) {
                        statusLabel.label = t("settings.halalAudio.status.unknown")
                        return
                    }
                    const engine = t("settings.halalAudio.engine.voiceonly")
                    const words = caps.blacklist_words > 0
                        ? t("settings.halalAudio.status.words").replace("{count}", String(caps.blacklist_words))
                        : t("settings.halalAudio.status.no-words")
                    const checked = caps.whitelist_count > 0
                        ? ` · ${t("settings.halalAudio.status.whitelist").replace("{count}", String(caps.whitelist_count))}`
                        : ""
                    // The word-scan module is part of the install; if it is
                    // absent, playback refuses fail-safe — say so on the
                    // page instead of letting the first play fail cold.
                    const missing = caps.wordscan
                        ? ""
                        : ` · ${t("settings.halalAudio.status.wordscanMissing")}`
                    const last = halalAudioConfig.lastProcessed
                        ? ` · ${halalAudioConfig.lastProcessed}`
                        : ""
                    statusLabel.label = `${t("settings.halalAudio.status.engine").replace("{engine}", engine)} · ${words}${checked}${missing}${last}`
                    clearButton.visible = caps.whitelist_count > 0
                })
            }
            onPageShown(refreshStatus)
            bindWhileRealized(ctx.page, () => {
                refreshStatus()
                return halalAudioConfig.subscribe("enabled", refreshStatus)
            })

            const setButtonsSensitive = (sensitive: boolean) => {
                button.sensitive = sensitive
                saveButton.sensitive = sensitive
                installButton.sensitive = sensitive
                clearButton.sensitive = sensitive
            }

            installButton.connect("clicked", () => {
                // The only network step in the feature: the Whisper tiny
                // model (~75 MB). Demucs weights are NOT fetched by it.
                // All buttons go insensitive while it runs so a play
                // cannot start mid-download; the status line is the
                // progress + the result (refreshStatus re-reads
                // capabilities, so the engine line updates).
                setButtonsSensitive(false)
                statusLabel.label = t("settings.halalAudio.status.installing")
                void installWordScanner().then(() => {
                    refreshStatus()
                }).catch((e) => {
                    void runSettingsAction(() => { throw e })
                    refreshStatus()
                }).finally(() => {
                    setButtonsSensitive(halalAudioConfig.enabled)
                })
            })

            clearButton.connect("clicked", () => {
                setButtonsSensitive(false)
                void clearHalalAudioWhitelist().then(() => {
                    refreshStatus()
                }).catch((e) => {
                    void runSettingsAction(() => { throw e })
                    refreshStatus()
                }).finally(() => {
                    setButtonsSensitive(halalAudioConfig.enabled)
                })
            })

            const playFile = (path: string, playAnyway: boolean) => {
                statusLabel.label = t("settings.halalAudio.status.playing")
                void playHalalAudioFile(path, playAnyway).then((report) => {
                    statusLabel.label = `${report.input.split("/").pop()} — ${t("settings.halalAudio.status.played")}`
                    refreshStatus()
                }).catch((e) => {
                    void runSettingsAction(() => { throw e })
                    refreshStatus()
                }).finally(() => {
                    setButtonsSensitive(halalAudioConfig.enabled)
                })
            }

            const pickFile = (onPick: (path: string) => void) => {
                const root = ctx.page.get_root() as Gtk.Window | null
                const chooser = new Gtk.FileChooserNative({
                    title: t("settings.halalAudio.filter.audio"),
                    action: Gtk.FileChooserAction.OPEN,
                    transient_for: root,
                })
                const filter = new Gtk.FileFilter({ name: t("settings.halalAudio.filter.audio") })
                for (const pattern of ["*.wav", "*.mp3", "*.flac", "*.ogg", "*.m4a", "*.opus"]) {
                    filter.add_pattern(pattern)
                }
                chooser.add_filter(filter)
                chooser.connect("response", (_c: any, response: number) => {
                    if (response !== Gtk.ResponseType.ACCEPT) return
                    const file = chooser.get_file()
                    if (!file) return
                    const path = file.get_path()
                    if (!path) return
                    onPick(path)
                })
                chooser.show()
            }

            button.connect("clicked", () => {
                pickFile((path) => {
                    setButtonsSensitive(false)
                    statusLabel.label = t("settings.halalAudio.status.scanning")
                    void scanHalalAudioFile(path).then((scan) => {
                        // A scan that could not run THROWS (wordscan
                        // missing, model missing, transcription failed)
                        // and lands in the catch below — nothing was
                        // checked, nothing whitelisted, nothing plays,
                        // and the error is shown. There is no
                        // stage_b_skipped on the scan shape anymore.
                        if (scan.clean) {
                            // First clean play: scanned, whitelisted, now
                            // playing. A whitelist hit skips the scan
                            // inside wordscan and starts at once — the
                            // second play is the fast one. The message
                            // follows `whitelisted` (a hit), which
                            // wordscan reports itself.
                            if (scan.whitelisted) {
                                statusLabel.label = t("settings.halalAudio.status.whitelistHit")
                            }
                            playFile(path, false)
                            return
                        }
                        // Flagged: warn, don't block. The dialog names
                        // the words (plain strings — wordscan returns no
                        // timestamps); "Don't play" is the suggested
                        // action, "Play anyway" is the user's explicit
                        // choice — their responsibility. The song is
                        // NOT whitelisted either way.
                        const words = scan.flagged.join(", ")
                        const root = ctx.page.get_root() as Gtk.Window | null
                        showVeltrixAlert({
                            parent: root,
                            heading: t("settings.halalAudio.warning.heading"),
                            body: t("settings.halalAudio.warning.body").replace("{words}", words),
                            responses: [
                                { id: "cancel", label: t("settings.halalAudio.warning.cancel"), suggested: true },
                                { id: "play", label: t("settings.halalAudio.warning.playAnyway") },
                            ],
                            onResponse: (id) => {
                                if (id === "play") {
                                    playFile(path, true)
                                } else {
                                    const flagged = scan.flagged.length === 1
                                        ? t("settings.halalAudio.status.flagged-one")
                                        : t("settings.halalAudio.status.flagged").replace("{count}", String(scan.flagged.length))
                                    statusLabel.label = flagged
                                    setButtonsSensitive(halalAudioConfig.enabled)
                                }
                            },
                        })
                    }).catch((e) => {
                        void runSettingsAction(() => { throw e })
                        refreshStatus()
                        setButtonsSensitive(halalAudioConfig.enabled)
                    })
                })
            })

            saveButton.connect("clicked", () => {
                pickFile((path) => {
                    setButtonsSensitive(false)
                    statusLabel.label = t("settings.halalAudio.status.working")
                    void processHalalAudioFile(path).then((report) => {
                        const flagged = report.flagged.length === 1
                            ? t("settings.halalAudio.status.flagged-one")
                            : t("settings.halalAudio.status.flagged").replace("{count}", String(report.flagged.length))
                        const skipped = report.stage_b_skipped
                            ? ` · ${t("settings.halalAudio.status.skipped")}`
                            : ""
                        statusLabel.label = `${report.output.split("/").pop()} — ${flagged}${skipped}`
                    }).catch((e) => {
                        void runSettingsAction(() => { throw e })
                        refreshStatus()
                    }).finally(() => {
                        setButtonsSensitive(halalAudioConfig.enabled)
                    })
                })
            })

            return createRow(slot.title, slot.subtitle, button, undefined, undefined, footerBox)
        },
    }
}
