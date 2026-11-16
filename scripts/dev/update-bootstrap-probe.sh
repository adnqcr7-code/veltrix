#!/usr/bin/env bash
# update-bootstrap-probe — harness test for bootstrap.sh --local-file and
# --no-install (the background updater's helper path).
#
# Runs the REAL bootstrap.sh as user `nobody` (via runuser) against a
# scratch HOME, with a fixture bin dir whose pacman/curl/sudo shims exist
# (preflight needs them) but fail loudly if actually invoked — proving
# --local-file never downloads and --no-install never reaches install.sh
# (the fixture tree's install.sh is a stub that exits 99 if run).
# Tests: fresh install via --local-file, bad sha, missing file, no args,
# conflicting hashes, a delta into a registered tree, and a delta with no
# registered tree. Exit 0 = all pass. Needs root (runuser); skipped
# otherwise.
#
# Usage: ./scripts/dev/update-bootstrap-probe.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BOOTSTRAP="$REPO/bootstrap.sh"
T="$(mktemp -d /tmp/veltrix-bootstrap-probe.XXXXXX)"
chmod 755 "$T"  # mktemp makes 0700; nobody must be able to traverse it
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

if [ "$(id -u)" != 0 ]; then
    echo "SKIP: needs root (runuser as nobody)"
    echo "update-bootstrap-probe: ALL PASS (skipped, not root)"
    exit 0
fi
command -v runuser >/dev/null 2>&1 || { echo "SKIP: needs runuser"; echo "update-bootstrap-probe: ALL PASS (skipped, no runuser)"; exit 0; }

# ── Fixture HOME + fixture bin (shims that must never be called) ────────────
mkdir -p "$T/home" "$T/bin" "$T/files"
for tool in pacman curl sudo; do
    cat > "$T/bin/$tool" <<SH
#!/bin/bash
echo "SHIM CALLED: $tool \$*" >&2
exit 99
SH
    chmod +x "$T/bin/$tool"
done
chown -R nobody:nogroup "$T/home" "$T/bin"

# run_bootstrap runs the real bootstrap.sh as nobody, with the fixture HOME
# and the shim bin dir first on PATH (real /usr/bin:/bin after it, for
# tar/sha256sum/rsync/python3/df and the rest). The script is COPIED into
# the fixture dir first: this VM's workspace is root-only (0700 dirs), so
# nobody cannot read the repo path directly — the copy is byte-identical,
# so the test is still of the real bootstrap.sh.
cp "$BOOTSTRAP" "$T/bootstrap.sh"
chmod 644 "$T/bootstrap.sh"
chown nobody:nogroup "$T/bootstrap.sh"
run_bootstrap() {
    local rc=0
    # Start from the fixture home: bootstrap's find(1) restores the
    # initial working directory when it finishes, and the probe's own
    # CWD (this VM's root-only workspace) is not traversable by nobody.
    (cd "$T/home" && runuser -u nobody -- env HOME="$T/home" PATH="$T/bin:/usr/bin:/bin" \
        bash "$T/bootstrap.sh" "$@") >"$T/boot.out" 2>"$T/boot.err" || rc=$?
    echo "$rc" > "$T/boot.rc"
}

# ── Fixture trees + tarballs ─────────────────────────────────────────────────
mkdir -p "$T/old/veltrix-1.0" "$T/new/veltrix-1.1"
printf '1.0\n' > "$T/old/veltrix-1.0/VERSION"
printf '1.1\n' > "$T/new/veltrix-1.1/VERSION"
printf 'old content\n' > "$T/old/veltrix-1.0/changed.txt"
printf 'new content\n' > "$T/new/veltrix-1.1/changed.txt"
printf 'gone\n' > "$T/old/veltrix-1.0/removed.txt"
printf 'added\n' > "$T/new/veltrix-1.1/added.txt"
printf '#!/bin/bash\necho "INSTALL.SH RAN" >&2\nexit 99\n' > "$T/old/veltrix-1.0/install.sh"
printf '#!/bin/bash\necho "INSTALL.SH RAN" >&2\nexit 99\n' > "$T/new/veltrix-1.1/install.sh"
chmod +x "$T/old/veltrix-1.0/install.sh" "$T/new/veltrix-1.1/install.sh"
(cd "$T/old" && tar -czf "$T/files/veltrix-1.0.tar.gz" veltrix-1.0)
(cd "$T/new" && tar -czf "$T/files/veltrix-1.1.tar.gz" veltrix-1.1)
FULL_SHA="$(sha256sum "$T/files/veltrix-1.1.tar.gz" | awk '{print $1}')"
chmod 644 "$T/files/"*.tar.gz
chown -R nobody:nogroup "$T/files" "$T/old" "$T/new"

# ── 1. Fresh install via --local-file + --no-install ─────────────────────────
run_bootstrap --local-file "$T/files/veltrix-1.1.tar.gz" "$FULL_SHA" --no-install
[ "$(cat "$T/boot.rc")" = 0 ] || fail "fresh --local-file exited $(cat "$T/boot.rc"): $(cat "$T/boot.err")"
grep -q "SHIM CALLED" "$T/boot.err" && fail "a shim was called (download or sudo happened): $(cat "$T/boot.err")"
grep -q "INSTALL.SH RAN" "$T/boot.err" && fail "install.sh ran despite --no-install"
TREE="$T/home/Downloads/veltrix-install/veltrix-1.1"
[ -f "$TREE/install.sh" ] && [ -f "$TREE/VERSION" ] || fail "tree not placed at $TREE"
[ "$(cat "$TREE/VERSION")" = "1.1" ] || fail "placed tree has the wrong VERSION"
[ ! -f "$T/home/.config/veltrix/.dev" ] || fail ".dev was written despite --no-install"
[ ! -f "$T/home/.config/veltrix/.release" ] || fail ".release was written despite --no-install"
pass "fresh install: --local-file places the tree, --no-install stops before install.sh"

# ── 2. Bad sha fails closed, nothing placed ───────────────────────────────────
rm -rf "$T/home/Downloads"
run_bootstrap --local-file "$T/files/veltrix-1.1.tar.gz" "$(printf '0%.0s' {1..64})" --no-install
[ "$(cat "$T/boot.rc")" != 0 ] || fail "bad-sha run succeeded"
grep -q "SHA-256 MISMATCH" "$T/boot.err" || fail "bad-sha run failed for the wrong reason: $(cat "$T/boot.err")"
[ ! -d "$T/home/Downloads/veltrix-install/veltrix-1.1" ] || fail "bad-sha run placed the tree"
pass "bad sha: SHA-256 mismatch fails closed, nothing placed"

# ── 3. Missing local file fails ───────────────────────────────────────────────
run_bootstrap --local-file "$T/files/nope.tar.gz" "$FULL_SHA" --no-install
[ "$(cat "$T/boot.rc")" != 0 ] || fail "missing-file run succeeded"
grep -q "local file not found" "$T/boot.err" || fail "missing-file run failed for the wrong reason: $(cat "$T/boot.err")"
pass "missing local file fails"

# ── 4. No args fails (usage) ──────────────────────────────────────────────────
run_bootstrap
[ "$(cat "$T/boot.rc")" != 0 ] || fail "no-args run succeeded"
grep -q "no tarball URL" "$T/boot.err" || fail "no-args run failed for the wrong reason: $(cat "$T/boot.err")"
pass "no args fails with usage"

# ── 5. Conflicting hashes fail ────────────────────────────────────────────────
run_bootstrap --local-file "$T/files/veltrix-1.1.tar.gz" "$FULL_SHA" dummy-url "$(printf '1%.0s' {1..64})" --no-install
[ "$(cat "$T/boot.rc")" != 0 ] || fail "conflicting-hash run succeeded"
grep -q "disagrees" "$T/boot.err" || fail "conflicting-hash run failed for the wrong reason: $(cat "$T/boot.err")"
pass "conflicting hashes fail"

# ── 6. Delta into a registered tree ───────────────────────────────────────────
mkdir -p "$T/out"
"$REPO/scripts/build-delta.sh" "$T/files/veltrix-1.0.tar.gz" "$T/files/veltrix-1.1.tar.gz" 1.0 1.1 "$T/out" >/dev/null \
    || fail "build-delta failed"
DELTA="$T/out/veltrix-1.1-delta-from-1.0.tar.gz"
DELTA_SHA="$(sha256sum "$DELTA" | awk '{print $1}')"
chmod 644 "$DELTA" "$DELTA.sha256"
# The registered tree: the old tree, in the work dir, with .dev pointing at it.
mkdir -p "$T/home/Downloads/veltrix-install" "$T/home/.config/veltrix"
cp -a "$T/old/veltrix-1.0" "$T/home/Downloads/veltrix-install/veltrix-1.0"
printf '%s\n' "$T/home/Downloads/veltrix-install/veltrix-1.0" > "$T/home/.config/veltrix/.dev"
chown -R nobody:nogroup "$T/home" "$T/out"
run_bootstrap --delta "$DELTA" "$DELTA_SHA" --local-file "$DELTA" "$DELTA_SHA" \
    --full-name veltrix-1.1.tar.gz --no-install
[ "$(cat "$T/boot.rc")" = 0 ] || fail "delta run exited $(cat "$T/boot.rc"): $(cat "$T/boot.err")"
grep -q "SHIM CALLED" "$T/boot.err" && fail "a shim was called during the delta: $(cat "$T/boot.err")"
grep -q "INSTALL.SH RAN" "$T/boot.err" && fail "install.sh ran during the delta despite --no-install"
REG="$T/home/Downloads/veltrix-install/veltrix-1.0"
[ "$(cat "$REG/changed.txt")" = "new content" ] || fail "delta did not update changed.txt"
[ -f "$REG/added.txt" ] || fail "delta did not add added.txt"
[ ! -f "$REG/removed.txt" ] || fail "delta did not remove removed.txt"
[ "$(cat "$REG/VERSION")" = "1.1" ] || fail "delta did not update VERSION"
pass "delta: applied into the registered tree, --no-install stops before install.sh"

# ── 7. Delta with no registered tree fails ────────────────────────────────────
rm -rf "$T/home/.config/veltrix/.dev" "$T/home/Downloads"
run_bootstrap --delta "$DELTA" "$DELTA_SHA" --local-file "$DELTA" "$DELTA_SHA" \
    --full-name veltrix-1.1.tar.gz --no-install
[ "$(cat "$T/boot.rc")" != 0 ] || fail "delta-without-tree run succeeded"
grep -q "needs a registered extracted tree" "$T/boot.err" || fail "delta-without-tree run failed for the wrong reason: $(cat "$T/boot.err")"
pass "delta with no registered tree fails"

echo "update-bootstrap-probe: ALL PASS"
