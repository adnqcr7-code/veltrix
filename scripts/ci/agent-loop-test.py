#!/usr/bin/env python3
# agent-loop-test.py — a hermetic integration test for bin/veltrix-agent.
#
# WHY THIS EXISTS: every serious Assistant bug so far was a WIRE-SHAPE bug in the
# daemon's stream parsing — a tool call that finishes with "stop" instead of
# "tool_calls", arguments split across chunks, a provider that omits `index`. Each
# was caught by hand, in a live session, after it shipped. This test replays those
# exact shapes against the real daemon and asserts the tool-use loop still works,
# so a regression fails in CI instead of in the user's face. It also pins both
# halves of the 5xx retry policy:
#   - a transient 503 before the first token MUST be retried and then succeed;
#   - a 4xx (client error) MUST NOT be retried — it surfaces immediately.
#
# HERMETIC: no network, no API key, no real provider, no running shell. A tiny
# OpenAI-compatible mock stands in for the LLM; a stub `veltrix-ipc` on PATH stands in for
# the shell so tool execution returns a value instead of failing. The daemon runs
# exactly as installed (gjs), reading throwaway settings (GSettings keyfile backend) under a temp
# XDG_CONFIG_HOME and persisting its session under a temp XDG_STATE_HOME — both
# per case, so cases cannot leak history into each other and running this on a
# real machine cannot touch your own conversation. Needs only: gjs, curl, python3
# (and the Secret-1 typelib the daemon imports — gir1.2-secret-1 on Debian/Ubuntu).
#
# Run locally:  python3 scripts/ci/agent-loop-test.py
# Exit 0 = pass, non-zero = a failure (with the daemon's telemetry printed).

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DAEMON = REPO / "bin" / "veltrix-agent"

# The daemon reads its configuration from GSettings, org.veltrix.ai (#573). Each case
# gets the keyfile backend inside its own temp XDG_CONFIG_HOME, against schemas
# compiled once from the tree — no bus, no dconf, and never the developer's own
# settings (with the default backend a dev machine would hand the daemon ITS gates).
SCHEMA_DIR = Path(tempfile.mkdtemp(prefix="veltrix-agent-schemas-"))
for xml in (REPO / "config" / "gsettings").glob("*.gschema.xml"):
    shutil.copy(xml, SCHEMA_DIR)
subprocess.run(["glib-compile-schemas", "--strict", str(SCHEMA_DIR)], check=True)


def write_ai_settings(config_home: Path, values: dict) -> None:
    """Write org.veltrix.ai into the keyfile backend's file. Field names are the
    store's camelCase; values become GVariant text (JSON strings, maps and
    booleans are all valid GVariant text as they are)."""
    kebab = lambda k: "".join("-" + c.lower() if c.isupper() else c for c in k)
    lines = ["[org/veltrix/ai]"]
    for k, v in values.items():
        lines.append(f"{kebab(k)}={json.dumps(v)}")
    keyfile = config_home / "glib-2.0" / "settings" / "keyfile"
    keyfile.parent.mkdir(parents=True, exist_ok=True)
    keyfile.write_text("\n".join(lines) + "\n")

TOOL = "set_config"
ARGS = '{"key":"appearance.accent","value":"blue"}'
FINAL = "Done — the accent is now blue."
DEADLINE_S = 30

# Computer-use scenario. `role` is omitted while `occurrence` is given ON PURPOSE:
# veltrix-click reads the tail POSITIONALLY, so an omitted role has to be padded
# with "" — drop it and the occurrence lands in the role slot, filtering for a
# control whose role is "2" (which matches nothing, silently).
CLICK_ARGS = '{"app":"nautilus","node":"Trash","occurrence":2}'
CLICK_ARGV = ["app", "nautilus", "Trash", "", "2"]

# VELTRIX fork (Phase 0 fix): the hosted Anthropic/Gemini lanes are DELETED
# with the Assistant's API-key path — the daemon has no Anthropic or Gemini
# handler any more, so there is nothing for a stub `curl` to drive. The only
# lane left is the OpenAI-compatible one (Ollama, fixed localhost endpoint),
# driven through the mock HTTP server below.


# ── The mock LLM (OpenAI-compatible streaming) ───────────────────────────────
class Mock(BaseHTTPRequestHandler):
    mode = "retry"        # "retry" | "client_error" | "computer_use", per scenario
    hits = 0
    served_5xx = False
    last_tools = []       # tool NAMES offered in the most recent request
    last_tool_defs = []   # the full tool objects — run_action's action index is IN its description
    last_messages = []    # messages of the most recent request (tool results included)

    @classmethod
    def reset(cls, mode):
        cls.mode, cls.hits, cls.served_5xx = mode, 0, False
        cls.last_tools = []
        cls.last_tool_defs = []
        cls.last_messages = []

    def log_message(self, *a):
        pass  # quiet

    @staticmethod
    def _chunk(delta=None, finish=None, usage=None):
        obj = {"id": "m1", "object": "chat.completion.chunk", "model": "mock"}
        if usage is not None:
            obj["usage"], obj["choices"] = usage, []
        else:
            obj["choices"] = [{"index": 0, "delta": delta or {}, "finish_reason": finish}]
        return "data: " + json.dumps(obj) + "\n\n"

    def _fail(self, code, message):
        payload = json.dumps({"error": {"message": message}}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        Mock.hits += 1
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}
        messages = payload.get("messages", [])
        Mock.last_tools = [t.get("function", {}).get("name") for t in payload.get("tools", [])]
        Mock.last_tool_defs = payload.get("tools", [])
        Mock.last_messages = messages
        has_tool_result = any(m.get("role") == "tool" for m in messages)
        tool_results = sum(1 for m in messages if m.get("role") == "tool")

        # A 4xx must be surfaced, never retried: fail every request the same way.
        if Mock.mode == "client_error":
            self._fail(400, "invalid api key (test)")
            return

        # retry mode: a transient 503 on first contact, then the normal loop.
        if not has_tool_result and not Mock.served_5xx:
            Mock.served_5xx = True
            self._fail(503, "service unavailable (test)")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def send(s):
            self.wfile.write(s.encode())
            self.wfile.flush()

        def call_tool(name, args, call_id):
            send(self._chunk(delta={"role": "assistant", "content": ""}))
            send(self._chunk(delta={"tool_calls": [
                {"index": 0, "id": call_id, "type": "function",
                 "function": {"name": name, "arguments": ""}}]}))
            half = len(args) // 2
            send(self._chunk(delta={"tool_calls": [{"index": 0, "function": {"arguments": args[:half]}}]}))
            send(self._chunk(delta={"tool_calls": [{"index": 0, "function": {"arguments": args[half:]}}]}))
            send(self._chunk(finish="tool_calls"))

        if Mock.mode in ("hidden_action", "hidden_catalog"):
            # The model reaches for a HIDDEN action by name. It cannot have read the
            # name off run_action's index (that is the other half of this scenario),
            # but a model that guesses — or one steered by a prompt injection in a
            # window title it just read — must still be stopped by the resolver.
            if tool_results == 0:
                action = "widget_catalog" if Mock.mode == "hidden_catalog" else "agent_new_conversation"
                call_tool("run_action", json.dumps({"action": action, "args": ["bar", "optional", "true"]}), "call_hidden")
            else:
                send(self._chunk(delta={"role": "assistant", "content": FINAL[:1]}))
                send(self._chunk(delta={"content": FINAL[1:]}))
                send(self._chunk(finish="stop"))
        elif Mock.mode == "computer_use":
            # Four helper-backed calls in one turn: a pointer click that SUCCEEDS
            # (asserted on the argv the helper received), a perception call that
            # returns a tree (asserted on the projection applied to it), one the
            # helper REFUSES (asserted on the result being marked failed), and a
            # match that finds NOTHING — the step before the expensive fallback.
            if tool_results == 0:
                call_tool("click_app", CLICK_ARGS, "call_click")
            elif tool_results == 1:
                call_tool("query_app", '{"app":"nautilus"}', "call_query")
            elif tool_results == 2:
                call_tool("query_app", "{}", "call_refused")
            elif tool_results == 3:
                call_tool("query_app", '{"app":"nautilus","match":"buscar"}', "call_nomatch")
            elif tool_results == 4:
                # Alternation. The model reached for "a|b" unprompted in a live
                # session and got five empty results, because `match` was a plain
                # substring test — and it was right to want it: the two ends of a
                # drag are two names. The left side must not match anything, so a
                # hit can only come from the OR.
                call_tool("query_app", '{"app":"nautilus","match":"zzz|Sidebar"}', "call_or")
            else:
                send(self._chunk(delta={"role": "assistant", "content": FINAL[:1]}))
                send(self._chunk(delta={"content": FINAL[1:]}))
                send(self._chunk(finish="stop"))
        elif not has_tool_result:
            # Round 1: one tool_call, arguments split across two chunks (exercises
            # the daemon's partial-JSON accumulation).
            call_tool(TOOL, ARGS, "call_1")
        else:
            # Round 2: final answer, text split across two chunks.
            send(self._chunk(delta={"role": "assistant", "content": FINAL[:1]}))
            send(self._chunk(delta={"content": FINAL[1:]}))
            send(self._chunk(finish="stop"))

        send(self._chunk(usage={"prompt_tokens": 12, "completion_tokens": 7}))
        send("data: [DONE]\n\n")


# ── Driving the real daemon over stdio ───────────────────────────────────────
def make_stub_ipc(bind: Path):
    """A stub `veltrix-ipc` so a tool call returns a value (there is no shell in CI).

    Renamed from the `ags` stub on 2026-08-18 with the daemon itself: veltrix-agent
    spawns `veltrix-ipc <cmd>` now, one argument shallower than `ags request <cmd>`.
    Miss that and every tool call fails with "No such file or directory" while the
    daemon reports it as a tolerated warning — which is exactly how this was found.
    """
    (bind / "veltrix-ipc").write_text(
        "#!/bin/sh\n"
        "case \"$1\" in\n"
        # agentNewConversation is served here on purpose: the shell really does
        # publish it, and the daemon's job is to drop it. A stub that omitted it
        # would make the denylist assertion pass without the denylist.
        "  listActions) printf '%s' "
        "'{\"toggleControlCenter\":{\"desc\":\"Toggle the control center\"},"
        "\"launchApp\":{\"desc\":\"Launch an app\"},"
        "\"agentNewConversation\":{\"desc\":\"End the conversation and begin an empty one\"},\"widgetCatalog\":{\"desc\":\"Settings catalogue control plane\"}}' ;;\n"
        "  describeConfig) printf '%s' "
        "'{\"appearance.accent\":{\"type\":\"string\",\"value\":\"purple\",\"writable\":true}}' ;;\n"
        "  dumpState) printf '%s' '{\"overlays\":{},\"dark\":false}' ;;\n"
        "  getConfig) printf '%s' '{\"appearance.accent\":\"purple\"}' ;;\n"
        "  setConfig) printf '%s' 'appearance.accent = blue' ;;\n"
        "  *) printf '%s' '{}' ;;\n"
        "esac\n"
    )
    (bind / "veltrix-ipc").chmod(0o755)


# ── The computer-use helpers: stubs that RECORD their argv ───────────────────
# The daemon's job here is to translate a tool call into the right command line
# for a helper that enforces the gate, verifies focus and drives the pointer.
# There is no compositor and no AT-SPI bus in CI, so the helpers are replaced by
# recorders: what is under test is the argv, which is exactly where a silent
# defect lives (a dropped positional pad aims at the wrong control and every
# layer still reports success).
STUB_HELPER = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
pathlib.Path(os.environ["VELTRIX_TEST_ARGV"], "@NAME@.json").write_text(json.dumps(sys.argv[1:]))
print(json.dumps(@REPLY@))
'''

# veltrix-a11y answers differently depending on whether it was given an app, so one
# stub covers both halves under test: a real-shaped TREE (projection) and a gate
# REFUSAL (the daemon must mark that result failed, not "ok" with an error inside).
# The ancestor path is deliberately deep AND long-linked — that is the shape
# measured on a live session (a Telegram list item's accessible name IS the whole
# message, repeated down every descendant's chain) and the reason the projection
# exists at all.
LONG_LINK = "list item#" + ("verbose accessible name " * 12)
# The tree shape that broke it live: a long run of identical rows FIRST and the
# control the user asked for LAST. Document order puts a GTK app's header bar at
# the end, so a positional cut loses exactly the buttons worth pressing — measured
# on Nautilus, where "Show Sidebar" sat at node 157 of 175, byte 55,313 of 60,367.
STUB_A11Y = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
pathlib.Path(os.environ["VELTRIX_TEST_ARGV"], "veltrix-a11y.json").write_text(json.dumps(sys.argv[1:]))
if not sys.argv[1:]:
    print(json.dumps({"error": "computer-use is disabled — enable it in Settings → AI"}))
    raise SystemExit
deep = " > ".join(["frame#Files", "panel", "@LONG@", "scroll pane", "list"])
rows = [{"id": "file-%03d.txt" % i, "role": "table row", "type": "table row", "text": None,
         "states": ["sensitive", "showing", "selectable"], "actions": ["click"],
         "visible": True, "window": "Files", "bounds": {"x": 0, "y": i, "w": 900, "h": 32},
         "path": deep} for i in range(120)]
tail = {"id": "Show Sidebar", "role": "toggle button", "type": "toggle button", "text": None,
        "states": ["sensitive", "showing"], "actions": ["click"], "visible": True,
        "window": "Files", "bounds": {"x": 1, "y": 2, "w": 34, "h": 34},
        "path": "frame#Files > panel > header bar"}
print(json.dumps({"source": "atspi", "app": sys.argv[1],
                  "count": len(rows) + 1, "nodes": rows + [tail]}))
'''


def make_stub_helpers(bind: Path):
    # A successful pointer action, the shape veltrix-click prints.
    p = bind / "veltrix-click"
    p.write_text(STUB_HELPER.replace("@NAME@", "veltrix-click")
                 .replace("@REPLY@", repr({"ok": True, "app": "nautilus", "mode": "app"})))
    p.chmod(0o755)
    p = bind / "veltrix-a11y"
    p.write_text(STUB_A11Y.replace("@LONG@", LONG_LINK))
    p.chmod(0o755)


def drive_daemon(port: int,
                 ai_extra: dict | None = None, argv_rec: Path | None = None,
                 prompt: str = "make the accent blue"):
    """Spawn a fresh daemon, send one user turn, return (events, stderr_lines)."""
    tmp = Path(tempfile.mkdtemp(prefix="veltrix-agent-test-"))
    try:
        (tmp / "veltrix").mkdir()
        # Empty provider → the keyring is never touched (no D-Bus in CI); the mock
        # needs no key anyway.
        # Ollama-only: the daemon's only wire lane is OpenAI-compatible, and
        # its endpoint is the fixed localhost one — pointed here at the mock
        # server's port. No hosted provider is ever configured.
        write_ai_settings(tmp, {
            "brainBackend": "openai",
            "brainProvider": "",
            "brainModel": "mock",
            "brainEndpoint": f"http://127.0.0.1:{port}/v1",
            **(ai_extra or {}),
        })
        bind = tmp / "bin"
        bind.mkdir()
        make_stub_ipc(bind)
        if argv_rec:
            make_stub_helpers(bind)
        env = dict(os.environ)
        env["XDG_CONFIG_HOME"] = str(tmp)
        env["GSETTINGS_BACKEND"] = "keyfile"
        env["GSETTINGS_SCHEMA_DIR"] = str(SCHEMA_DIR)
        # The daemon persists its conversation under XDG_STATE_HOME and RESTORES it
        # on startup, so this has to be per-case or "a fresh daemon" is a lie: the
        # previous case's history would arrive in request 1 and the mock would
        # answer the final text and skip the round-trip under test. It also keeps
        # the test off the developer's own conversation.
        env["XDG_STATE_HOME"] = str(tmp / "state")
        env["PATH"] = f"{bind}:{env.get('PATH', '')}"
        env.setdefault("LANG", "en_US.UTF-8")
        if argv_rec:
            env["VELTRIX_TEST_ARGV"] = str(argv_rec)

        proc = subprocess.Popen(
            ["gjs", "-m", str(DAEMON)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, text=True, bufsize=1,
        )

        events, stderr_lines = [], []
        done = threading.Event()

        def read_stdout():
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                events.append(ev)
                if ev.get("t") in ("done", "error"):
                    done.set()

        def read_stderr():
            for line in proc.stderr:
                stderr_lines.append(line.rstrip())

        threading.Thread(target=read_stdout, daemon=True).start()
        threading.Thread(target=read_stderr, daemon=True).start()

        proc.stdin.write(json.dumps({"t": "user", "text": prompt}) + "\n")
        proc.stdin.flush()
        done.wait(DEADLINE_S)

        try:
            proc.stdin.close()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        return events, stderr_lines
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def probe_catalog_mcp(grant: bool):
    """Settings' IPC writes cannot bypass the MCP configuration grant."""
    with tempfile.TemporaryDirectory(prefix="veltrix-catalog-mcp-") as tmp_name:
        tmp = Path(tmp_name)
        write_ai_settings(tmp, {"allowMcp": True, "allowConfigWrite": grant})
        bind = tmp / "bin"
        bind.mkdir()
        stub = bind / "veltrix-ipc"
        stub.write_text("#!/bin/sh\nprintf 'fixture catalogue'\n")
        stub.chmod(0o755)
        env = dict(os.environ, XDG_CONFIG_HOME=str(tmp), XDG_STATE_HOME=str(tmp / "state"),
                   GSETTINGS_BACKEND="keyfile", GSETTINGS_SCHEMA_DIR=str(SCHEMA_DIR),
                   PATH=f"{bind}:{os.environ.get('PATH', '')}")
        calls = [
            {"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {
                "name": "run_action", "arguments": {"name": name, "args": args}}}
            for i, (name, args) in enumerate([
                ("widgetCatalog", ["list"]),
                ("widgetCatalog", ["bar", "optional", "true"]),
                ("widgetCatalog()", ["cc", "optional", "true"]),
                ("settingsMonitor", ["mode", "DP-1", "1280x720@60"]),
                ("settingsWallpaper", ["set", "/tmp/wallpaper.png", "fade"]),
            ], 1)
        ]
        run = subprocess.run(["gjs", "-m", str(REPO / "bin" / "veltrix-mcp")],
                             input="".join(json.dumps(c) + "\n" for c in calls),
                             text=True, capture_output=True, env=env, timeout=15)
        replies = [json.loads(line) for line in run.stdout.splitlines() if line.startswith("{")]
        problems = []
        if run.returncode or len(replies) != 5:
            problems.append(f"MCP returned {run.returncode}, {len(replies)} replies: {run.stderr}")
        else:
            for i, reply in enumerate(replies):
                result = reply.get("result", {})
                error = result.get("isError", False)
                text = "".join(c.get("text", "") for c in result.get("content", []))
                blocked = i > 0 and not grant
                if error != blocked or ("config writes are disabled" if blocked else "fixture catalogue") not in text:
                    problems.append(f"unexpected MCP result for call {i + 1}: {reply}")
        return problems


def main():
    if not DAEMON.exists():
        print(f"FAIL: daemon not found at {DAEMON}", file=sys.stderr)
        return 1
    if not shutil.which("gjs"):
        print("FAIL: gjs is not installed (needed to run the daemon)", file=sys.stderr)
        return 1

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    failures = []

    def report(name, problems, events, stderr_lines):
        if problems:
            failures.append(name)
            print(f"FAIL: {name}", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
            print("  --- daemon telemetry (stderr) ---", file=sys.stderr)
            for l in stderr_lines:
                print(f"    {l}", file=sys.stderr)
        else:
            print(f"PASS: {name}")

    try:
        for grant in (False, True):
            report(f"MCP catalogue: config grant={grant}", probe_catalog_mcp(grant), [], [])
        # ── Scenario 1: tool-use loop, with a 503 that MUST be retried past ──
        Mock.reset("retry")
        events, stderr_lines = drive_daemon(port)
        types = [e.get("t") for e in events]
        problems = []
        if "error" in types:
            msg = next((e.get("message") for e in events if e.get("t") == "error"), "?")
            problems.append(f"daemon emitted an error: {msg}")
        if "done" not in types:
            problems.append(f"no 'done' event — turn never completed (events: {types})")
        if not any(e.get("t") == "tool" and e.get("name") == TOOL for e in events):
            problems.append(f"tool '{TOOL}' not parsed/dispatched")
        if not any(e.get("t") == "toolresult" and e.get("ok") for e in events):
            problems.append("no successful toolresult — the tool did not execute")
        text = "".join(e.get("text", "") for e in events if e.get("t") == "delta")
        if FINAL not in text:
            problems.append(f"final answer missing (streamed text: {text!r})")
        if not Mock.served_5xx:
            problems.append("mock never served its scripted 503 (retry path untested)")
        if Mock.hits < 3:
            problems.append(f"expected >=3 requests (503 + tool_call + final), got {Mock.hits} — 503 was NOT retried")
        report("tool-use loop + 5xx retry", problems, events, stderr_lines)

        # ── Scenario 2: a 4xx MUST surface immediately, never be retried ────
        Mock.reset("client_error")
        events, stderr_lines = drive_daemon(port)
        problems = []
        if not any(e.get("t") == "error" for e in events):
            problems.append("no 'error' event — a 4xx must surface, not vanish")
        else:
            msg = next(e.get("message", "") for e in events if e.get("t") == "error")
            if "invalid api key" not in msg:
                problems.append(f"error did not carry the provider message (got: {msg!r})")
        if Mock.hits != 1:
            problems.append(f"a 4xx was retried: expected exactly 1 request, got {Mock.hits}")
        report("4xx surfaces without retry", problems, events, stderr_lines)

        # ── Scenario 3d: the advice we give names a remedy that EXISTS ────────
        # Static, deliberately: it caught a live failure that no stub would. The
        # daemon's type_text description said "Focus the field first (do_app_action
        # … SetFocus)" — measured to be a dead end on GTK4 (ATK dropped, so
        # Component.GrabFocus returns false and most nodes carry an empty action
        # list). In the live run of 2026-07-28 the model did exactly that, wasted a
        # step, and only recovered by finding focus_window on its own. The refusal
        # in veltrix-type repeated the same wrong remedy while its sibling
        # veltrix-click already said the right one — the same advice-drift-between-
        # siblings that produced the double-`ok` bug. Both halves are pinned here.
        problems = []
        for name in ("veltrix-type", "veltrix-click"):
            src = (REPO / "bin" / name).read_text()
            line = next((l for l in src.splitlines() if "is not the focused window" in l), "")
            if not line:
                problems.append(f"{name}: the focus-gate refusal string vanished — did the gate go with it?")
                continue
            if "focus_window" not in line:
                problems.append(f"{name}: the refusal does not name focus_window: {line.strip()[:120]}")
            if "SetFocus" in line:
                problems.append(f"{name}: the refusal still points at SetFocus, which cannot focus a window")
        for name in ("veltrix-agent", "veltrix-mcp"):
            src = (REPO / "bin" / name).read_text()
            for tool in ("type_text", "press_key"):
                # The description block that follows the tool's name declaration.
                i = src.find(f'"{tool}"')
                desc = src[i:i + 1200] if i >= 0 else ""
                if not desc:
                    problems.append(f"{name}: {tool} not found")
                elif "SetFocus" in desc and "focus_window" not in desc:
                    problems.append(f"{name}: {tool} still tells the model to focus with SetFocus")
        report("computer-use: the focus advice points at a verb that works",
               problems, [], [])

        # ── Scenario 4: computer-use is gate-CONDITIONED, and the argv is right ─
        # Two properties, both invisible from the outside:
        #  (1) OFFERED, not merely permitted — with the gates off (the shipped
        #      default) the schemas must not be in the request at all. A model
        #      told about a tool it cannot use promises the user something it
        #      cannot deliver, and the schemas are re-sent on every step to do it.
        #  (2) The argv handed to the helper is what the helper's positional CLI
        #      means. Getting it wrong aims at a different control while every
        #      layer still reports success.
        Mock.reset("computer_use")
        events, stderr_lines = drive_daemon(port, prompt="empty the trash in files")
        problems = []
        offered = [t for t in Mock.last_tools if t in ("query_app", "click_app", "do_app_action")]
        if offered:
            problems.append(f"computer-use tools offered with both gates OFF: {offered}")
        report("computer-use: not offered while gated off", problems, events, stderr_lines)

        # ── Scenario 4b: a HIDDEN action is unreachable, not merely unlisted ──
        # `agentNewConversation` discards the conversation the model is standing
        # in. It exists for a person at a terminal and for an MCP client driving
        # an eval; the Assistant must not be able to call it, because a reset
        # mid-turn strands the tool_call whose tool_result the next request has to
        # carry — and because starting over is not a move inside a turn.
        # HIDDEN_ACTIONS is what enforces that, and it enforces it TWICE: the name
        # never enters run_action's index, and run_action resolves only through the
        # map built with the same filter. Both halves are asserted, because either
        # one alone is a false sense of safety — an unlisted-but-callable action is
        # exactly what a prompt injection in a window title would go looking for.
        for hidden_mode, hidden_names in (
            ("hidden_action", ("agent_new_conversation", "agentNewConversation")),
            ("hidden_catalog", ("widget_catalog", "widgetCatalog")),
        ):
            Mock.reset(hidden_mode)
            events, stderr_lines = drive_daemon(port, prompt="start a new conversation")
            problems = []
            run_action = next((t for t in Mock.last_tool_defs
                               if t.get("function", {}).get("name") == "run_action"), None)
            if not run_action:
                problems.append("run_action was not offered at all — the index assertion below proves nothing")
            else:
                index = run_action["function"].get("description", "")
                if any(name in index for name in hidden_names):
                    problems.append("the hidden action is advertised in run_action's index")
                # Guards the assertion above against passing on an EMPTY index (a
                # listActions failure, which the daemon survives by design).
                if "toggle_control_center" not in index:
                    problems.append("a visible action is missing from the index — the stub or the index broke")
            results = [e for e in events if e.get("t") == "toolresult"]
            if not results:
                problems.append("the daemon never dispatched the call — nothing was resolved either way")
            elif any(r.get("ok") for r in results):
                problems.append("a hidden action RESOLVED and ran — the denylist is advisory, not enforcing")
            report(f"{hidden_mode}: unreachable, not just unlisted", problems, events, stderr_lines)

        Mock.reset("computer_use")
        argv_rec = Path(tempfile.mkdtemp(prefix="veltrix-agent-argv-"))
        try:
            events, stderr_lines = drive_daemon(
                port,
                ai_extra={"allowComputerUse": True, "allowComputerControl": True},
                argv_rec=argv_rec,
                prompt="empty the trash in files",
            )
            problems = []
            for expected in ("query_app", "click_app", "do_app_action", "drag_app"):
                if expected not in Mock.last_tools:
                    problems.append(f"{expected} missing from the tool list with both gates on")
            click = argv_rec / "veltrix-click.json"
            if not click.exists():
                problems.append("veltrix-click was never invoked")
            else:
                got = json.loads(click.read_text())
                if got != CLICK_ARGV:
                    problems.append(f"veltrix-click argv wrong: {got} != {CLICK_ARGV}")
            results = [e for e in events if e.get("t") == "toolresult"]
            if len(results) < 3:
                problems.append(f"expected 3 tool results (click + query + refusal), got {len(results)}")
            else:
                if not results[0].get("ok"):
                    problems.append("the successful click was reported as failed")
                if not results[1].get("ok"):
                    problems.append("a successful query_app was reported as failed")
                # The refusal half: veltrix-a11y answers {"error": …} and the daemon
                # must mark THAT result failed.
                if results[2].get("ok"):
                    problems.append("a helper refusal was reported as a SUCCESSFUL tool result")
            # The projection. An accessibility tree is far bigger than a turn's
            # budget (measured live: 102 KB for Nautilus, 503 KB for Telegram
            # against a 24 KB cap) and a plain head-cut loses the wrong end: the
            # control the user named comes LAST in document order, behind the
            # content. Three assertions, each for one half of the fix.
            tree = next((m.get("content", "") for m in Mock.last_messages
                         if m.get("role") == "tool" and "table row" in str(m.get("content", ""))), "")
            if not tree:
                problems.append("the query_app result never reached the next request")
            else:
                if LONG_LINK in tree:
                    problems.append("the ancestor path was relayed at full length (not trimmed)")
                elif "… > " not in tree:
                    problems.append(f"the ancestor path was not trimmed: {tree[:200]!r}")
                if '"omitted"' not in tree:
                    problems.append("a run of 120 identical rows was not collapsed")
                # THE regression that started this: the button after the list.
                if "Show Sidebar" not in tree:
                    problems.append("the control AFTER the long list did not survive the projection")
                if '"visible"' in tree or '"window"' in tree.split('"nodes"')[0][40:]:
                    problems.append("per-node noise (visible/window) was not leaned out")
            # A match that finds NOTHING is one step from the whole-window dump —
            # measured live 2026-07-29: it cost ~78k of a 125k-token turn, spent to
            # learn that a button is called "Buscar mensajes". So the empty result
            # has to carry the labels on screen AND the price of the alternative.
            miss = next((m.get("content", "") for m in Mock.last_messages
                         if m.get("role") == "tool" and '"match":"buscar"' in str(m.get("content", ""))), "")
            alt = next((m.get("content", "") for m in Mock.last_messages
                        if m.get("role") == "tool" and '"match":"zzz|Sidebar"' in str(m.get("content", ""))), "")
            if not alt:
                problems.append("the alternation query_app result never reached the next request")
            else:
                try:
                    got_alt = json.loads(alt)
                except Exception:
                    got_alt = {}
                if not got_alt.get("count"):
                    problems.append("`a|b` matched nothing — alternation is not honoured, "
                                    "so asking for both ends of a drag in one call still fails")
                elif "Show Sidebar" not in alt:
                    problems.append(f"alternation matched, but not the right node: {alt[:200]!r}")
            if not miss:
                problems.append("the no-match query_app result never reached the next request")
            else:
                try:
                    got = json.loads(miss)
                except Exception:
                    got = {}
                showing = got.get("showing")
                if not showing:
                    problems.append("a match that found nothing did not report the labels on screen")
                # Document order would hand back file-000.txt: the stub's only
                # control sits LAST, behind 120 rows. Controls come first or the
                # list is the head-cut bug again, one level up.
                elif showing[0] != "Show Sidebar":
                    problems.append(f"labels are not control-first: {showing[:3]}")
                # …but control-first is an ORDERING, not a filter. In a file manager
                # the content IS the target: Nautilus draws file items as table
                # cells, so a role-only list offered "Open Trash" and not the file to
                # drag onto it, and the model paid a whole-window dump for the other
                # half (live, 2026-07-29). The stub's rows are `table row` for the
                # same reason.
                elif not any(s.startswith("file-") for s in showing):
                    problems.append(f"content never fills the remaining slots: {showing}")
                hint = got.get("hint", "")
                if "KB" not in hint:
                    problems.append(f"the fallback was recommended without its price: {hint!r}")
                if "was NOT empty" not in hint:
                    problems.append(f"an empty match did not say the window was not empty: {hint!r}")
            text = "".join(e.get("text", "") for e in events if e.get("t") == "delta")
            if FINAL not in text:
                problems.append(f"turn did not complete (streamed text: {text!r})")
            report("computer-use: offered when gated on, argv + refusal honest", problems, events, stderr_lines)
        finally:
            shutil.rmtree(argv_rec, ignore_errors=True)

        return 1 if failures else 0
    finally:
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
