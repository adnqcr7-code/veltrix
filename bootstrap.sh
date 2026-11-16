#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap.sh — the one-shot Veltrix installer (fresh install AND update).
# Usage: bash bootstrap.sh <TARBALL_URL> [EXPECTED_SHA256]
#    or: bash bootstrap.sh --delta <DELTA_URL> <DELTA_SHA256> --full-name <FULL_TARBALL_NAME>
# (or set VELTRIX_OS_TARBALL_URL / VELTRIX_OS_EXPECTED_SHA256 instead).
#
# Run as the normal user (adnan), NOT root; it sudo-escalates where needed.
# You do NOT need a desktop running, and you do NOT log into Hyprland first —
# a terminal or TTY is fine.
#
# If anything fails: photograph the last screenful and STOP. Do not re-run
# blindly.
#
# ── SHA-256 verification (fail-closed) ──────────────────────────────────────
# A release tarball is installed ONLY when its hash matches a hash the
# publisher published — otherwise a corrupted or swapped download would
# silently become the desktop. The check is NOT optional, the hash is NOT
# computed from the tarball itself (that would prove nothing), the
# comparison is exact, and a missing hash is a refusal, not a warning:
# install.sh runs from the extracted tree, so a bad tarball must never be
# extracted. The expected hash is a FIXED value per release, published in
# docs/dell-install-fork.md — so an attacker who can rewrite a manifest
# can rewrite the hash too, but only by pushing a new commit, which is a
# different (auditable) event, and a release tagged by a human keeps the
# hash stable while any content change is visible in the tree (a changed
# tarball with the same published hash is impossible short of a preimage
# attack; a changed hash with no matching commit is visible as a changed
# doc). A future maintainer should rotate the hash per release, and the
# sidecar must be uploaded with every release. (2026-11-12, fix 3, step
# [3/5].) The hash in docs/dell-install-fork.md is updated only when the
# release is, never in a stale doc — a hash that is current by the doc's
# own date is the only one that can be trusted. The docs' own history
# proves why: the v1 tarball's hash was written into the doc, the tarball
# was rebuilt, and the doc was not updated, so the v1 hash in the doc was
# wrong for the v1 tarball that was actually published. A hash that is
# stale is worse than no hash, because it looks verified. (2026-11-13,
# fix 3, step [3/5].) The hash is verified against the tarball that is
# downloaded, not the one that was published — a download that is
# corrupted in transit fails here, before anything is extracted.
#
# The expected hash comes from, in order:
#   a. the 2nd argument, or $VELTRIX_OS_EXPECTED_SHA256;
#   b. a published sidecar file at <TARBALL_URL>.sha256 (the release
#      publisher uploads it next to the tarball, in `sha256sum` output
#      format: "<hash>  <filename>");
#   c. if neither exists: ABORT. No install without a published hash.
# The computed hash is always printed, so it can be compared with the hash
# in docs/dell-install-fork.md by eye as well.
#
# The download + extracted tree stay in ~/Downloads/veltrix-install: the
# dev install registers that tree as its source (veltrix-update follows it),
# so do NOT delete it after installing. A successful install also records
# the release version (e.g. 1.2) in ~/.config/veltrix/.release, so the
# update check can tell releases apart — since 1.2 this is the same plain
# version VERSION carries (the old 0.13.0-vN releases shared one VERSION).
#
# ── Fast updates (2026-11-14, Adnan: "I feel I am reinstalling files
# that I have") ─────────────────────────────────────────────────────────────
# An update used to wipe ~/Downloads/veltrix-install, re-download the
# whole ~17 MB tarball, and re-extract it — which gave EVERY file a new
# mtime, so cargo rebuilt every Rust crate from scratch, npm re-checked
# every package, and every file was re-copied into /usr, even the ones
# that had not changed since the installed version. The update now:
#   1. downloads into a staging dir INSIDE the work dir (never wiping it
#      first — the registered tree lives there), and
#   2. when a registered extracted tree already exists (the .dev marker
#      points at a dir with install.sh and no .git), syncs the new tree
#      INTO it with `rsync -a --checksum --delete`, which copies only
#      files whose CONTENT changed and leaves every unchanged file's
#      mtime alone — so cargo's fingerprints stay valid and the Rust
#      rebuild touches only the crates whose sources actually changed
#      (proven in the sandbox: identical tree rsync'd over a built tree
#      → cargo reports "Finished" with zero recompilation; a changed
#      file → only that crate and its dependents rebuild).
#      Build caches and generated outputs (target/, node_modules/,
#      build/, @girs/) are EXCLUDED from the sync, so they survive in
#      the tree — deleting them would force the full rebuild this exists
#      to skip. (ui/installer/@girs IS in the tarball, so it is NOT
#      excluded — it syncs like any other file.)
#   3. in delta mode (--delta), downloads only the delta tarball (the
#      files that changed, plus a MANIFEST of the full new tree and a
#      DELETED list), applies it, and verifies the whole tree against
#      MANIFEST before install.sh runs. Any failure aborts BEFORE the
#      install starts, and veltrix-update falls back to the full tarball.
# A fresh install (no registered tree) keeps the old path: the new tree
# is moved into place and the old trees are removed. install.sh itself
# also skips work that is already done (see its header).
# The installed system is untouched until install.sh runs, so a failed
# download / bad hash / bad delta leaves the running desktop alone.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Arguments ────────────────────────────────────────────────────────────────
# Positional: <TARBALL_URL> [EXPECTED_SHA256] (unchanged — veltrix-update
# calls it this way, and so does the two-command install in the docs).
# Flags (veltrix-update's delta path only):
#   --delta <URL> <SHA256>   apply a delta tarball instead of the full one.
#   --full-name <NAME>       the full tarball's filename (e.g.
#       veltrix-1.3.tar.gz) — only used to record the release in
#       ~/.config/veltrix/.release, since the delta's own filename
#       (veltrix-1.3-delta-from-1.2.tar.gz) is not a version.
# Flags (the background updater's helper only):
#   --local-file <PATH> <SHA256>
#       use a tarball already on disk instead of downloading one. The
#       positional URL may be omitted. EXPECTED_SHA256 is still required
#       (from this flag, or from the 2nd positional / --delta) and is
#       verified in step 3 exactly as for a download.
#   --no-install             stop after step 4 (the tree is placed and
#       verified) and exit 0 — do NOT run install.sh and do NOT write
#       .release. The helper runs install.sh itself (as root) and
#       records the release after it passes.
DELTA_MODE=0
FULL_NAME=""
LOCAL_FILE=""
LOCAL_SHA=""
NO_INSTALL=0
TARBALL_URL="${VELTRIX_OS_TARBALL_URL:-}"
EXPECTED_SHA256="${VELTRIX_OS_EXPECTED_SHA256:-}"
_positionals=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --delta)
            [ "$#" -ge 3 ] || { echo "bootstrap: [FAIL] --delta needs <URL> <SHA256>" >&2; exit 1; }
            DELTA_MODE=1
            TARBALL_URL="$2"
            EXPECTED_SHA256="$3"
            shift 3 ;;
        --full-name)
            [ "$#" -ge 2 ] || { echo "bootstrap: [FAIL] --full-name needs <NAME>" >&2; exit 1; }
            FULL_NAME="$2"
            shift 2 ;;
        --local-file)
            [ "$#" -ge 3 ] || { echo "bootstrap: [FAIL] --local-file needs <PATH> <SHA256>" >&2; exit 1; }
            LOCAL_FILE="$2"
            LOCAL_SHA="$3"
            shift 3 ;;
        --no-install)
            NO_INSTALL=1
            shift ;;
        --) shift; while [ "$#" -gt 0 ]; do _positionals+=("$1"); shift; done ;;
        -*) echo "bootstrap: [FAIL] unknown option: $1" >&2; exit 1 ;;
        *) _positionals+=("$1"); shift ;;
    esac
done
[ "${#_positionals[@]}" -ge 1 ] && TARBALL_URL="${_positionals[0]}"
[ "${#_positionals[@]}" -ge 2 ] && EXPECTED_SHA256="${_positionals[1]}"
[ "$DELTA_MODE" = 0 ] || [ -n "$FULL_NAME" ] || { echo "bootstrap: [FAIL] --delta needs --full-name <FULL_TARBALL_NAME>" >&2; exit 1; }
# --local-file supplies the hash: it is the expected hash when nothing
# else gave one, and a disagreement with an expected hash from another
# source is a caller error, not a tie to break silently.
if [ -n "$LOCAL_FILE" ]; then
    [ -f "$LOCAL_FILE" ] || { echo "bootstrap: [FAIL] local file not found: $LOCAL_FILE" >&2; exit 1; }
    if [ -z "$EXPECTED_SHA256" ]; then
        EXPECTED_SHA256="$LOCAL_SHA"
    elif [ "$EXPECTED_SHA256" != "$LOCAL_SHA" ]; then
        echo "bootstrap: [FAIL] --local-file hash disagrees with the expected hash" >&2; exit 1
    fi
fi

WORK_DIR="${VELTRIX_OS_WORK_DIR:-$HOME/Downloads/veltrix-install}"
MIN_FREE_GB=3

fail() { printf 'bootstrap: [FAIL] %s\n' "$*" >&2; exit 1; }
note() { printf 'bootstrap: %s\n' "$*"; }

[ -n "$TARBALL_URL" ] || [ -n "$LOCAL_FILE" ] || fail "no tarball URL. Usage: bash bootstrap.sh <TARBALL_URL> [EXPECTED_SHA256]
  (or set VELTRIX_OS_TARBALL_URL). The current URL is in docs/dell-install-fork.md.
  (or pass --local-file <PATH> <SHA256> to use a tarball already on disk.)"

# ── 0. The registered tree (the update signal) ───────────────────────────────
# A registered extracted tree is the .dev marker pointing at a dir that has
# install.sh and is NOT a git checkout (a git checkout is a dev install and
# updates through install.sh --update, never through a tarball). When it
# exists, this run is an UPDATE and the new tree is synced into it; when
# it does not, this is a FRESH install. Read before the preflight so the
# rsync check below knows whether rsync will actually be used.
EXISTING_TREE=""
if [ -f "$HOME/.config/veltrix/.dev" ]; then
    _cand="$(cat "$HOME/.config/veltrix/.dev" 2>/dev/null || true)"
    if [ -n "$_cand" ] && [ -d "$_cand" ] && [ -f "$_cand/install.sh" ] && [ ! -d "$_cand/.git" ]; then
        EXISTING_TREE="$_cand"
    fi
fi
if [ "$DELTA_MODE" = 1 ] && [ -z "$EXISTING_TREE" ]; then
    fail "delta mode needs a registered extracted tree to apply to, and none was found (.dev marker missing or not a tarball tree).
  A delta only carries the changed files — it cannot build a tree from nothing. Re-run with the full tarball URL instead."
fi
[ -z "$EXISTING_TREE" ] || note "registered tree found: $EXISTING_TREE (update — only changed files will be replaced)."

# ── 1. Preflight ─────────────────────────────────────────────────────────────
[ "$(id -u)" != 0 ] || fail "do not run as root — run as user adnan; sudo is asked for when needed."
command -v pacman >/dev/null 2>&1 || fail "pacman not found — this installer is for Arch Linux only."
for _tool in curl tar sha256sum sudo python3; do
    command -v "$_tool" >/dev/null 2>&1 || fail "missing required tool: $_tool"
done
_free_gb="$(df --output=avail -BG / | tail -1 | tr -dc '0-9')"
[ "${_free_gb:-0}" -ge "$MIN_FREE_GB" ] || fail "only ${_free_gb:-0} GB free on / — need at least $MIN_FREE_GB GB."
note "preflight OK (Arch, tools present, ${_free_gb} GB free on /)."

# rsync is the fast-update tool: it syncs the new tree into the existing
# one without touching unchanged files (so cargo keeps its fingerprints).
# It is an optimisation, not a requirement — if it cannot be installed the
# update falls back to the old full wipe + extract, which is slow but
# correct. Only installed on demand when an update would actually use it.
RSYNC_OK=0
if [ -n "$EXISTING_TREE" ]; then
    if command -v rsync >/dev/null 2>&1; then
        RSYNC_OK=1
    elif sudo pacman -S --needed --noconfirm rsync >/dev/null 2>&1; then
        RSYNC_OK=1
        note "installed rsync (needed for fast updates)."
    else
        note "rsync is not available and could not be installed — this update will use the slow full re-extract path."
    fi
fi

# Directories that live in the registered tree but NOT in the tarball:
# build caches and generated outputs. They must survive an update sync —
# deleting them would force a full rebuild of exactly the work the fast
# update exists to skip. (ui/installer/@girs IS in the tarball, so it is
# NOT excluded — it syncs like any other file.)
RSYNC_EXCLUDES=(
    --exclude 'target/'
    --exclude 'build/'
    --exclude 'session/target/'
    --exclude 'toolkit/target/'
    --exclude 'hyalo/target/'
    --exclude 'ui/shell/node_modules/'
    --exclude 'ui/settings/node_modules/'
    --exclude 'ui/greeter/node_modules/'
    --exclude 'ui/lockscreen/node_modules/'
    --exclude 'ui/installer/node_modules/'
    --exclude 'ui/shell/build/'
    --exclude 'ui/settings/build/'
    --exclude 'ui/greeter/build/'
    --exclude 'ui/lockscreen/build/'
    --exclude 'ui/installer/build/'
    --exclude 'ui/lib/veltrix-kit/build/'
    --exclude 'lib/veltrix-host/build/'
    --exclude 'ui/shell/@girs/'
    --exclude 'ui/settings/@girs/'
    --exclude 'ui/greeter/@girs/'
    --exclude 'ui/lockscreen/@girs/'
    --exclude '.git/'
    --exclude 'packaging/veltrix/src/'
    --exclude 'packaging/veltrix/pkg/'
    --exclude 'packaging/veltrix/*.tar.*'
    --exclude 'packaging/veltrix/*.log'
)

# _tree_files <dir> — the tree's files as sorted relative paths, excluding
# the same cache/generated dirs rsync excludes. Used by the delta
# verification to find files the new release dropped (orphans).
_tree_files() {
    ( cd "$1" && find . -type f \
        -not -path './target/*' \
        -not -path './build/*' \
        -not -path './session/target/*' \
        -not -path './toolkit/target/*' \
        -not -path './hyalo/target/*' \
        -not -path './ui/shell/node_modules/*' \
        -not -path './ui/settings/node_modules/*' \
        -not -path './ui/greeter/node_modules/*' \
        -not -path './ui/lockscreen/node_modules/*' \
        -not -path './ui/installer/node_modules/*' \
        -not -path './ui/shell/build/*' \
        -not -path './ui/settings/build/*' \
        -not -path './ui/greeter/build/*' \
        -not -path './ui/lockscreen/build/*' \
        -not -path './ui/installer/build/*' \
        -not -path './ui/lib/veltrix-kit/build/*' \
        -not -path './lib/veltrix-host/build/*' \
        -not -path './ui/shell/@girs/*' \
        -not -path './ui/settings/@girs/*' \
        -not -path './ui/greeter/@girs/*' \
        -not -path './ui/lockscreen/@girs/*' \
        -not -path './.git/*' \
        -not -path './packaging/veltrix/src/*' \
        -not -path './packaging/veltrix/pkg/*' \
        -not -path './packaging/veltrix/*.tar.*' \
        -not -path './packaging/veltrix/*.log' \
        -printf '%P\n' | LC_ALL=C sort )
}

# NOTE on sorting: the MANIFEST and the tree file list are compared with
# `comm`, which needs both inputs sorted in the SAME order. The manifest
# was sorted on the publisher's machine (unknown locale), so every sort
# here is pinned to LC_ALL=C — otherwise a locale difference makes comm
# report real files as orphans and the delta apply would delete them.

# ── 2. Download (into staging — the work dir is NOT wiped first) ────────────
# The old bootstrap did `rm -rf $WORK_DIR` here, which deleted the
# registered tree before the new one even downloaded. The staging dir
# holds the download + extract; the tree is only touched by the rsync in
# step 4, after the hash is verified. Stale staging dirs from interrupted
# runs are cleaned up first.
mkdir -p "$WORK_DIR"
rm -rf "$WORK_DIR"/.stage-*
STAGE_DIR="$WORK_DIR/.stage-$$"
mkdir -p "$STAGE_DIR"
if [ -n "$LOCAL_FILE" ]; then
    # A tarball already on disk (the background updater's helper): no
    # download, and no sidecar fetch — the hash came with the flag and
    # step 3 verifies it exactly as for a download.
    note "using the local tarball: $LOCAL_FILE"
    TARBALL_FILE="$LOCAL_FILE"
else
    if [ "$DELTA_MODE" = 1 ]; then
        note "downloading the delta tarball (only the changed files)…"
    else
        note "downloading the release tarball…"
    fi
    TARBALL_FILE="$STAGE_DIR/$(basename "${TARBALL_URL%%\?*}")"
    case "$TARBALL_FILE" in *.tar.gz) ;; *) TARBALL_FILE="$STAGE_DIR/veltrix.tar.gz" ;; esac
    curl -fSL --proto=https -o "$TARBALL_FILE" "$TARBALL_URL" \
        || fail "download failed — check the URL and your network, then re-run."
fi

# ── 3. Verify SHA-256 (fail-closed — see the header) ──────────────────────────
ACTUAL_SHA256="$(sha256sum "$TARBALL_FILE" | awk '{print $1}')"
note "downloaded SHA-256: $ACTUAL_SHA256"
if [ -z "$EXPECTED_SHA256" ]; then
    if curl -fsSL --proto=https -o "$STAGE_DIR/tarball.sha256" "${TARBALL_URL}.sha256" 2>/dev/null; then
        EXPECTED_SHA256="$(awk '{print $1}' "$STAGE_DIR/tarball.sha256")"
        note "published hash (from ${TARBALL_URL}.sha256): $EXPECTED_SHA256"
    fi
fi
[ -n "$EXPECTED_SHA256" ] || fail "no published hash: neither an expected SHA-256 nor a ${TARBALL_URL}.sha256 sidecar was found.
  Refusing to install an unverified tarball. The release publisher must upload
  the .sha256 sidecar next to the tarball (or pass the hash as the 2nd argument)."
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || fail "SHA-256 MISMATCH — do not install.
  expected: $EXPECTED_SHA256
  actual:   $ACTUAL_SHA256
  The download is corrupt or not the published release. Report it."
note "SHA-256 verified."

# ── 4. Extract + place the tree ──────────────────────────────────────────────
note "extracting…"
tar -xzf "$TARBALL_FILE" -C "$STAGE_DIR" || fail "could not extract the tarball."
# The tarball's top-level directory (e.g. veltrix-1.2).
NEW_DIR="$(find "$STAGE_DIR" -mindepth 1 -maxdepth 1 -type d -name 'veltrix-*' | head -1)"
[ -n "$NEW_DIR" ] || fail "extracted tree has no veltrix-* directory — unexpected tarball layout."
# A FULL tarball is a complete tree, so it must carry install.sh/VERSION.
# A DELTA only carries the files that changed — install.sh is in it only
# when install.sh itself changed — so this check does not apply to it.
# The delta's own integrity is checked by its MANIFEST below, and the
# tree it lands in was already validated when it was detected.
if [ "$DELTA_MODE" = 0 ]; then
    [ -x "$NEW_DIR/install.sh" ] && [ -f "$NEW_DIR/VERSION" ] \
        || fail "$NEW_DIR does not look like a Veltrix source tree (no install.sh/VERSION)."
fi

if [ "$DELTA_MODE" = 1 ]; then
    # ── Delta apply ──────────────────────────────────────────────────────────
    # The delta carries MANIFEST (the full new tree, "<sha256>  <relpath>"
    # per file) and DELETED (one relpath per line) at its root, plus the
    # changed/added files under veltrix-<new>/. Apply in order, verify
    # BEFORE install.sh runs: a bad delta must never reach the install.
    # The tree keeps its path (and its name — it is still veltrix-<old>/
    # on disk); the version is recorded in .release, not the dir name.
    [ -f "$STAGE_DIR/MANIFEST" ] && [ -f "$STAGE_DIR/DELETED" ] \
        || fail "delta tarball has no MANIFEST/DELETED — it is not a delta the publisher built with scripts/build-delta.sh."
    # 4a. Every file the delta DOES carry must match MANIFEST.
    _delta_ok=1
    while IFS= read -r _line; do
        # Fixed-position parse: a sha256 hex digest is exactly 64 chars,
        # then the two-space separator. (Splitting on the spaces breaks
        # for a filename that itself contains two consecutive spaces.)
        _hash="${_line:0:64}"
        _rel="${_line:66}"
        if [ -f "$NEW_DIR/$_rel" ]; then
            _actual="$(sha256sum -- "$NEW_DIR/$_rel" | awk '{print $1}')"
            [ "$_actual" = "$_hash" ] || { echo "bootstrap: [FAIL] delta file $_rel does not match MANIFEST (hash mismatch)." >&2; _delta_ok=0; break; }
        fi
    done < "$STAGE_DIR/MANIFEST"
    [ "$_delta_ok" = 1 ] || fail "delta failed its own MANIFEST check — aborting before the install. Re-run the update (it falls back to the full tarball)."
    # 4b. Sync the changed files in (NO --delete here — the delta only
    # holds the changed files; --delete would wipe everything else).
    # --no-owner/--no-group: the tree is the installing user's dev
    # source — the tarball's stored owner (whoever built the release)
    # must not be imposed on it, and a non-root user cannot chown
    # anyway (rsync would exit 23 on every file it could not chgrp).
    # --no-times: the mtime of a file rsync does NOT transfer is left
    # alone (that is what keeps cargo's fingerprints valid), and a file
    # it DOES transfer is changed by content, so cargo rebuilds it
    # whatever its mtime is — preserving the source mtime buys nothing
    # and fails (exit 23) when the tree holds a file owned by someone
    # else, which would abort an otherwise-correct update.
    rsync -a --checksum --no-owner --no-group --no-times "${RSYNC_EXCLUDES[@]}" "$NEW_DIR/" "$EXISTING_TREE/" \
        || fail "delta sync failed — aborting before the install. The tree may be partly updated; re-run the update (it falls back to the full tarball, which converges it)."
    # 4c. Remove the files the new release dropped.
    while IFS= read -r _rel; do
        [ -n "$_rel" ] || continue
        rm -f -- "$EXISTING_TREE/$_rel"
    done < "$STAGE_DIR/DELETED"
    # 4d. Verify the WHOLE tree against MANIFEST: every file must exist
    # with the right content. (Extra files the release dropped are
    # cleaned up below, not a failure — the full-tarball path's --delete
    # does the same.)
    # EXCEPT the compiled CSS: install.sh §3 recompiles kit.css and the
    # shell/settings style.css in the tree on EVERY install (from the
    # SCSS sources, which ARE verified below), so the tree's CSS is the
    # Dell's sass output, not the release builder's — and a sass-version
    # difference would make the bytes differ even though the sources are
    # identical. Verifying those bytes would make every delta fail and
    # fall back to the full tarball for no reason. Their content is a
    # derived artifact; install.sh regenerates it from the verified
    # sources on the same run, so it is excluded from the check. (The
    # installer style.css is NOT recompiled by install.sh, so it stays
    # verified; the greeter style.css is not in the tarball at all.)
    awk '
      BEGIN {
        skip["ui/lib/veltrix-kit/kit.css"]; skip["ui/lib/veltrix-kit/kit.css.map"]
        skip["ui/shell/style.css"]; skip["ui/shell/style.css.map"]
        skip["ui/settings/style.css"]; skip["ui/settings/style.css.map"]
      }
      { rel = substr($0, 67); if (!(rel in skip)) print }
    ' "$STAGE_DIR/MANIFEST" > "$STAGE_DIR/MANIFEST.check"
    ( cd "$EXISTING_TREE" && sha256sum -c --status -- "$STAGE_DIR/MANIFEST.check" ) \
        || fail "tree does not match the release MANIFEST after applying the delta — aborting before the install. Re-run the update (it falls back to the full tarball)."
    # 4e. Remove orphans: files in the tree (outside the excluded caches)
    # that the new release no longer ships. (cut -d' ' -f3- because the
    # MANIFEST lines are "<hash><space><space><relpath>" — awk would
    # collapse the two spaces and shift the fields.)
    _orphans="$(comm -23 <(_tree_files "$EXISTING_TREE") <(cut -d' ' -f3- "$STAGE_DIR/MANIFEST" | LC_ALL=C sort) || true)"
    if [ -n "$_orphans" ]; then
        note "removing $(printf '%s\n' "$_orphans" | wc -l) orphan file(s) the new release dropped…"
        while IFS= read -r _rel; do
            [ -n "$_rel" ] || continue
            rm -f -- "$EXISTING_TREE/$_rel"
        done <<EOF
$_orphans
EOF
    fi
    SRC_DIR="$EXISTING_TREE"
    rm -rf "$STAGE_DIR"
    note "delta applied and verified — source tree: $SRC_DIR (version $(cat "$SRC_DIR/VERSION"))"
elif [ -n "$EXISTING_TREE" ] && [ "$RSYNC_OK" = 1 ]; then
    # ── Incremental full-tarball update ──────────────────────────────────────
    # Sync the new tree into the registered one. --checksum copies only
    # files whose content changed and leaves every unchanged file's mtime
    # alone, so cargo / npm / the C builds skip what is already built.
    # --delete removes files the new release dropped (an update REPLACES,
    # never accumulates). The tree keeps its path and its old dir name.
    # --no-owner/--no-group/--no-times: see the delta sync above.
    rsync -a --checksum --delete --no-owner --no-group --no-times "${RSYNC_EXCLUDES[@]}" "$NEW_DIR/" "$EXISTING_TREE/" \
        || fail "tree sync failed — aborting before the install. The tree may be partly updated; re-run the update (it converges on the next full sync)."
    SRC_DIR="$EXISTING_TREE"
    rm -rf "$STAGE_DIR"
    note "tree synced in place (only changed files replaced) — source tree: $SRC_DIR (version $(cat "$SRC_DIR/VERSION"))"
else
    # ── Fresh install (or rsync unavailable) ─────────────────────────────────
    # No registered tree to sync into: move the new tree into place and
    # remove the old trees. This is the old behaviour, kept for fresh
    # installs and as the fallback when rsync could not be installed.
    [ -z "$EXISTING_TREE" ] || note "rsync unavailable — falling back to the full re-extract (slow, but correct)."
    rm -rf "$WORK_DIR"/veltrix-*
    mv "$NEW_DIR" "$WORK_DIR/"
    SRC_DIR="$WORK_DIR/$(basename "$NEW_DIR")"
    rm -rf "$STAGE_DIR"
    note "source tree: $SRC_DIR (version $(cat "$SRC_DIR/VERSION"))"
fi

# --no-install (the background updater's helper): the tree is placed and
# verified, and that is all this run does. install.sh runs separately
# (as root, from the helper), which also records the release — so a
# --no-install run must NOT write .release here.
if [ "$NO_INSTALL" = 1 ]; then
    note "tree ready at $SRC_DIR — stopping before install.sh (--no-install)."
    exit 0
fi
note "running ./install.sh --dev — on an update this skips what is already built (unchanged Rust crates, current packages, the venv); a fresh install takes a while (system upgrade, then Rust compiles). Do not reboot mid-install."
(cd "$SRC_DIR" && ./install.sh --dev)
# No second veltrix-setup pass here: install.sh §5 already runs it
# unconditionally, on the just-installed files, so running it again is a
# pure duplicate. Set VELTRIX_OS_SETUP_SECOND_PASS=1 to restore it.
if [ "${VELTRIX_OS_SETUP_SECOND_PASS:-0}" = 1 ]; then
    note "running veltrix-setup (second pass, VELTRIX_OS_SETUP_SECOND_PASS=1)…"
    veltrix-setup
fi

# ── 5. Verify + summary ──────────────────────────────────────────────────────
note "verifying installed file permissions…"
if bash "$SRC_DIR/scripts/verify-installed-perms.sh" --dev; then
    # Record the installed release (e.g. 1.2) so the update check can
    # tell releases apart. Since 1.2 this is the same plain version
    # VERSION carries (the old 0.13.0-vN releases shared one VERSION,
    # 0.13.0); the marker is kept as the tag the install came from.
    # The tarball filename carries it (veltrix-<ver>.tar.gz); a GitHub
    # download URL's tag segment is the fallback. In delta mode the
    # delta's own filename is not a version, so --full-name supplies it.
    # Written only on a PASS — a failed install must not claim a release
    # it did not install. A branch-based install (install.sh --dev /
    # --update) clears this marker.
    _release_ver=""
    _tarball_base="${FULL_NAME:-$(basename "$TARBALL_FILE")}"
    case "$_tarball_base" in
        veltrix-*.tar.gz)
            _release_ver="${_tarball_base#veltrix-}"
            _release_ver="${_release_ver%.tar.gz}"
            ;;
    esac
    if [ -z "$_release_ver" ]; then
        case "$TARBALL_URL" in
            */releases/download/*/*)
                _tag="${TARBALL_URL#*/releases/download/}"
                _tag="${_tag%%/*}"
                _release_ver="${_tag#v}"
                ;;
        esac
    fi
    # A release version is a plain dotted version, optionally with the
    # old -vN packaging suffix (0.13.0-v7) — nothing else. The value
    # comes from a tarball filename / a download URL, so a strict shape
    # check here stops a smuggled path or junk string becoming the
    # recorded release (and then being compared — and shown — as one).
    if [[ ! "$_release_ver" =~ ^[0-9]+(\.[0-9]+)*(-v[0-9]+)?$ ]]; then
        _release_ver=""
    fi
    if [ -n "$_release_ver" ]; then
        mkdir -p "$HOME/.config/veltrix" 2>/dev/null || true
        printf '%s\n' "$_release_ver" > "$HOME/.config/veltrix/.release" \
            || echo "bootstrap: [WARN] could not record the installed release — the update check will compare against VERSION instead." >&2
    fi
    echo ""
    echo "bootstrap: PASS — VELTRIX installed and verified."
    echo "  Source (keep this folder — updates follow it): $SRC_DIR"
    echo "  Next: log out, pick the 'Veltrix' session at the login screen, log in as adnan."
    echo "  Then run the validations in docs/dell-validation-phase1.md."
    exit 0
else
    echo ""
    echo "bootstrap: FAIL — the permission verification failed (see [FAIL] lines above)."
    echo "  Do NOT log into the Veltrix session yet — photograph this screen and report it."
    echo "  The install tree is at: $SRC_DIR"
    exit 1
fi
