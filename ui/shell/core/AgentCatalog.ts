import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { AgentProvider } from "./AgentProviders"
import { spawn } from "../../lib/process"

// Model CATALOG — asks the provider which models it actually offers, so the model
// field can be picked from a list instead of typed from memory.
//
// Why this exists: hardcoding model ids ages badly (they churn faster than
// anything else in the provider table), and a wrong default is a dead end for a
// user who doesn't know the right string. The provider already knows the answer —
// the OpenAI-compatible shape exposes a catalog endpoint — so we ask.
//
// Transport is `curl` in a subprocess, the same house pattern bin/veltrix-agent
// uses for SSE: no new dependency, and the shell never blocks.
//
// VELTRIX fork (Phase 0): the catalog is fetched from the LOCAL Ollama only,
// with NO auth header — there is no API key anywhere in this build. The
// keyring lookup (withKey) and the per-provider auth headers were deleted.

/** Ids that are clearly not chat models. Best-effort and deliberately shallow:
 *  a catalog listing embeddings/audio/image endpoints alongside chat ones is
 *  common (OpenAI), but the rules differ per provider and age badly — so this
 *  only drops the obvious, and anything it fails to drop is still selectable
 *  rather than hidden. Never filter so hard that a valid model disappears. */
const NON_CHAT = /(embed|whisper|tts|audio|speech|image|dall-?e|moderation|rerank|vision-encoder)/i

function parseModels(json: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    try {
        const body = JSON.parse(json)
        // OpenAI-compatible servers answer `{ data: [ { id }, … ] }`. Some servers
        // answer `{ models: [ { name: "models/…" }, … ] }` —
        // different key, different field, and the id carries a `models/` prefix.
        // Accept both shapes rather than branch at the call site.
        const rows = Array.isArray(body?.data) ? body.data
            : Array.isArray(body?.models) ? body.models
            : []
        for (const r of rows) {
            const raw = typeof r?.id === "string" ? r.id
                : typeof r?.name === "string" ? r.name
                : ""
            const id = raw.replace(/^models\//, "")
            if (!id || seen.has(id) || NON_CHAT.test(id)) continue
            seen.add(id)
            out.push(id)
        }
    } catch {
        return []
    }
    return out.sort()
}

export interface CatalogResult {
    models: string[]
    /** Populated when the catalog could not be read — shown to the user as-is. */
    error: string
}

/**
 * Fetch the local Ollama model list. Never throws and never blocks: a failure
 * comes back as `error` and the caller keeps its free-text field, which stays
 * the source of truth. No auth header is ever sent — the endpoint is localhost
 * and there is no key in this build.
 */
export function fetchModels(
    _p: AgentProvider,
    endpoint: string,
    done: (r: CatalogResult) => void,
): void {
    {
        // Local-only guard, mirroring bin/veltrix-agent: refuse a non-loopback
        // endpoint outright instead of asking a remote server for its models.
        const m = /^https?:\/\/([^/:]+)/.exec(endpoint)
        const host = m ? m[1] : ""
        if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
            done({ models: [], error: `refusing non-local endpoint ${host || endpoint}` })
            return
        }
        const url = `${endpoint.replace(/\/+$/, "")}/models`

        // --fail-with-body: report HTTP errors on stderr (a server with no catalog
        // otherwise looks like an empty answer) while KEEPING the body.
        const argv = ["curl", "-sS", "--fail-with-body", "--max-time", "15", url]

        let proc: Gio.Subprocess
        try {
            proc = spawn(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
        } catch (e) {
            done({ models: [], error: String(e) })
            return
        }
        proc.communicate_utf8_async(null, null, (_s: any, res: any) => {
            let out = "", err = ""
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(res)
                out = stdout ?? ""
                err = stderr ?? ""
            } catch (e) {
                done({ models: [], error: String(e) })
                return
            }
            const models = parseModels(out)
            if (models.length) { done({ models, error: "" }); return }
            // No models: surface the provider's own message when it sent one (an
            // auth error reads far better than "nothing found").
            let msg = err.trim()
            try {
                const body = JSON.parse(out)
                msg = body?.error?.message || body?.message || msg
            } catch {}
            done({ models: [], error: msg || "no models returned" })
        })
    }
}

/** Kept for callers: the catalog never needs a key now (local Ollama only). */
export function catalogNeedsKey(_p: AgentProvider): boolean {
    return false
}

export { GLib }
