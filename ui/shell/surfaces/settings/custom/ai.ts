import Gtk from "gi://Gtk?version=4.0"
import { createRow, createStackedRow, staticLabel, actionRow, bindWhileRealized } from "../SettingsHelpers"
import { VeltrixButton, VeltrixDropDown } from "../../../../lib/veltrix-kit"
import agentConfig from "../../../core/AgentConfig"
import { providerById } from "../../../core/AgentProviders"
import { fetchModels } from "../../../core/AgentCatalog"
import { configKeys } from "../../../core/ConfigRegistry"
import { t } from "../../../core/i18n"
import type { PageCtx, ItemBuilder } from "../PreferencePage"

// VELTRIX fork (Phase 0): the Assistant talks to a LOCAL Ollama only.
// There is no API key anywhere in this build — the hosted providers, the
// "custom endpoint" escape hatch and the whole keyring path (Secret,
// KEY_SCHEMA, storeKey/clearKey, the password row) were DELETED. The
// endpoint is fixed to http://localhost:11434/v1 and shown, not editable;
// bin/veltrix-agent refuses any non-loopback endpoint. The Assistant is OFF
// by default (no provider picked) and only runs when the user picks Ollama.

const OLLAMA_ENDPOINT = "http://localhost:11434/v1"

export const build = (ctx: PageCtx) => {
    // ── Model row: free text + an optional catalog fetched from local Ollama ──
    // The ENTRY stays the source of truth. The dropdown is an aid: it appears only
    // after a successful fetch and just fills the entry. That ordering matters —
    // a catalog can fail (no server, no network) and the
    // user must still be able to type an id, so nothing is ever gated on it.
    const modelEntry = new Gtk.Entry({
        text: agentConfig.brainModel, hexpand: true,
        placeholder_text: t("settings.ai.brain.model.placeholder"),
    })
    // Unlike the other entries, an EMPTY value commits: clearing the model must
    // actually clear it. Reverting to the stored value on blank (the entryRow
    // convention) made a deleted id reappear on focus-out — user-caught 2026-07-21.
    const commitModel = () => {
        const v = modelEntry.get_text().trim()
        if (v !== agentConfig.brainModel) agentConfig.setBrainModel(v)
    }
    modelEntry.connect("activate", commitModel)
    const modelFocus = new Gtk.EventControllerFocus()
    modelFocus.connect("leave", commitModel)
    modelEntry.add_controller(modelFocus)

    const modelList = new Gtk.StringList({ strings: [] })
    const modelDrop = VeltrixDropDown({ model: modelList, visible: false, valign: Gtk.Align.CENTER })
    let suppressDropCb = false
    // Index 0 is a PLACEHOLDER, not a model. GtkDropDown builds its own
    // GtkSingleSelection with `autoselect` on, which refuses to hold "nothing
    // selected" — set INVALID_LIST_POSITION and it snaps back to item 0. So the
    // catalog can't simply be left unselected: without a placeholder the first
    // model in the list always looks chosen, which reads as "this is your model"
    // for something the user never picked (user-caught 2026-07-22).
    //
    // And it RESTS on that placeholder forever: the dropdown is a menu you pick
    // from, not a second place the value lives. It used to preselect the
    // configured model, which put the same id in the entry AND in the list right
    // below it — one value shown twice, and the reason the pair read as
    // redundant (user-caught 2026-08-02). The entry above is the single display
    // of the value, and the id landing in it IS the confirmation that the pick
    // registered. Snapping back also makes re-picking the current model work,
    // which a sticky selection silently forbade (no `notify::selected` when the
    // chosen row is already selected — so retyping was the only way back to a
    // model you had strayed from).
    modelDrop.connect("notify::selected", () => {
        if (suppressDropCb) return
        // Row 0 selects nothing on purpose — never commit it over a real value.
        // It is also where we park ourselves after every pick, and that write
        // re-enters here: without the early-out it would commit the placeholder.
        if (modelDrop.selected === 0) return
        const item = modelList.get_string(modelDrop.selected)
        if (item) { modelEntry.set_text(item); commitModel() }
        // Back to "Choose a model…" — guarded, since this is a selection change
        // like any other and would otherwise re-enter the handler above.
        suppressDropCb = true
        modelDrop.selected = 0
        suppressDropCb = false
    })

    const fetchBtn = VeltrixButton({ label: t("settings.ai.brain.model.fetch"), pill: true })
    const modelStatus = new Gtk.Label({
        css_classes: ["veltrix-row-subtitle"], halign: Gtk.Align.START, xalign: 0,
        wrap: true, visible: false,
    })

    fetchBtn.connect("clicked", () => {
        const p = providerById(agentConfig.brainProvider)
        if (!p) return
        fetchBtn.sensitive = false
        modelStatus.visible = true
        modelStatus.label = t("settings.ai.brain.model.fetching")
        fetchModels(p, agentConfig.brainEndpoint, (r) => {
            fetchBtn.sensitive = true
            if (r.models.length) {
                suppressDropCb = true
                while (modelList.get_n_items() > 0) modelList.remove(0)
                modelList.append(t("settings.ai.brain.model.choose"))
                r.models.forEach(m => modelList.append(m))
                // Rests on the placeholder — the catalog never displays the
                // configured model, the entry above does.
                modelDrop.selected = 0
                suppressDropCb = false
                modelDrop.visible = true
                modelStatus.visible = false
            } else {
                modelDrop.visible = false
                modelStatus.label = t("settings.ai.brain.model.failed").replace("%s", r.error)
            }
        })
    })

    // One control per line: the id you are setting, the catalog that fills it once
    // "Find models" answers, then the action, then its status. All three used to
    // share a single row, so after a fetch an entry, a dropdown and a button
    // competed for one line and each got a stub of it (user-caught 2026-08-02).
    // The dropdown WRITES INTO the entry (see notify::selected) — it is a picker
    // for the field above it, not a second field, which is why it sits directly
    // under it rather than beside the button that populates it.
    modelEntry.hexpand = true
    modelDrop.hexpand = true
    const modelBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })
    modelBox.append(modelEntry)
    modelBox.append(modelDrop)
    modelBox.append(actionRow(fetchBtn))
    modelBox.append(modelStatus)

    // Endpoint: FIXED to the local Ollama, shown as a label — not an entry.
    // Nothing here lets the Assistant point at a remote host.
    const endpointLabel = new Gtk.Label({
        label: OLLAMA_ENDPOINT, halign: Gtk.Align.START, xalign: 0,
        selectable: true,
    })

    // Row visibility per provider: the model is always editable (a stale default
    // must be a retype, never a dead end). The endpoint row is display-only.
    //
    // 🔑 The provider is this group's CONTEXT, not one of its values: the model
    // and every placeholder are derived from it. `shownProvider` is the one the
    // widgets were last built around, so a change made anywhere else can be
    // recognised as a change of context rather than of value.
    let shownProvider = agentConfig.brainProvider
    let modelRow: Gtk.ListBoxRow | null = null
    let endpointRow: Gtk.ListBoxRow | null = null

    function refreshSensitivity() {
        shownProvider = agentConfig.brainProvider
        const p = providerById(agentConfig.brainProvider)
        if (modelRow) modelRow.sensitive = !!p
        if (endpointRow) endpointRow.visible = !!p
        modelEntry.set_text(agentConfig.brainModel)
        endpointLabel.label = agentConfig.brainEndpoint || OLLAMA_ENDPOINT
        // A catalog belongs to the provider that answered it — drop it on every
        // switch, or a stale list would sit there offering models to Ollama.
        modelDrop.visible = false
        modelStatus.visible = false
    }

    // ⚠️ Re-derive the whole context when the provider moves; when it hasn't,
    // keep the free-text field honest without stealing what someone is
    // in the middle of typing.
    bindWhileRealized(ctx.page, () => {
        const sync = () => {
            if (agentConfig.brainProvider !== shownProvider) { refreshSensitivity(); return }
            if (!modelEntry.has_focus && modelEntry.get_text() !== agentConfig.brainModel)
                modelEntry.set_text(agentConfig.brainModel)
        }
        sync()
        return agentConfig.onChange(sync)
    })

    return {
        brainModel: (slot) => {
            modelRow = createStackedRow(slot.title, slot.subtitle, modelBox)
            return modelRow
        },
        brainEndpoint: (slot) => {
            endpointRow = createStackedRow(slot.title, slot.subtitle, endpointLabel)
            return endpointRow
        },
        mcpConnectPath: (slot) => createRow(
            slot.title,
            slot.subtitle,
            staticLabel("~/.config/veltrix/.mcp.json"),
        ),
        exposedSettings: (slot) => createRow(
            slot.title,
            slot.subtitle,
            staticLabel(String(configKeys().length)),
        ),
        // The value is "always", and it has to be SAID. This row's group answers questions
        // about the surface with a fact in the trailing slot (the row above it prints a
        // count); this one printed an empty label, so the one row on the page whose whole
        // point is that no toggle can take it away was the row that answered nothing.
        stateRead: (slot) => createRow(
            slot.title,
            slot.subtitle,
            staticLabel(t("settings.ai.state-read.value")),
        ),
    } satisfies Record<string, ItemBuilder>
}
