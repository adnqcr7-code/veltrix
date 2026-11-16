import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { VeltrixButton } from "../../../../lib/veltrix-kit"
import { dialogButtonRow } from "../../../../lib/veltrix-kit/dialog-buttons"
import { t } from "../../../core/i18n"
import { SHELL_ROOT } from "../../../core/Paths"
import { getConfigEntry } from "../../../core/ConfigRegistry"
import safetyConfig from "../../../core/SafetyConfig"
import { ApplyCancelled, getFilterStatus } from "../../../core/ContentSafety"
import { bindWhileRealized, createRow, onPageShown, staticLabel } from "../SettingsHelpers"
import { execAsync } from "../../../../lib/process"
import { runSettingsAction } from "../SettingsErrors"
import type { PageCtx, SlotDecl } from "../PreferencePage"

// ── The verse ───────────────────────────────────────────────────────────────
// Surah An-Nur 24:30 — Arabic FIRST, the English translation directly
// underneath it (Adnan, 2026-11-12). The Arabic below is a code constant,
// never an i18n key, so no translator can ever alter a letter of it.
//
// TANZIL CROSS-CHECK — RESOLVED by the halal critic (Ruling 1, 2026-11-12):
// the constant is Tanzil SIMPLE, line 2821 of simple.txt, verbatim —
// byte-identical, zero differences (re-diffed after this edit). Adnan's
// supplied text differed from it ONLY in combining-mark order: shadda
// (U+0651) before the vowel at four places (لّ, يَغُضُّوا, إِنَّ, اللَّهَ),
// where his text had vowel-then-shadda. The halal critic ruled this a
// reorder, not a rewrite — same letters, same diacritics, same rendering
// to the eye, zero meaning change — and ordered the normalisation, which
// changes his verbatim text by those four swaps. That is the critic's
// explicit ruling, recorded here, not a silent fix.
// Full Uthmani orthography (dagger alef U+0670, alef wasla U+0671,
// U+06DF, U+06E2) is NOT adopted: the critic ruled Uthmani is for the
// Quran reader, not this one-verse reminder, and Tanzil Simple satisfies
// rubric 1.7. The UI cites only "Surah An-Nur · 24:30" and does NOT claim
// the text is Uthmani.
// The English line is Adnan's supplied wording (close to Pickthall/Sahih,
// not verbatim Sahih International); it is attributed, not replaced —
// see settings.safety.interstitial.attribution (halal Ruling 3, rubric
// 4.4.5). Rendering was verified in Noto Naskh Arabic 30px, RTL: correct
// shaping, no tofu boxes, no broken letters (see the fix report's render
// check).
export const VERSE_AR_24_30 =
    "قُل لِّلْمُؤْمِنِينَ يَغُضُّوا مِنْ أَبْصَارِهِمْ وَيَحْفَظُوا فُرُوجَهُمْ ۚ ذَٰلِكَ أَزْكَىٰ لَهُمْ ۗ إِنَّ اللَّهَ خَبِيرٌ بِمَا يَصْنَعُونَ"

/** The reflective pause before "Turn off anyway" becomes usable (seconds).
 *  A real countdown: every opening of the dialog starts a fresh 60 seconds,
 *  there is no stored "already waited" flag, and closing + reopening the
 *  dialog restarts the wait instead of skipping it. */
const REFLECT_SECONDS = 60

// ── The interstitial ────────────────────────────────────────────────────────
// A modal dialog of its own (not showVeltrixAlert: that helper auto-responds
// when ITS countdown ends, and this dialog must do the opposite — the
// "Turn off anyway" button stays DISABLED until the countdown finishes, and
// nothing happens at zero except the button becoming usable). It reuses the
// kit's dialogButtonRow (so the buttons are the same VeltrixButtons as every
// other dialog) and the alert dialog's CSS classes (veltrix-alert-dialog,
// veltrix-alert-heading, veltrix-alert-body), plus its own scoped class for
// the verse block (ui/shell/styles/_settings.scss).
//
// Rubric 1.8: the verse sits in the reminder text ONLY. It is never on, or
// attached to, the "Turn off anyway" button or any close control — the
// buttons carry plain action labels, and "Turn off anyway" is a plain
// secondary button, not danger-styled: the tone stays gentle, never punitive.
function openInterstitial(parent: Gtk.Window | null) {
    const dialog = new Gtk.Window({
        modal: true,
        resizable: false,
        decorated: false,
        default_width: 560,
        title: t("settings.safety.interstitial.title"),
        css_classes: ["veltrix-alert-dialog", "veltrix-safety-interstitial"],
    })
    if (parent) dialog.transient_for = parent

    const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })

    // The app's own icon, above the heading — the kit's `.veltrix-alert-icon`
    // slot, as the portal consent dialogs do (macOS alerts carry the app
    // icon). The Veltrix mark, in its own navy/blue (fixed colours since the
    // 2026-11-14 logo change).
    const markImage = new Gtk.Image({ pixel_size: 48, margin_top: 24 })
    markImage.gicon = Gio.FileIcon.new(Gio.File.new_for_path(
        `${SHELL_ROOT}/assets/veltrix/assets/veltrix-symbolic.svg`))
    markImage.add_css_class("veltrix-alert-icon")
    root.append(markImage)

    root.append(new Gtk.Label({
        label: t("settings.safety.interstitial.title"),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["veltrix-alert-heading"],
        margin_top: 12,
        margin_start: 24,
        margin_end: 24,
    }))

    root.append(new Gtk.Label({
        label: t("settings.safety.interstitial.cite"),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["veltrix-safety-cite"],
        margin_top: 16,
        margin_start: 24,
        margin_end: 24,
    }))

    // Arabic first, larger, RTL, in the Quranic font — then the English
    // directly underneath it, smaller and dimmer (Inter, the interface font).
    const arabic = new Gtk.Label({
        label: VERSE_AR_24_30,
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["veltrix-safety-verse-ar"],
        margin_top: 8,
        margin_start: 24,
        margin_end: 24,
    })
    arabic.set_direction(Gtk.TextDirection.RTL)
    root.append(arabic)

    root.append(new Gtk.Label({
        label: t("settings.safety.interstitial.english"),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["veltrix-safety-verse-en"],
        margin_top: 12,
        margin_start: 24,
        margin_end: 24,
    }))

    // Who translated the English: Adnan's wording is faithful (Pickthall's
    // opening, Sahih International's middle) and is kept, not replaced —
    // but a translation under a Quran citation must be attributed (halal
    // rubric 4.4.5, Ruling 3), never presented as a single named translation.
    root.append(new Gtk.Label({
        label: t("settings.safety.interstitial.attribution"),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["veltrix-safety-attrib"],
        margin_top: 4,
        margin_start: 24,
        margin_end: 24,
    }))

    root.append(new Gtk.Label({
        label: t("settings.safety.interstitial.note"),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["veltrix-alert-body"],
        margin_top: 16,
        margin_start: 24,
        margin_end: 24,
    }))

    const countdownLabel = new Gtk.Label({
        label: "",
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["veltrix-safety-countdown"],
        margin_top: 16,
        margin_start: 24,
        margin_end: 24,
    })
    root.append(countdownLabel)

    let done = false
    let tickId = 0

    const respond = (id: string) => {
        if (done) return
        done = true
        if (tickId) { GLib.source_remove(tickId); tickId = 0 }
        dialog.destroy()
        if (id !== "turn-off") return
        // Confirmed after the full pause: the user's choice is respected.
        // A dismissed polkit prompt is silence, not an error (see below).
        void safetyConfig.setContentFilter(false).catch((e) => {
            if (e instanceof ApplyCancelled) return
            void runSettingsAction(() => { throw e })
        })
    }

    const { box: buttonBox, buttons } = dialogButtonRow([
        { id: "keep", label: t("settings.safety.interstitial.keep"), suggested: true },
        { id: "turn-off", label: t("settings.safety.interstitial.turn-off"), sensitive: false },
    ], (id) => respond(id))
    root.append(buttonBox)

    // The countdown: the button stays insensitive until a REAL 60 seconds
    // have passed in this opening. At zero the button becomes usable and
    // the label says so; nothing auto-responds, nothing auto-closes.
    let remaining = REFLECT_SECONDS
    const paintCountdown = () => {
        countdownLabel.label = remaining > 0
            ? t("settings.safety.interstitial.countdown").replace("{seconds}", String(remaining))
            : t("settings.safety.interstitial.ready")
    }
    paintCountdown()
    tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        remaining -= 1
        if (remaining <= 0) {
            tickId = 0
            buttons.get("turn-off")?.set_sensitive(true)
            paintCountdown()
            return GLib.SOURCE_REMOVE
        }
        paintCountdown()
        return GLib.SOURCE_CONTINUE
    })

    // Close (Esc / window close) = keep the protection on.
    dialog.connect("close-request", () => { respond("keep"); return true })
    dialog.connect("destroy", () => {
        if (tickId) { GLib.source_remove(tickId); tickId = 0 }
    })

    dialog.set_child(root)
    dialog.present()
}

// ── Page builders ───────────────────────────────────────────────────────────

export const build = (ctx: PageCtx) => {
    return {
        // The protection toggle. A CUSTOM item, not settingRow: settingRow's
        // toggle would apply OFF the moment it is tapped, and turning this
        // off must open the interstitial first.
        //
        // The switch is VETOED on an OFF tap while the protection is on
        // (`state-set` returning true keeps the switch painted ON): the
        // switch only ever shows OFF once the system really is off. An ON
        // tap is vetoed the same way until the apply succeeds: the store
        // subscription below paints the switch ON once the system really is
        // on, so the switch never claims protection the system does not
        // have — not even for the seconds the password prompt is up.
        safetyToggle: (slot: SlotDecl) => {
            const entry = getConfigEntry("safety.contentFilter")
            if (!entry) {
                throw new Error("[safety] Unknown config key: \"safety.contentFilter\" — must be registered in config-entries.ts")
            }
            const sw = new Gtk.Switch({ active: Boolean(entry.get()), valign: Gtk.Align.CENTER })
            // The row's words sit beside the switch and nothing connects the
            // two, so the title IS the switch's accessible name (same reason
            // as VeltrixToggleRow in the kit).
            sw.update_property([Gtk.AccessibleProperty.LABEL], [slot.title])

            // Live status of the two layers, under the toggle row (VeltrixRow's
            // footer slot — see row.ts: a second line that belongs to this
            // item, not a sibling row). Re-read whenever the page is shown
            // and whenever the bit flips.
            const footerLabel = new Gtk.Label({
                label: "",
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                css_classes: ["dimmed"],
                halign: Gtk.Align.FILL,
                hexpand: true,
                xalign: 0,
            })
            // R2: when the bit says ON but the system is off/partial, the
            // page itself offers a re-apply — without it the only recovery
            // was off-then-on through the 60-second interstitial. Ghost +
            // compact is the house style for a control in this slot
            // (VeltrixRow's footer docstring; Settings → Widgets'
            // "Configure"). It is hidden unless the bit and the system
            // disagree, so the normal page is unchanged: one toggle, one
            // status line. The label is the reconcile action's own string,
            // already translated — no new translation debt.
            const applyButton = VeltrixButton({
                label: t("settings.safety.reconcile.action"),
                variant: "ghost", size: "compact",
                halign: Gtk.Align.END, valign: Gtk.Align.CENTER,
            })
            applyButton.visible = false
            applyButton.connect("clicked", () => {
                applyButton.sensitive = false
                void safetyConfig.setContentFilter(true, { force: true }).then(() => {
                    refreshStatus()
                }).catch((e) => {
                    if (e instanceof ApplyCancelled) return
                    void runSettingsAction(() => { throw e })
                }).finally(() => {
                    applyButton.sensitive = true
                })
            })
            const footerBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
            footerBox.append(footerLabel)
            footerBox.append(applyButton)
            const refreshStatus = () => {
                void getFilterStatus().then((st) => {
                    if (!st) {
                        footerLabel.label = t("settings.safety.state.unknown")
                        applyButton.visible = false
                        return
                    }
                    if (st.on === "on") {
                        const hosts = st.hosts.blocked > 0
                            ? t("settings.safety.state.hosts").replace("{count}", String(st.hosts.blocked))
                            : t("settings.safety.state.hosts-none")
                        let line = `${t("settings.safety.state.on")} · ${t("settings.safety.state.dns")} · ${hosts}`
                        // M3 (fix pass #3): resolved_loaded null means
                        // resolvectl could not verify the DNS layer — the
                        // JSON says so, and the page must say so too
                        // instead of a flat "on" with no caveat.
                        if (st.dns && st.dns.resolved_loaded === null) {
                            line += ` · ${t("settings.safety.state.unverified")}`
                        }
                        footerLabel.label = line
                        applyButton.visible = false
                    } else if (st.on === "off") {
                        footerLabel.label = t("settings.safety.state.off")
                        applyButton.visible = safetyConfig.contentFilter
                    } else {
                        // N3: partial is a checked state, not an unknown
                        // one — it used to share the "Could not check what
                        // is blocked" line, which is precisely wrong here:
                        // it DID check, and found layers missing.
                        footerLabel.label = t("settings.safety.state.partial")
                        // Halal follow-up (fix pass #3): when the bit is
                        // OFF the same partial line shows with no Apply
                        // button beside it — and that is deliberate. The
                        // button calls setContentFilter(true): it turns
                        // protection ON, so offering it here would
                        // re-enable protection under a "repair" label, and
                        // the honest re-enable path is the toggle itself
                        // (which applies immediately, no interstitial on
                        // the way on). Say instead what the state means:
                        // layers are still present after turning off.
                        if (!safetyConfig.contentFilter) {
                            footerLabel.label += ` ${t("settings.safety.state.partial-off-note")}`
                        }
                        applyButton.visible = safetyConfig.contentFilter
                    }
                })
            }
            onPageShown(refreshStatus)

            let programmatic = false
            sw.connect("state-set", (_sw: any, state: boolean) => {
                if (programmatic) return false
                if (state === true) {
                    // Veto the tap: the switch stays OFF until the apply has
                    // actually succeeded, and the store subscription below
                    // paints it ON then. A cancelled or failed apply leaves
                    // it OFF — the system is still unprotected, and the
                    // switch says so. (No interstitial on the way on.)
                    void safetyConfig.setContentFilter(true).catch((e) => {
                        if (e instanceof ApplyCancelled) return
                        void runSettingsAction(() => { throw e })
                    })
                    return true
                }
                if (safetyConfig.contentFilter) {
                    openInterstitial(ctx.page.get_root() as Gtk.Window | null)
                    return true // veto: the switch stays ON until confirmed
                }
                return false
            })

            const row = createRow(slot.title, slot.subtitle, sw, undefined, undefined, footerBox)
            bindWhileRealized(row, () => {
                refreshStatus()
                return safetyConfig.subscribe("contentFilter", (v) => {
                    programmatic = true
                    sw.set_active(v)
                    programmatic = false
                    refreshStatus()
                })
            })
            return row
        },

        // ── Firewall status (v1.2) ──────────────────────────────────────
        // READ-ONLY: `ufw status` / `firewall-cmd --state`, no pkexec, no
        // change, nothing installed from here. VELTRIX ships no firewall
        // by default, so the honest answer is usually "not installed" — the
        // row says that plainly instead of claiming protection that is not
        // there. A firewall filters unwanted INCOMING connections; it does
        // not block adult sites (that is the toggle above) and it does not
        // hide traffic from the network (that is what a VPN is for).
        firewallStatus: (slot: SlotDecl) => {
            const label = staticLabel(t("settings.safety.state.unknown"))
            label.update_property([Gtk.AccessibleProperty.LABEL], [slot.title])
            const refresh = () => {
                void probeFirewall().then((state) => {
                    label.label = state === "on"
                        ? t("settings.safety.firewall.on")
                        : state === "off"
                            ? t("settings.safety.firewall.off")
                            : state === "absent"
                                ? t("settings.safety.firewall.not-installed")
                                : t("settings.safety.state.unknown")
                })
            }
            onPageShown(refresh)
            return createRow(slot.title, slot.subtitle, label)
        },
    }
}

// ── Firewall probe ──────────────────────────────────────────────────────────
// ufw first, firewalld second; a missing binary throws in execAsync and
// falls through to the next check, so "no firewall installed" is a checked
// answer, not a guess. Unprivileged reads only — neither command changes
// anything, and no output is logged.
async function probeFirewall(): Promise<"on" | "off" | "absent" | "unknown"> {
    try {
        const out = await execAsync(["ufw", "status"], { timeoutMs: 5000 })
        if (/Status:\s*active/i.test(out)) return "on"
        if (/Status:\s*inactive/i.test(out)) return "off"
        return "unknown"
    } catch { /* no ufw — try firewalld */ }
    try {
        const out = await execAsync(["firewall-cmd", "--state"], { timeoutMs: 5000 })
        return out.trim() === "running" ? "on" : "off"
    } catch { /* no firewalld either */ }
    return "absent"
}
