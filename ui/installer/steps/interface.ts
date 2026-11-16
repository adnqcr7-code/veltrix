// Step — Choose your interface: macOS or iPad Mode (Adnan, 2026-11-12).
//
// Two ways to use the same desktop. macOS is the classic desktop —
// windows, dock, menu bar — and it is the default (pre-selected, marked
// Recommended). iPad Mode turns the whole screen into a home screen with
// big app icons and widgets, still with a mouse and keyboard — no phone
// frame. The choice is a preference, not a different system: the same
// bar, the same dock, the same apps underneath, and Settings → Interface
// flips it later either way.
//
// Each option shows a real preview image: the macOS desktop and the
// iPad home screen as the concept renders draw them
// (`ui/installer/assets/interface-{macos,ipad}.jpg`, downscaled from
// `~/workspace/veltrix/concept/desktop.png` and `view-ipad.png`).
// The images are labelled previews on the page itself — they are renders
// of the design, not screenshots of the installed machine — and a missing
// file degrades to a text card rather than a broken image: the choice
// must never depend on an asset loading.
//
// The answer is `interface.mode` ("macos" | "ipad"); the plan applies it
// only when it is "ipad" (lib/plan.ts appends a custom command that sets
// `org.veltrix.interface ipad-mode` for the new user — the schema default
// is already false, so macOS needs no command at all). The summary page
// reads the answer back, like every other choice.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import type { Step } from "../lib/flow"
import { t } from "../lib/i18n"
import { getAnswers, setInterfaceAnswer, type InterfaceMode } from "../lib/answers"
import { heading, prose } from "./common"

/** Preview image, resolved like the installer's stylesheet: the dev tree first, then the installed path. */
function previewPath(file: string): string | null {
  const candidates = [
    `./ui/installer/assets/${file}`,
    `./assets/${file}`,
    `/usr/share/veltrix/ui/installer/${file}`,
  ]
  for (const p of candidates) {
    if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p
  }
  return null
}

export function InterfaceStep(): Step {
  // macOS is the default: pre-selected, and the answer is seeded so a
  // person who never touches this page still installs macOS.
  let draft: InterfaceMode = getAnswers().interface?.mode ?? "macos"

  const syncAnswer = (notifyReady: () => void) => {
    setInterfaceAnswer({ mode: draft })
    notifyReady()
  }

  return {
    id: "interface",
    title: () => t("interfaceTitle"),
    nextLabel: () => t("continue"),
    // A default always exists (macOS), so this step is never blocking.
    ready: () => true,

    onEnter() {
      draft = getAnswers().interface?.mode ?? "macos"
    },

    build(notifyReady) {
      const rootBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
        vexpand: true,
      })
      rootBox.append(heading(t("interfaceHeading")))
      rootBox.append(prose(t("interfaceIntro"), "installer-prose--dim"))

      const cards = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 20,
        hexpand: true,
        halign: Gtk.Align.CENTER,
      })

      const cardButtons = new Map<InterfaceMode, Gtk.Button>()

      const buildCard = (mode: InterfaceMode, imageFile: string, titleKey: "interfaceMacos" | "interfaceIpad", descKey: "interfaceMacosDesc" | "interfaceIpadDesc", recommended: boolean): Gtk.Button => {
        const inner = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 10,
        })
        const path = previewPath(imageFile)
        if (path) {
          const picture = Gtk.Picture.new_for_filename(path)
          picture.content_fit = Gtk.ContentFit.COVER
          picture.height_request = 270
          picture.width_request = 480
          inner.append(picture)
        } else {
          // A missing preview is a missing picture, never a missing choice.
          const missing = new Gtk.Label({
            label: t("interfacePreviewMissing"),
            css_classes: ["installer-interface-preview-missing"],
            height_request: 270,
            width_request: 480,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            wrap: true,
          })
          inner.append(missing)
        }
        const titleRow = new Gtk.Box({
          orientation: Gtk.Orientation.HORIZONTAL,
          spacing: 8,
          halign: Gtk.Align.START,
        })
        const title = new Gtk.Label({
          label: t(titleKey),
          css_classes: ["installer-interface-card-title"],
          halign: Gtk.Align.START,
          xalign: 0,
        })
        titleRow.append(title)
        if (recommended) {
          const badge = new Gtk.Label({
            label: t("interfaceMacosRecommended"),
            css_classes: ["installer-interface-recommended"],
            halign: Gtk.Align.START,
          })
          titleRow.append(badge)
        }
        inner.append(titleRow)
        const desc = new Gtk.Label({
          label: t(descKey),
          css_classes: ["installer-prose", "installer-prose--dim"],
          halign: Gtk.Align.START,
          xalign: 0,
          wrap: true,
          wrap_mode: Pango.WrapMode.WORD_CHAR,
        })
        inner.append(desc)

        const button = new Gtk.Button({
          css_classes: ["installer-interface-card"],
          child: inner,
        })
        button.connect("clicked", () => {
          if (draft === mode) return
          draft = mode
          for (const [m, btn] of cardButtons) {
            btn[ m === draft ? "add_css_class" : "remove_css_class"]("is-selected")
          }
          syncAnswer(notifyReady)
        })
        cardButtons.set(mode, button)
        return button
      }

      cards.append(buildCard("macos", "interface-macos.jpg", "interfaceMacos", "interfaceMacosDesc", true))
      cards.append(buildCard("ipad", "interface-ipad.jpg", "interfaceIpad", "interfaceIpadDesc", false))
      rootBox.append(cards)

      // Restore the saved choice (or the macOS default) every time the page is built.
      for (const [m, btn] of cardButtons) {
        btn[m === draft ? "add_css_class" : "remove_css_class"]("is-selected")
      }
      // Seed the answer so the summary and the plan see macOS even if the
      // person walks straight past this page.
      syncAnswer(notifyReady)

      rootBox.append(prose(t("interfaceChangeLater"), "installer-prose--dim"))
      return rootBox
    },
  }
}
