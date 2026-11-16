#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-delta.sh — build an incremental update (delta) tarball between two
# VELTRIX release tarballs, so an update only downloads the files that
# actually changed instead of the full ~17 MB tarball.
#
# WHY (2026-11-14, Adnan: "I feel I am reinstalling files that I have").
# A full update re-downloads the whole tarball and re-extracts it, so every
# file gets a new mtime — which makes cargo rebuild every Rust crate from
# scratch even when nothing in it changed. A delta contains only the files
# whose CONTENT changed (by sha256) plus a MANIFEST of the full new tree, so
# the updater can apply it in place, keep every unchanged file's mtime, and
# let cargo (and npm, and the C builds) skip what is already built.
#
# Usage:
#   scripts/build-delta.sh <old-tarball> <new-tarball> <old-version> <new-version> [out-dir]
#     old-version / new-version are the version strings WITHOUT the
#     "veltrix-" prefix and WITHOUT ".tar.gz" (e.g. 1.2 and 1.3).
#     out-dir defaults to the directory of the new tarball.
#
# Output (in out-dir):
#   veltrix-<new>-delta-from-<old>.tar.gz       changed + added files only,
#       under the same top dir as the new tarball (veltrix-<new>/...),
#       plus MANIFEST and DELETED at the tarball root.
#   veltrix-<new>-delta-from-<old>.tar.gz.sha256   the sidecar, in
#       sha256sum output format. The updater refuses a delta without a
#       verified hash, exactly like a full tarball.
#
# MANIFEST format: one "<sha256>  <relpath>" line per file in the NEW
# tarball (relpath relative to the version dir, e.g. "install.sh",
# "ui/shell/src/main.ts"). The updater verifies the whole tree against it
# after applying the delta, so a bad delta is caught before install.sh runs.
# DELETED format: one relpath per line, for files present in the OLD
# tarball but not in the NEW one. The updater removes them from the tree.
#
# Content-only: the MANIFEST hashes file CONTENT, not modes. A file whose
# mode changed but whose content did not is not in the delta; install.sh §4
# normalises modes on install anyway, so nothing is lost.
#
# Self-check: after building the delta, this script applies it to a fresh
# copy of the OLD tree and verifies the result is byte-identical (file list
# + hashes) to the NEW tree. If the self-check fails, the delta is deleted
# and the script exits non-zero — a bad delta must never be published.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "Usage: $0 <old-tarball> <new-tarball> <old-version> <new-version> [out-dir]" >&2
    exit 2
fi

OLD_TARBALL="$(realpath -- "$1")"
NEW_TARBALL="$(realpath -- "$2")"
OLD_VER="$3"
NEW_VER="$4"
OUT_DIR="${5:-$(dirname "$NEW_TARBALL")}"
OUT_DIR="$(realpath -- "$OUT_DIR")"

for f in "$OLD_TARBALL" "$NEW_TARBALL"; do
    [ -f "$f" ] || { echo "build-delta: not a file: $f" >&2; exit 1; }
done
[ "$OLD_VER" != "$NEW_VER" ] || { echo "build-delta: versions are identical ($OLD_VER) — no delta to build" >&2; exit 1; }

DELTA_NAME="veltrix-${NEW_VER}-delta-from-${OLD_VER}.tar.gz"
DELTA_PATH="$OUT_DIR/$DELTA_NAME"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

OLD_DIR="$WORK/old"
NEW_DIR="$WORK/new"
mkdir -p "$OLD_DIR" "$NEW_DIR"
tar -xzf "$OLD_TARBALL" -C "$OLD_DIR"
tar -xzf "$NEW_TARBALL" -C "$NEW_DIR"

# The tarballs each contain one top dir (veltrix-<ver>/). Find it.
OLD_TOP="$(find "$OLD_DIR" -mindepth 1 -maxdepth 1 -type d -name 'veltrix-*' | head -1)"
NEW_TOP="$(find "$NEW_DIR" -mindepth 1 -maxdepth 1 -type d -name 'veltrix-*' | head -1)"
[ -n "$OLD_TOP" ] && [ -n "$NEW_TOP" ] || { echo "build-delta: tarball has no veltrix-* top dir" >&2; exit 1; }

# Manifests: "<sha256>  <relpath>", sorted by relpath (LC_ALL=C so the
# order is identical on the publisher's machine and on the Dell — the
# updater compares them with `comm`, which needs one consistent order).
# xargs -d '\n' so a filename with SPACES is one argument, not several
# (the tree has test fixtures named "input with spaces.txt").
( cd "$OLD_TOP" && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -r -d '\n' sha256sum > "$WORK/old.manifest" )
( cd "$NEW_TOP" && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -r -d '\n' sha256sum > "$WORK/new.manifest" )

# Changed + added: files in the new manifest whose hash differs from the
# old manifest (or that are absent from it). Unchanged files are NOT in
# the delta — that is the whole point.
STAGE="$WORK/stage"
mkdir -p "$STAGE/veltrix-$NEW_VER"
CHANGED=0
while IFS= read -r line; do
    # Fixed-position parse: a sha256 hex digest is exactly 64 chars,
    # then the two-space separator. (Splitting on the spaces breaks for
    # a filename that itself contains two consecutive spaces.)
    hash="${line:0:64}"
    rel="${line:66}"
    old_hash="$(grep -F "  $rel" "$WORK/old.manifest" | head -1 | cut -d' ' -f1 || true)"
    if [ "$old_hash" != "$hash" ]; then
        mkdir -p "$STAGE/veltrix-$NEW_VER/$(dirname -- "$rel")"
        cp -a -- "$NEW_TOP/$rel" "$STAGE/veltrix-$NEW_VER/$rel"
        CHANGED=$((CHANGED + 1))
    fi
done < "$WORK/new.manifest"

# Deleted: files in the old manifest but not in the new one.
comm -23 \
    <(cut -d' ' -f3- "$WORK/old.manifest" | sed 's/^  //') \
    <(cut -d' ' -f3- "$WORK/new.manifest" | sed 's/^  //') \
    > "$WORK/deleted.txt" || true
DELETED="$(wc -l < "$WORK/deleted.txt")"

# MANIFEST (full new-tree list) and DELETED go at the tarball root, NOT
# inside the version dir — otherwise rsync would copy them into the tree.
cp "$WORK/new.manifest" "$STAGE/MANIFEST"
cp "$WORK/deleted.txt" "$STAGE/DELETED"

( cd "$STAGE" && tar -czf "$DELTA_PATH" MANIFEST DELETED "veltrix-$NEW_VER" )
( cd "$OUT_DIR" && sha256sum "$DELTA_NAME" > "$DELTA_NAME.sha256" )

OLD_SIZE="$(stat -c %s -- "$OLD_TARBALL")"
NEW_SIZE="$(stat -c %s -- "$NEW_TARBALL")"
DELTA_SIZE="$(stat -c %s -- "$DELTA_PATH")"
echo "build-delta: $DELTA_NAME"
echo "  full tarball: $NEW_SIZE bytes | delta: $DELTA_SIZE bytes | changed files: $CHANGED | deleted files: $DELETED"
if [ "$DELTA_SIZE" -ge "$NEW_SIZE" ]; then
    echo "  NOTE: delta is not smaller than the full tarball — publish the full tarball only." >&2
fi

# ── Self-check: apply the delta to a copy of the old tree and verify the
# result is byte-identical to the new tree (file list + hashes). ──────────
CHECK="$WORK/check"
mkdir -p "$CHECK"
tar -xzf "$OLD_TARBALL" -C "$CHECK"
CHECK_TOP="$(find "$CHECK" -mindepth 1 -maxdepth 1 -type d -name 'veltrix-*' | head -1)"
tar -xzf "$DELTA_PATH" -C "$CHECK"
# Apply: changed/added files over the tree (no --delete here — DELETED
# handles removals, and --delete would wipe everything not in the delta).
# --no-owner/--no-group/--no-times: the tarball's stored owner must not
# be imposed on the check tree (a non-root publisher cannot chown
# anyway), and times are irrelevant to a content comparison.
rsync -a --checksum --no-owner --no-group --no-times "$CHECK/veltrix-$NEW_VER/" "$CHECK_TOP/"
# Apply DELETED.
while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    rm -f -- "$CHECK_TOP/$rel"
done < "$CHECK/DELETED"
# Verify: file list + hashes must match the new manifest exactly.
( cd "$CHECK_TOP" && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -r -d '\n' sha256sum > "$WORK/check.manifest" )
if ! cmp -s "$WORK/new.manifest" "$WORK/check.manifest"; then
    echo "build-delta: SELF-CHECK FAILED — delta applied to the old tree does not reproduce the new tree" >&2
    diff "$WORK/new.manifest" "$WORK/check.manifest" | head -20 >&2 || true
    rm -f -- "$DELTA_PATH" "$DELTA_PATH.sha256"
    exit 1
fi
echo "build-delta: self-check PASS — delta reproduces the new tree exactly"
