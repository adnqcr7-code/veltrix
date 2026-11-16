#!/usr/bin/env bash
# update-download-probe — harness test for bin/veltrix-update-download.
#
# Runs the downloader against a scratch HOME and a local fake GitHub
# (a Python HTTP server serving releases/latest JSON + tarballs +
# .sha256 sidecars). Nothing leaves the machine: no real GitHub call.
# Exit 0 = all pass.
#
# Usage: ./scripts/dev/update-download-probe.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DL="$REPO/bin/veltrix-update-download"
PY="$(command -v python3)"
T="$(mktemp -d /tmp/veltrix-dl-probe.XXXXXX)"
SERVER_PID=""
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$T"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# ── Fixture HOME (installed 1.0) ─────────────────────────────────────────────
mkdir -p "$T/home/.config/veltrix" "$T/files"
printf '1.0\n' > "$T/home/.config/veltrix/.release"

# ── Fixture tarballs (a full 1.1 and a delta from 1.0) ────────────────────────
mkdir -p "$T/tree/veltrix-1.1"
printf 'new content\n' > "$T/tree/veltrix-1.1/changed.txt"
printf '1.1\n' > "$T/tree/veltrix-1.1/VERSION"
(cd "$T/tree" && tar -czf "$T/files/veltrix-1.1.tar.gz" veltrix-1.1)
mkdir -p "$T/delta/veltrix-1.1"
printf 'new content\n' > "$T/delta/veltrix-1.1/changed.txt"
printf '1.1\n' > "$T/delta/veltrix-1.1/VERSION"
printf 'd41d8cd98f00b204e9800998ecf8427e\n' > "$T/delta/MANIFEST"
printf 'old.txt\n' > "$T/delta/DELETED"
(cd "$T/delta" && tar -czf "$T/files/veltrix-1.1-delta-from-1.0.tar.gz" veltrix-1.1 MANIFEST DELETED)
FULL_SHA="$(sha256sum "$T/files/veltrix-1.1.tar.gz" | awk '{print $1}')"
DELTA_SHA="$(sha256sum "$T/files/veltrix-1.1-delta-from-1.0.tar.gz" | awk '{print $1}')"
FULL_SIZE="$(stat -c%s "$T/files/veltrix-1.1.tar.gz")"
DELTA_SIZE="$(stat -c%s "$T/files/veltrix-1.1-delta-from-1.0.tar.gz")"
printf '%s  veltrix-1.1.tar.gz\n' "$FULL_SHA" > "$T/files/veltrix-1.1.tar.gz.sha256"
printf '%s  veltrix-1.1-delta-from-1.0.tar.gz\n' "$DELTA_SHA" > "$T/files/veltrix-1.1-delta-from-1.0.tar.gz.sha256"

# ── Fake GitHub ──────────────────────────────────────────────────────────────
# Serves /repos/.../releases/latest from $T/api.json (read per request, so
# the probe can rewrite it between tests; {PORT} is substituted) and
# /releases/download/<tag>/<file> from $T/files/. If $T/slow exists, the
# tarball is delayed 2 s before serving (the cancel test's slow download).
cat > "$T/server.py" <<'PY'
import http.server, json, os, sys, time
FILES = sys.argv[1]
API = sys.argv[2]
PORTFILE = sys.argv[3]
SLOW = sys.argv[4]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/repos/adnqcr7-code/veltrix/releases/latest":
            with open(API, "r", encoding="utf-8") as f:
                body = f.read().replace("{PORT}", str(self.server.server_port))
            data = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.startswith("/releases/download/"):
            if os.path.exists(SLOW):
                time.sleep(2)
            name = self.path.rsplit("/", 1)[-1]
            path = os.path.join(FILES, name)
            if os.path.isfile(path):
                with open(path, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self.send_response(404)
        self.end_headers()
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
with open(PORTFILE, "w", encoding="utf-8") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PY

# api.json writer: $1 = include-delta (1/0), $2 = include-digest (1/0),
# $3 = tamper (1 = serve a digest that does not match the bytes), $4 = tag.
write_api() {
    "$PY" - "$T/files" "$1" "$2" "$3" "$4" "$FULL_SHA" "$DELTA_SHA" "$FULL_SIZE" "$DELTA_SIZE" "$T/api.json" <<'PY' || fail "could not write api.json"
import json, sys
_, files, delta, digest, tamper, tag, full_sha, delta_sha, full_size, delta_size, out = sys.argv
full_sha = "0" * 64 if tamper == "1" else full_sha
assets = [{"name": "veltrix-1.1.tar.gz", "size": int(full_size),
           "browser_download_url": "http://127.0.0.1:{PORT}/releases/download/v1.1/veltrix-1.1.tar.gz"}]
if digest == "1":
    assets[0]["digest"] = "sha256:" + full_sha
if delta == "1":
    d = {"name": "veltrix-1.1-delta-from-1.0.tar.gz", "size": int(delta_size),
         "browser_download_url": "http://127.0.0.1:{PORT}/releases/download/v1.1/veltrix-1.1-delta-from-1.0.tar.gz"}
    if digest == "1":
        d["digest"] = "sha256:" + delta_sha
    assets.append(d)
with open(out, "w", encoding="utf-8") as f:
    json.dump({"tag_name": tag, "assets": assets}, f)
PY
}

write_api 1 1 0 v1.1  # initial JSON, so the server never reads a missing file
"$PY" "$T/server.py" "$T/files" "$T/api.json" "$T/port" "$T/slow" &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -f "$T/port" ] && break; sleep 0.1; done
[ -f "$T/port" ] || fail "fake GitHub did not start"
PORT="$(cat "$T/port")"
export HOME="$T/home"
export VELTRIX_UPDATE_API_URL="http://127.0.0.1:$PORT/repos/adnqcr7-code/veltrix/releases/latest"
export VELTRIX_UPDATE_DOWNLOAD_BASE="http://127.0.0.1:$PORT/releases/download"

# ── 1. check: latest 1.1, newer, delta offered ────────────────────────────────
write_api 1 1 0 v1.1
OUT="$("$PY" "$DL" check)" || fail "check exited $?"
echo "$OUT" | grep -q '"latest": "1.1"' || fail "check lacks latest 1.1: $OUT"
echo "$OUT" | grep -q '"newer": true' || fail "check does not say newer: $OUT"
echo "$OUT" | grep -q 'veltrix-1.1-delta-from-1.0.tar.gz' || fail "check lacks the delta: $OUT"
pass "check: latest 1.1, newer, delta offered"

# ── 2. download: delta first when rsync is here ──────────────────────────────
OUT="$("$PY" "$DL" download)" || fail "download exited $?"
echo "$OUT" | grep -q "ready: veltrix-1.1-delta-from-1.0.tar.gz (delta" || fail "download did not take the delta: $OUT"
ST="$("$PY" "$DL" status)"
echo "$ST" | grep -q '"state": "ready"' || fail "status is not ready: $ST"
echo "$ST" | grep -q '"kind": "delta"' || fail "status kind is not delta: $ST"
echo "$ST" | grep -q "\"sha256\": \"$DELTA_SHA\"" || fail "status sha is not the delta sha: $ST"
[ -f "$T/home/.local/share/veltrix-update/staged/veltrix-1.1-delta-from-1.0.tar.gz" ] || fail "staged delta missing"
[ "$(sha256sum "$T/home/.local/share/veltrix-update/staged/veltrix-1.1-delta-from-1.0.tar.gz" | awk '{print $1}')" = "$DELTA_SHA" ] || fail "staged delta bytes do not match"
grep -q '"version": "1.1"' "$T/home/.local/share/veltrix-update/staged/release.json" || fail "release.json lacks version 1.1"
pass "download: delta first, verified, staged, status ready"

# ── 3. cancel: staged dropped, back to idle ──────────────────────────────────
"$PY" "$DL" cancel >/dev/null || fail "cancel exited $?"
[ ! -d "$T/home/.local/share/veltrix-update/staged" ] || fail "cancel left the staged dir"
ST="$("$PY" "$DL" status)"
echo "$ST" | grep -q '"state": "idle"' || fail "status is not idle after cancel: $ST"
pass "cancel drops the staged download and returns to idle"

# ── 4. No delta offered: full tarball ─────────────────────────────────────────
write_api 0 1 0 v1.1
OUT="$("$PY" "$DL" download)" || fail "full download exited $?"
echo "$OUT" | grep -q "ready: veltrix-1.1.tar.gz (full" || fail "download did not take the full tarball: $OUT"
pass "no delta offered: falls back to the full tarball"

# ── 5. No rsync: full tarball even when a delta is offered ────────────────────
"$PY" "$DL" cancel >/dev/null
write_api 1 1 0 v1.1
mkdir -p "$T/emptybin"  # a PATH with no rsync in it
OUT="$(PATH="$T/emptybin" "$PY" "$DL" download)" || fail "no-rsync download exited $?"
echo "$OUT" | grep -q "ready: veltrix-1.1.tar.gz (full" || fail "no-rsync download did not take the full tarball: $OUT"
pass "no rsync: full tarball even when a delta is offered"

# ── 6. Tampered tarball: digest mismatch fails closed ─────────────────────────
"$PY" "$DL" cancel >/dev/null
write_api 0 1 1 v1.1
if "$PY" "$DL" download >/dev/null 2>"$T/tamper.err"; then fail "tampered download succeeded"; fi
grep -q "SHA-256 mismatch" "$T/tamper.err" || fail "tampered download failed for the wrong reason: $(cat "$T/tamper.err")"
ST="$("$PY" "$DL" status)"
echo "$ST" | grep -q '"state": "failed"' || fail "status is not failed after tamper: $ST"
[ ! -f "$T/home/.local/share/veltrix-update/staged/veltrix-1.1.tar.gz" ] || fail "tampered tarball was staged"
pass "tampered tarball: SHA-256 mismatch fails closed, nothing staged"

# ── 7. No API digest: the .sha256 sidecar is the fallback ─────────────────────
"$PY" "$DL" cancel >/dev/null
write_api 0 0 0 v1.1
OUT="$("$PY" "$DL" download)" || fail "sidecar download exited $?"
echo "$OUT" | grep -q "ready: veltrix-1.1.tar.gz (full" || fail "sidecar download did not verify: $OUT"
pass "no API digest: .sha256 sidecar verifies the download"

# ── 8. Lock held: second invocation reports the current status, exits 0 ───────
"$PY" "$DL" cancel >/dev/null
LOCK="$T/home/.local/share/veltrix-update/update.lock"
mkdir -p "$(dirname "$LOCK")"
touch "$LOCK"
flock "$LOCK" -c 'sleep 5' &
FLOCK_PID=$!
sleep 0.5
OUT="$("$PY" "$DL" download)" || fail "locked download exited non-zero"
echo "$OUT" | grep -q '"state": "idle"' || fail "locked download did not report the current status: $OUT"
wait "$FLOCK_PID"
pass "lock held: second invocation reports status and exits 0"

# ── 9. Bad tag: not a version, fails ──────────────────────────────────────────
write_api 0 1 0 banana
if "$PY" "$DL" check >/dev/null 2>"$T/badtag.err"; then fail "bad-tag check succeeded"; fi
grep -q "not a version" "$T/badtag.err" || fail "bad-tag check failed for the wrong reason: $(cat "$T/badtag.err")"
pass "bad published tag fails closed"

# ── 10. Cancel mid-download: the flag stops the download, status idle ────────
write_api 0 1 0 v1.1
touch "$T/slow"  # the server delays the tarball 2 s; cancel lands first
"$PY" "$DL" download >"$T/slow-dl.out" 2>"$T/slow-dl.err" &
DL_PID=$!
sleep 0.5
"$PY" "$DL" cancel >/dev/null || fail "cancel during download exited $?"
DL_RC=0
wait "$DL_PID" || DL_RC=$?
rm -f "$T/slow"
[ "$DL_RC" = 0 ] || fail "cancelled download exited $DL_RC: $(cat "$T/slow-dl.err")"
grep -q "cancelled" "$T/slow-dl.out" || fail "cancelled download did not say so: $(cat "$T/slow-dl.out")"
ST="$("$PY" "$DL" status)"
echo "$ST" | grep -q '"state": "idle"' || fail "status is not idle after cancel: $ST"
[ ! -f "$T/home/.local/share/veltrix-update/staged/veltrix-1.1.tar.gz" ] || fail "cancelled download left a staged file"
# And a stale flag must not abort the NEXT download.
touch "$T/home/.local/share/veltrix-update/cancel"
OUT="$("$PY" "$DL" download)" || fail "download after a stale flag exited $?"
echo "$OUT" | grep -q "ready: veltrix-1.1.tar.gz (full" || fail "stale flag aborted the next download: $OUT"
pass "cancel mid-download stops it (status idle); a stale flag does not abort the next one"

echo "update-download-probe: ALL PASS"
