// The built-in Assistant's PROVIDER registry — the user-facing vocabulary of
// the brain picker (Settings → AI).
//
// VELTRIX fork (Phase 0): the Assistant talks to a LOCAL Ollama only.
// The hosted providers (Anthropic, OpenAI, Google, SpaceXAI), the "custom"
// endpoint escape hatch and the whole API-key path were DELETED — API keys
// and undisclosed network calls are banned by the security rubric. There is
// exactly one provider, it needs no key, and its endpoint is FIXED to
// http://localhost:11434/v1 (not editable): the daemon refuses any other
// host, so a stale pre-fork config can never point the Assistant at a
// remote server. The Assistant is OFF by default (brainProvider "") and
// only runs when the user picks Ollama in Settings → AI.
export interface AgentProvider {
    /** Stable id. Persisted in org.veltrix.ai. */
    id: string
    /** Wire protocol: only the OpenAI-compatible shape remains (Ollama speaks it). */
    backend: "openai"
    /** Base URL. Fixed: localhost Ollama. */
    endpoint: string
    /** Label comes from i18n rather than the brand table. */
    custom?: boolean
    /** Local runtime: no API key needed. Always true now. */
    local?: boolean
}

export const AGENT_PROVIDERS: AgentProvider[] = [
    { id: "ollama", backend: "openai", endpoint: "http://localhost:11434/v1", local: true },
]

export function providerById(id: string): AgentProvider | null {
    return AGENT_PROVIDERS.find(p => p.id === id) ?? null
}
