import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { dialogButtonRow } from "../../../lib/veltrix-kit/dialog-buttons"
import { t } from "../../core/i18n"
import { SHELL_ROOT } from "../../core/Paths"

// ── The shared halal interstitial ───────────────────────────────────────────
// The reflective pause shown before a halal protection is turned OFF
// (Adnan, 2026-11-12): An-Nur 24:30 in Arabic with the English
// underneath, a real 60-second pause before "Turn off anyway" becomes
// usable, and "Keep protection on" as the primary choice. After the
// delay the user's choice is respected — deliberate, never impulsive.
// Closing the dialog (Esc / window close) keeps the protection on.
//
// REUSE DECISION (Audio Filter, 2026-11-13): this is the ONE shared
// implementation for new adopters. Content Safety (custom/safety.ts)
// has its own inline copy of the same dialog, written first and
// reviewed with it — that file is NOT touched here (its reviews stand,
// and refactoring it is a Content Safety-owned change), so the two
// copies coexist deliberately. A future safety-owned migration can
// point safety.ts at this module; until then the mechanism exists once
// for every new protection, and safety's copy is grandfathered, not a
// second copy built by this change.
//
// The shared strings (title, citation, English, attribution, countdown,
// ready, keep, turn-off) are read from the SAFETY i18n keys — the
// verse and the action labels are the same for every protection, so
// they are not duplicated per feature. The ONLY feature-specific
// string is the note (passed in): what this protection helps with.
//
// The verse: byte-identical copy of VERSE_AR_24_30 in custom/safety.ts
// (Tanzil SIMPLE, line 2821 of simple.txt, verbatim — see that file's
// comment for the halal critic's cross-check ruling and the four
// combining-mark normalisations). Do not edit the Arabic here
// independently of safety.ts; the two constants must stay identical.
// The UI cites only "Surah An-Nur · 24:30" and does NOT claim the text
// is Uthmani.
export const VERSE_AR_24_30 =
    "قُل لِّلْمُؤْمِنِينَ يَغُضُّوا مِنْ أَبْصَارِهِمْ وَيَحْفَظُوا فُرُوجَهُمْ ۚ ذَٰلِكَ أَزْكَىٰ لَهُمْ ۗ إِنَّ اللَّهَ خَبِيرٌ بِمَا يَصْنَعُونَ"

/** The reflective pause before "Turn off anyway" becomes usable (seconds).
 *  A real countdown: every opening of the dialog starts a fresh 60 seconds,
 *  there is no stored "already waited" flag, and closing + reopening the
 *  dialog restarts the wait instead of skipping it. */
const REFLECT_SECONDS = 60

export interface HalalInterstitialOpts {
    /** What this protection helps with (the feature-specific line). */
    note: string
    /** Called ONLY when the user confirms after the full pause. */
    onConfirm: () => void
}

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
export function openHalalInterstitial(parent: Gtk.Window | null, opts: HalalInterstitialOpts) {
    const dialog = new Gtk.Window({
        modal: true,
        resizable: false,
        decorated: false,
        default_width: 560,
        title: t("settings.safety.interstitial.title"),
        css_classes: ["veltrix-alert-dialog", "veltrix-halal-interstitial"],
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
        label: opts.note,
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
        opts.onConfirm()
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
