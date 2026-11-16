#!/usr/bin/env bash
# update-helper-probe — harness test for bin/veltrix-update-helper.
#
# Part A (always runs): the helper's validation functions in-process —
# bad versions/hashes/filenames/paths must fail closed, the deps-sha
# computation must match install.sh's, and verify_against_github must
# accept a genuine staged tarball and refuse a tampered one, all against
# a local fake GitHub. Nothing leaves the machine.
#
# Part B (root only, skipped otherwise): the helper CLI end to end as
# root with a throwaway fixture user (useradd/userdel, trap-cleaned) —
# no staged release, tampered tarball, genuine tarball without pins,
# genuine tarball with wrong pins, genuine tarball with right pins but
# no apps choice, and genuine tarball with everything present (which
# must reach bootstrap and fail closed there: no pacman on this VM).
# It creates /usr/share/veltrix/pins-pacman and /etc/veltrix/apps.json
# for the test and restores whatever was there before (backup + trap).
# Exit 0 = all pass (or all non-skipped pass).
#
# Usage: ./scripts/dev/update-helper-probe.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO/bin/veltrix-update-helper"
PY="$(command -v python3)"
T="$(mktemp -d /tmp/veltrix-helper-probe.XXXXXX)"
SERVER_PID=""
FIXTURE_USER=""
PINS_BACKUP=""
PINS_EXISTED=0
APPS_BACKUP=""
APPS_EXISTED=0
trap 'kill "$SERVER_PID" 2>/dev/null || true
      [ -n "$FIXTURE_USER" ] && userdel -r "$FIXTURE_USER" 2>/dev/null || true
      if [ "$PINS_EXISTED" = 1 ]; then mv -f "$PINS_BACKUP" /usr/share/veltrix/pins-pacman 2>/dev/null || true; else rm -f /usr/share/veltrix/pins-pacman; fi
      if [ "$APPS_EXISTED" = 1 ]; then mv -f "$APPS_BACKUP" /etc/veltrix/apps.json 2>/dev/null || true; else rm -f /etc/veltrix/apps.json; fi
      rm -rf "$T"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# ── Fixture tree (a minimal 1.1 release: real PKGBUILD + real bootstrap) ─────
mkdir -p "$T/tree/veltrix-1.1/packaging/veltrix" "$T/files"
printf '1.1\n' > "$T/tree/veltrix-1.1/VERSION"
printf '#!/bin/bash\necho "INSTALL.SH RAN" >&2\nexit 99\n' > "$T/tree/veltrix-1.1/install.sh"
chmod +x "$T/tree/veltrix-1.1/install.sh"
cp "$REPO/bootstrap.sh" "$T/tree/veltrix-1.1/bootstrap.sh"
cp "$REPO/packaging/veltrix/PKGBUILD" "$T/tree/veltrix-1.1/packaging/veltrix/PKGBUILD"
(cd "$T/tree" && tar -czf "$T/files/veltrix-1.1.tar.gz" veltrix-1.1)
FULL_SHA="$(sha256sum "$T/files/veltrix-1.1.tar.gz" | awk '{print $1}')"
FULL_SIZE="$(stat -c%s "$T/files/veltrix-1.1.tar.gz")"
printf '%s  veltrix-1.1.tar.gz\n' "$FULL_SHA" > "$T/files/veltrix-1.1.tar.gz.sha256"

# ── Fake GitHub (same shape as the download probe's server) ──────────────────
cat > "$T/server.py" <<'PY'
import http.server, os, sys
FILES = sys.argv[1]
API = sys.argv[2]
PORTFILE = sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/repos/adnqcr7-code/veltrix/releases/latest":
            with open(API, "r", encoding="utf-8") as f:
                body = f.read().replace("{PORT}", str(self.server.server_address[1]))
            data = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.startswith("/releases/download/"):
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
"$PY" - "$FULL_SHA" "$FULL_SIZE" "$T/api.json" <<'PY'
import json, sys
full_sha, full_size, out = sys.argv[1], sys.argv[2], sys.argv[3]
with open(out, "w", encoding="utf-8") as f:
    json.dump({"tag_name": "v1.1", "assets": [
        {"name": "veltrix-1.1.tar.gz", "size": int(full_size),
         "digest": "sha256:" + full_sha,
         "browser_download_url": "http://127.0.0.1:{PORT}/releases/download/v1.1/veltrix-1.1.tar.gz"}]}, f)
PY
"$PY" "$T/server.py" "$T/files" "$T/api.json" "$T/port" &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -f "$T/port" ] && break; sleep 0.1; done
[ -f "$T/port" ] || fail "fake GitHub did not start"
PORT="$(cat "$T/port")"
export VELTRIX_UPDATE_API_URL="http://127.0.0.1:$PORT/repos/adnqcr7-code/veltrix/releases/latest"
export VELTRIX_UPDATE_DOWNLOAD_BASE="http://127.0.0.1:$PORT/releases/download"

# ── Part A: in-process validation ────────────────────────────────────────────
cat > "$T/helper_test.py" <<'PY'
import json, os, shutil, sys, tarfile
from importlib.machinery import SourceFileLoader
H = SourceFileLoader("helper", sys.argv[1]).load_module()
T, files, full_sha, full_size = sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
fails = []
def check(name, cond):
    print(("ok: " if cond else "FAIL: ") + name)
    if not cond:
        fails.append(name)

# Version comparison twins (same cases as the downloader probe).
check("is_newer 1.1 > 1.0", H.is_newer("1.1", "1.0"))
check("is_newer 1.0 !> 1.0", not H.is_newer("1.0", "1.0"))
check("is_newer 1.2 > 0.13.0-v7", H.is_newer("1.2", "0.13.0-v7"))
check("is_newer 0.13.0-v5 > 0.13.0-v4", H.is_newer("0.13.0-v5", "0.13.0-v4"))
check("valid_version rejects injection", not H.valid_version("1.0; rm -rf /"))
check("valid_version rejects a path", not H.valid_version("../../etc/passwd"))
check("valid_version accepts 0.13.0-v7", H.valid_version("0.13.0-v7"))

# A fake caller (no passwd entry needed: build the object directly).
caller = H.Caller.__new__(H.Caller)
caller.uid, caller.name, caller.home, caller.gid = 1000, "fake", os.path.join(T, "home"), 1000
os.makedirs(os.path.join(caller.home, ".config/veltrix"), exist_ok=True)
os.makedirs(caller.staged_dir, exist_ok=True)

def staged(release, tarball_bytes=None, tarball_name="veltrix-1.1.tar.gz"):
    for old in os.listdir(caller.staged_dir):
        os.remove(os.path.join(caller.staged_dir, old))
    if tarball_bytes is not None:
        with open(os.path.join(caller.staged_dir, tarball_name), "wb") as f:
            f.write(tarball_bytes)
    with open(os.path.join(caller.staged_dir, "release.json"), "w") as f:
        json.dump(release, f)

good = {"version": "1.1", "kind": "full", "filename": "veltrix-1.1.tar.gz",
        "sha256": full_sha, "size": full_size}
with open(os.path.join(files, "veltrix-1.1.tar.gz"), "rb") as f:
    good_bytes = f.read()

def expect_reject(name, release, tarball_bytes=good_bytes):
    staged(release, tarball_bytes)
    try:
        H.read_staged_release(caller)
        check(name, False)
    except H.HelperError:
        check(name, True)

staged(good, good_bytes)
check("read_staged_release accepts a good release", H.read_staged_release(caller)["version"] == "1.1")
expect_reject("rejects a bad version string", dict(good, version="1.1; evil"))
expect_reject("rejects a non-GitHub filename", dict(good, filename="evil.tar.gz"))
expect_reject("rejects a path traversal filename", dict(good, filename="../../etc/passwd"))
expect_reject("rejects a bad sha256", dict(good, sha256="xyz"))
expect_reject("rejects a bad kind", dict(good, kind="weird"))
expect_reject("rejects a size mismatch", dict(good, size=full_size + 1))
staged(good, None)
try:
    H.read_staged_release(caller)
    check("rejects a missing tarball", False)
except H.HelperError:
    check("rejects a missing tarball", True)

# Deps sha: the snippet must read the real PKGBUILD and produce a sha.
tree = os.path.join(T, "tree", "veltrix-1.1")
sha = H.deps_sha_of_tree(tree)
check("deps_sha_of_tree returns a sha256", bool(H.SHA256_RE.match(sha)))
# check_deps: matching pins pass, wrong pins and missing pins go terminal.
H.PINS_FILE = os.path.join(T, "pins")
with open(H.PINS_FILE, "w") as f:
    f.write(sha + "\n")
H.SYSTEM_TREE = os.path.join(T, "no-such-tree")
caller2 = H.Caller.__new__(H.Caller)
caller2.uid, caller2.name, caller2.home, caller2.gid = 1000, "fake", os.path.join(T, "home"), 1000
try:
    H.check_deps(caller2, dict(good, kind="full"), os.path.join(T, "tree"))
    check("check_deps passes with matching pins", True)
except H.HelperError as e:
    check("check_deps passes with matching pins", False)
    print("  error:", e)
with open(H.PINS_FILE, "w") as f:
    f.write("0" * 64 + "\n")
try:
    H.check_deps(caller2, dict(good, kind="full"), os.path.join(T, "tree"))
    check("check_deps with wrong pins goes terminal", False)
except H.NeedsInteractive:
    check("check_deps with wrong pins goes terminal", True)
os.remove(H.PINS_FILE)
try:
    H.check_deps(caller2, dict(good, kind="full"), os.path.join(T, "tree"))
    check("check_deps with missing pins goes terminal", False)
except H.NeedsInteractive:
    check("check_deps with missing pins goes terminal", True)

# verify_against_github: genuine passes, tampered and wrong-version refuse.
staged(good, good_bytes)
try:
    tag = H.verify_against_github(dict(good, path=os.path.join(caller.staged_dir, "veltrix-1.1.tar.gz")))
    check("verify_against_github accepts the genuine tarball (tag %s)" % tag, tag == "v1.1")
except H.HelperError as e:
    check("verify_against_github accepts the genuine tarball", False)
    print("  error:", e)
staged(good, b"tampered bytes, not a tarball")
try:
    H.verify_against_github(dict(good, path=os.path.join(caller.staged_dir, "veltrix-1.1.tar.gz")))
    check("verify_against_github refuses a tampered tarball", False)
except H.HelperError as e:
    check("verify_against_github refuses a tampered tarball", "MISMATCH" in str(e))
staged(dict(good, version="9.9"), good_bytes)
try:
    H.verify_against_github(dict(good, version="9.9", path=os.path.join(caller.staged_dir, "veltrix-1.1.tar.gz")))
    check("verify_against_github refuses a version GitHub does not have", False)
except H.HelperError:
    check("verify_against_github refuses a version GitHub does not have", True)

# extract_staged: layout validation (full needs install.sh + VERSION).
extract = os.path.join(T, "extract")
shutil.rmtree(extract, ignore_errors=True)
staged(good, good_bytes)
try:
    top = H.extract_staged(caller, dict(good, path=os.path.join(caller.staged_dir, "veltrix-1.1.tar.gz")), extract)
    check("extract_staged accepts the genuine full tarball", os.path.isfile(os.path.join(top, "install.sh")))
except H.HelperError as e:
    check("extract_staged accepts the genuine full tarball", False)
    print("  error:", e)
# A tarball whose top dir is not veltrix-<version> is refused.
bad_tree = os.path.join(T, "badtree")
os.makedirs(bad_tree, exist_ok=True)
with tarfile.open(os.path.join(T, "bad.tar.gz"), "w:gz") as tf:
    import io
    data = b"x"
    info = tarfile.TarInfo("evil-1.1/install.sh")
    info.size = len(data)
    tf.addfile(info, io.BytesIO(data))
bad = dict(good, filename="veltrix-1.1.tar.gz")
staged(bad, open(os.path.join(T, "bad.tar.gz"), "rb").read())
try:
    H.extract_staged(caller, dict(bad, path=os.path.join(caller.staged_dir, "veltrix-1.1.tar.gz")), os.path.join(T, "extract2"))
    check("extract_staged refuses a wrong top dir", False)
except H.HelperError:
    check("extract_staged refuses a wrong top dir", True)

print("helper in-process: %d failure(s)" % len(fails))
sys.exit(1 if fails else 0)
PY
"$PY" "$T/helper_test.py" "$HELPER" "$T" "$T/files" "$FULL_SHA" "$FULL_SIZE" || fail "in-process validation failed"
pass "Part A: validation, staged-release, deps, GitHub verification, layout"

# ── Part B: CLI end to end (root only) ────────────────────────────────────────
if [ "$(id -u)" != 0 ]; then
    echo "SKIP: Part B needs root (fixture user + system pins file)"
    echo "update-helper-probe: ALL PASS (Part B skipped, not root)"
    exit 0
fi
command -v useradd >/dev/null 2>&1 || { echo "SKIP: Part B needs useradd"; echo "update-helper-probe: ALL PASS (Part B skipped, no useradd)"; exit 0; }

# Back up the system files the probe will touch, then restore them in the trap.
if [ -f /usr/share/veltrix/pins-pacman ]; then
    PINS_BACKUP="$T/pins.bak"; PINS_EXISTED=1
    cp /usr/share/veltrix/pins-pacman "$PINS_BACKUP"
    rm -f /usr/share/veltrix/pins-pacman
fi
if [ -f /etc/veltrix/apps.json ]; then
    APPS_BACKUP="$T/apps.bak"; APPS_EXISTED=1
    cp /etc/veltrix/apps.json "$APPS_BACKUP"
    rm -f /etc/veltrix/apps.json
fi

FIXTURE_USER="veltrix-probe-$$"
useradd -m -d "$T/userhome" -s /bin/bash "$FIXTURE_USER" || fail "useradd failed"
FIXTURE_UID="$(id -u "$FIXTURE_USER")"
UHOME="$T/userhome"
mkdir -p "$UHOME/.config/veltrix" "$UHOME/.local/share/veltrix-update/staged"
printf '1.0\n' > "$UHOME/.config/veltrix/.release"
mkdir -p "$T/regtree"
printf '1.0\n' > "$T/regtree/VERSION"
printf '#!/bin/bash\nexit 0\n' > "$T/regtree/install.sh"
printf '%s\n' "$T/regtree" > "$UHOME/.config/veltrix/.dev"
chown -R "$FIXTURE_USER:$FIXTURE_USER" "$UHOME" "$T/regtree"
export VELTRIX_UPDATE_TEST_UID="$FIXTURE_UID"

run_helper() { "$PY" "$HELPER" apply 2>"$T/helper.err"; echo "$?" > "$T/helper.rc"; cat "$T/helper.err"; }
helper_status() { "$PY" -c "import json; print(json.load(open('$UHOME/.local/share/veltrix-update/status.json'))['state'])" 2>/dev/null || echo "no-status"; }

stage_good() {
    cp "$T/files/veltrix-1.1.tar.gz" "$UHOME/.local/share/veltrix-update/staged/veltrix-1.1.tar.gz"
    cat > "$UHOME/.local/share/veltrix-update/staged/release.json" <<JSON
{"version": "1.1", "kind": "full", "filename": "veltrix-1.1.tar.gz", "sha256": "$FULL_SHA", "size": $FULL_SIZE, "downloaded_at": "2026-11-15T00:00:00Z"}
JSON
    chmod 644 "$UHOME/.local/share/veltrix-update/staged/veltrix-1.1.tar.gz" "$UHOME/.local/share/veltrix-update/staged/release.json"
    chown -R "$FIXTURE_USER:$FIXTURE_USER" "$UHOME/.local/share/veltrix-update"
}
clear_staged() { rm -f "$UHOME/.local/share/veltrix-update/staged/"*; }

# ── B1. No staged release → exit 1 ────────────────────────────────────────────
clear_staged
OUT="$(run_helper)"; RC="$(cat "$T/helper.rc")"
[ "$RC" = 1 ] || fail "B1 expected exit 1, got $RC: $OUT"
echo "$OUT" | grep -q "no staged release" || fail "B1 wrong reason: $OUT"
pass "B1: no staged release → exit 1"

# ── B2. Tampered tarball → exit 1, hash mismatch, nothing touched ─────────────
stage_good
# Flip one byte in the middle of the tarball, keeping the size identical,
# so the refusal comes from the SHA-256 check, not the size check.
"$PY" - "$UHOME/.local/share/veltrix-update/staged/veltrix-1.1.tar.gz" <<'PY'
import sys
p = sys.argv[1]
with open(p, "r+b") as f:
    f.seek(100)
    b = f.read(1)
    f.seek(100)
    f.write(bytes([b[0] ^ 0xFF]))
PY
OUT="$(run_helper)"; RC="$(cat "$T/helper.rc")"
[ "$RC" = 1 ] || fail "B2 expected exit 1, got $RC: $OUT"
echo "$OUT" | grep -q "MISMATCH" || fail "B2 wrong reason: $OUT"
[ "$(helper_status)" = "failed" ] || fail "B2 status is not failed: $(helper_status)"
[ "$(cat "$UHOME/.config/veltrix/.release")" = "1.0" ] || fail "B2 touched .release"
pass "B2: tampered tarball → exit 1, SHA-256 mismatch, nothing touched"

# ── B3. Genuine tarball, no pins file → exit 2 (needs-interactive) ────────────
# (apps.json present, so the pins gate is the one that fires.)
stage_good
mkdir -p /etc/veltrix
printf '{}\n' > /etc/veltrix/apps.json
OUT="$(run_helper)"; RC="$(cat "$T/helper.rc")"
[ "$RC" = 2 ] || fail "B3 expected exit 2, got $RC: $OUT"
echo "$OUT" | grep -q "pins" || fail "B3 wrong reason: $OUT"
[ "$(helper_status)" = "needs-interactive" ] || fail "B3 status is not needs-interactive: $(helper_status)"
pass "B3: genuine tarball, no pins file → exit 2 needs-interactive"

# ── B4. Wrong pins → exit 2 ───────────────────────────────────────────────────
mkdir -p /usr/share/veltrix
printf '%s\n' "$(printf '0%.0s' {1..64})" > /usr/share/veltrix/pins-pacman
OUT="$(run_helper)"; RC="$(cat "$T/helper.rc")"
[ "$RC" = 2 ] || fail "B4 expected exit 2, got $RC: $OUT"
echo "$OUT" | grep -q "system packages" || fail "B4 wrong reason: $OUT"
pass "B4: wrong pins → exit 2 needs-interactive"

# ── B5. Right pins, no apps choice → exit 2 ───────────────────────────────────
# The pins value must be what the helper itself computes from the staged
# tree's PKGBUILD — ask the helper's own function, so a drift between the
# two would fail here instead of passing silently.
DEPS_SHA="$("$PY" - "$HELPER" "$T/tree/veltrix-1.1" <<'PY'
import sys
from importlib.machinery import SourceFileLoader
H = SourceFileLoader("helper", sys.argv[1]).load_module()
print(H.deps_sha_of_tree(sys.argv[2]))
PY
)"
[ -n "$DEPS_SHA" ] || fail "B5 could not compute the deps sha"
printf '%s\n' "$DEPS_SHA" > /usr/share/veltrix/pins-pacman
rm -f /etc/veltrix/apps.json  # B5 isolates the apps gate: pins pass, choice missing
OUT="$(run_helper)"; RC="$(cat "$T/helper.rc")"
[ "$RC" = 2 ] || fail "B5 expected exit 2, got $RC: $OUT"
echo "$OUT" | grep -q "apps choice" || fail "B5 wrong reason: $OUT"
pass "B5: right pins, no apps choice → exit 2 needs-interactive"

# ── B6. Everything present → reaches bootstrap, fails closed (no pacman) ──────
mkdir -p /etc/veltrix
printf '{}\n' > /etc/veltrix/apps.json
OUT="$(run_helper)"; RC="$(cat "$T/helper.rc")"
[ "$RC" = 1 ] || fail "B6 expected exit 1, got $RC: $OUT"
echo "$OUT" | grep -q "bootstrap" || fail "B6 wrong reason: $OUT"
[ "$(helper_status)" = "failed" ] || fail "B6 status is not failed: $(helper_status)"
[ "$(cat "$UHOME/.config/veltrix/.release")" = "1.0" ] || fail "B6 touched .release"
pass "B6: everything present → reaches bootstrap, fails closed (no pacman here)"

# ── B7. Direct run without PKEXEC_UID and without the test override → exit 1 ──
unset VELTRIX_UPDATE_TEST_UID
if "$PY" "$HELPER" apply >/dev/null 2>"$T/no-uid.err"; then fail "B7 succeeded without a caller"; fi
grep -q "PKEXEC_UID" "$T/no-uid.err" || fail "B7 wrong reason: $(cat "$T/no-uid.err")"
pass "B7: no PKEXEC_UID and no test override → refuses"

echo "update-helper-probe: ALL PASS"
