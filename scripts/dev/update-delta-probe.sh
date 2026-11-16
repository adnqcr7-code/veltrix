#!/usr/bin/env bash
# update-delta-probe — harness test for scripts/build-delta.sh + the delta
# format bootstrap.sh expects (steps 4a–4e).
#
# Builds two fake release trees (changed file, added file, removed file,
# a space-named file, a file with TWO consecutive spaces — the MANIFEST
# parse trap), builds the delta, checks its layout, replays bootstrap's
# own apply steps (4a verify carried files, 4b rsync in, 4c remove
# DELETED, 4d verify whole tree, 4e remove orphans) on a copy of the old
# tree, and diffs the result against the new tree. Then two controls:
# a tampered delta must fail the 4a check, and identical versions must
# be refused. Exit 0 = all pass.
#
# Usage: ./scripts/dev/update-delta-probe.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DELTA="$REPO/scripts/build-delta.sh"
T="$(mktemp -d /tmp/veltrix-delta-probe.XXXXXX)"
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# ── Fixture trees ────────────────────────────────────────────────────────────
mkdir -p "$T/old/veltrix-1.0" "$T/new/veltrix-1.1"
printf 'same\n' > "$T/old/veltrix-1.0/keep.txt"
printf 'same\n' > "$T/new/veltrix-1.1/keep.txt"
printf 'old content\n' > "$T/old/veltrix-1.0/changed.txt"
printf 'new content\n' > "$T/new/veltrix-1.1/changed.txt"
printf 'gone\n' > "$T/old/veltrix-1.0/removed.txt"
printf 'added\n' > "$T/new/veltrix-1.1/added.txt"
printf 'space\n' > "$T/old/veltrix-1.0/space name.txt"
printf 'space\n' > "$T/new/veltrix-1.1/space name.txt"
printf 'two spaces old\n' > "$T/old/veltrix-1.0/two  spaces.txt"
printf 'two spaces new\n' > "$T/new/veltrix-1.1/two  spaces.txt"
printf '1.0\n' > "$T/old/veltrix-1.0/VERSION"
printf '1.1\n' > "$T/new/veltrix-1.1/VERSION"
# A large UNCHANGED file: the full tarball carries it, the delta must not.
# (Random bytes, so gzip cannot shrink it away.)
head -c 1048576 /dev/urandom > "$T/old/veltrix-1.0/big.bin"
cp "$T/old/veltrix-1.0/big.bin" "$T/new/veltrix-1.1/big.bin"
(cd "$T/old" && tar -czf "$T/veltrix-1.0.tar.gz" veltrix-1.0)
(cd "$T/new" && tar -czf "$T/veltrix-1.1.tar.gz" veltrix-1.1)

# ── 1. Build the delta ───────────────────────────────────────────────────────
mkdir -p "$T/out" "$T/out2"
OUT="$("$BUILD_DELTA" "$T/veltrix-1.0.tar.gz" "$T/veltrix-1.1.tar.gz" 1.0 1.1 "$T/out")" || fail "build-delta exited $?"
echo "$OUT" | grep -q "self-check PASS" || fail "build-delta self-check did not pass: $OUT"
DELTA="$T/out/veltrix-1.1-delta-from-1.0.tar.gz"
[ -f "$DELTA" ] || fail "delta missing"
[ -f "$DELTA.sha256" ] || fail "delta sidecar missing"
[ "$(sha256sum "$DELTA" | awk '{print $1}')" = "$(awk '{print $1}' "$DELTA.sha256")" ] || fail "delta sidecar hash does not match"
[ "$(stat -c%s "$DELTA")" -lt "$(stat -c%s "$T/veltrix-1.1.tar.gz")" ] || fail "delta is not smaller than the full tarball"
pass "build-delta: delta + sidecar, self-check PASS, smaller than full"

# ── 2. Layout: MANIFEST + DELETED at the root, files under veltrix-1.1/ ──────
mkdir -p "$T/layout"
tar -xzf "$DELTA" -C "$T/layout"
[ -f "$T/layout/MANIFEST" ] || fail "no MANIFEST at the delta root"
[ -f "$T/layout/DELETED" ] || fail "no DELETED at the delta root"
[ -f "$T/layout/veltrix-1.1/changed.txt" ] || fail "changed file not in the delta"
[ -f "$T/layout/veltrix-1.1/added.txt" ] || fail "added file not in the delta"
[ -f "$T/layout/veltrix-1.1/two  spaces.txt" ] || fail "two-spaces file not in the delta"
[ ! -f "$T/layout/veltrix-1.1/keep.txt" ] || fail "unchanged file is in the delta (it should not be)"
[ ! -f "$T/layout/veltrix-1.1/removed.txt" ] || fail "removed file is in the delta (it should not be)"
grep -q "^removed.txt$" "$T/layout/DELETED" || fail "DELETED does not list removed.txt"
grep -q "two  spaces.txt$" "$T/layout/MANIFEST" || fail "MANIFEST does not list the two-spaces file"
grep -q "space name.txt$" "$T/layout/MANIFEST" || fail "MANIFEST does not list the space-named file"
# MANIFEST must be the FULL new tree (7 files), LC_ALL=C sorted.
[ "$(wc -l < "$T/layout/MANIFEST")" = 7 ] || fail "MANIFEST has $(wc -l < "$T/layout/MANIFEST") lines, expected 7"
pass "delta layout: MANIFEST + DELETED at root, only changed/added files carried"

# ── 3. Replay bootstrap's 4a–4e apply on a copy of the old tree ──────────────
# (bootstrap.sh steps 4a–4e, mirrored here so the probe tests the format
# the real updater consumes — not just build-delta's own self-check.)
APPLY="$T/apply"
mkdir -p "$APPLY"
tar -xzf "$T/veltrix-1.0.tar.gz" -C "$APPLY"
tar -xzf "$DELTA" -C "$APPLY"
TREE="$APPLY/veltrix-1.0"
NEW_DIR="$APPLY/veltrix-1.1"
# An orphan: a file in the tree that no release ships (a leftover from an
# older release). Step 4e must remove it.
printf 'orphan\n' > "$TREE/orphan.txt"
# 4a. Every file the delta DOES carry must match MANIFEST (fixed-position
# parse — a filename with two consecutive spaces breaks a field split).
_delta_ok=1
while IFS= read -r _line; do
    _hash="${_line:0:64}"
    _rel="${_line:66}"
    if [ -f "$NEW_DIR/$_rel" ]; then
        _actual="$(sha256sum -- "$NEW_DIR/$_rel" | awk '{print $1}')"
        [ "$_actual" = "$_hash" ] || { echo "4a mismatch: $_rel" >&2; _delta_ok=0; break; }
    fi
done < "$APPLY/MANIFEST"
[ "$_delta_ok" = 1 ] || fail "4a: a carried file does not match MANIFEST"
pass "4a: carried files match MANIFEST (incl. the two-spaces file)"
# 4b. Sync the changed files in (no --delete).
rsync -a --checksum --no-owner --no-group --no-times "$NEW_DIR/" "$TREE/" || fail "4b rsync failed"
[ "$(cat "$TREE/changed.txt")" = "new content" ] || fail "4b did not update changed.txt"
[ -f "$TREE/added.txt" ] || fail "4b did not add added.txt"
pass "4b: changed/added files synced in"
# 4c. Remove the files the new release dropped.
while IFS= read -r _rel; do
    [ -n "$_rel" ] || continue
    rm -f -- "$TREE/$_rel"
done < "$APPLY/DELETED"
[ ! -f "$TREE/removed.txt" ] || fail "4c did not remove removed.txt"
pass "4c: DELETED files removed"
# 4d. Verify the WHOLE tree against MANIFEST.
( cd "$TREE" && sha256sum -c --status -- "$APPLY/MANIFEST" ) || fail "4d: tree does not match MANIFEST after applying"
pass "4d: whole tree matches MANIFEST"
# 4e. Remove orphans: files in the tree that the new release no longer ships.
_tree_files() { ( cd "$1" && find . -type f -printf '%P\n' | LC_ALL=C sort ); }
_orphans="$(comm -23 <(_tree_files "$TREE") <(cut -d' ' -f3- "$APPLY/MANIFEST" | LC_ALL=C sort) || true)"
echo "$_orphans" | grep -q "^orphan.txt$" || fail "4e did not find the orphan: $_orphans"
while IFS= read -r _rel; do
    [ -n "$_rel" ] || continue
    rm -f -- "$TREE/$_rel"
done <<EOF
$_orphans
EOF
[ ! -f "$TREE/orphan.txt" ] || fail "4e did not remove the orphan"
pass "4e: orphan removed"
# The applied tree must now be byte-identical to the new tree.
diff -r "$TREE" "$T/new/veltrix-1.1" >/dev/null || fail "applied tree differs from the new tree: $(diff -r "$TREE" "$T/new/veltrix-1.1" | head -5)"
pass "applied tree is byte-identical to the new tree"

# ── 4. Control: a tampered delta must fail the 4a check ──────────────────────
mkdir -p "$T/tamper"
tar -xzf "$DELTA" -C "$T/tamper"
printf 'evil\n' > "$T/tamper/veltrix-1.1/changed.txt"
(cd "$T/tamper" && tar -czf "$T/tampered-delta.tar.gz" MANIFEST DELETED veltrix-1.1)
mkdir -p "$T/tamper-apply"
tar -xzf "$T/tampered-delta.tar.gz" -C "$T/tamper-apply"
_tamper_ok=1
while IFS= read -r _line; do
    _hash="${_line:0:64}"
    _rel="${_line:66}"
    if [ -f "$T/tamper-apply/veltrix-1.1/$_rel" ]; then
        _actual="$(sha256sum -- "$T/tamper-apply/veltrix-1.1/$_rel" | awk '{print $1}')"
        [ "$_actual" = "$_hash" ] || { _tamper_ok=0; break; }
    fi
done < "$T/tamper-apply/MANIFEST"
[ "$_tamper_ok" = 0 ] || fail "tampered delta passed the 4a check (control failed)"
pass "control: tampered delta fails the 4a MANIFEST check"

# ── 5. Control: identical versions are refused ───────────────────────────────
if "$BUILD_DELTA" "$T/veltrix-1.0.tar.gz" "$T/veltrix-1.1.tar.gz" 1.1 1.1 "$T/out2" >/dev/null 2>&1; then
    fail "build-delta accepted identical versions"
fi
pass "control: identical versions refused"

echo "update-delta-probe: ALL PASS"
