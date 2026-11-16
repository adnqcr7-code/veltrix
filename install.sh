#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Veltrix — Developer installer
# Usage:
#   ./install.sh --dev      # Developer install (run the UI from this source tree)
#   ./install.sh --update   # Update a dev install (or use veltrix-update)
#
# ⚠️ THIS IS NOT HOW THE DESKTOP IS INSTALLED. Since 2026-09-02 it does one job:
# put a working copy on a development machine. Installing VELTRIX on an
# Arch system is `pacman -S veltrix` from the [veltrix] repo — three
# commands, in the README, and pacman owns every file. The rule this follows is
# nidara-iso's PRODUCT.md, "What does NOT change": this script runs on a machine
# the project does not own, and the fewer ways it has to act like the owner, the
# less there is to get wrong. Running it with no arguments prints those commands.
#
# Update model (see bin/veltrix-update, which owns it): three paths.
#   DEV — a dev install updates from its own registered clone (.dev/.source),
#   following its branch.
#   GITHUB — a release-tarball install (bootstrap.sh from a GitHub release)
#   fetches the latest release, verifies its published .sha256 sidecar, and
#   re-runs the bootstrap. The update source is the remote release, never the
#   local tree — no per-user source copy is the update source, so the source
#   of truth stays the git remote + what's installed in /usr/share. (The
#   runtime is system-wide, so a per-user clone made no sense and diverged
#   between users.)
#   PACKAGE — a packaged install updates with plain `pacman -Syu`.
# Since 0.8.0 there are NO pinned upstream dependencies at all — every Astal/AGS
# package is gone, so there is nothing left for a pin file to gate and
# /usr/share/veltrix/pins is no longer written or read. What phases still skip on
# an update is the pacman sync, and that has its own fingerprint
# ($PACMAN_SHA_FILE, below).
# A --dev install registers the developer's own clone (~/.config/veltrix/.dev +
# .source) and updates from there, following its branch. A plain `./install.sh`
# (system) always rebuilds everything — the escape hatch — and migrates away any
# legacy ~/.local/share/veltrix/src.
# A release install records its version in ~/.config/veltrix/.release (written by
# bootstrap.sh / veltrix-update's GITHUB path); a branch-based install (--dev /
# --update) clears it, so the update check never compares a release number
# against a branch.
# Agent-carried local patches (clone path recorded in ~/.config/veltrix/.patches —
# see the in-repo veltrix skill, "Carrying a GLOBAL fix locally") make veltrix-update
# refuse the blind stateless path: the agent rebases the patch branch onto the new
# release and re-runs --update-apply instead. --update likewise refuses to checkout
# a release over local-only commits rather than silently dropping them.
#
# Packaging model: system installs get Veltrix itself as a pacman PACKAGE —
# prebuilt from the [veltrix] repo when it serves this release, else built
# locally from packaging/veltrix/PKGBUILD (§6) — so pacman owns every installed
# file. Dev installs keep copying source files into /usr directly (and remove
# the package first so pacman can't clobber the copies on -Syu).
# ─────────────────────────────────────────────────────────────────────────────

set -e

# Terminal colours for the install banner and the apps question — plain text
# when stdout is not a terminal (piped runs, transcripts), so logs stay clean.
if [ -t 1 ]; then
    VELTRIX_C_CYAN=$'\033[1;36m'
    VELTRIX_C_GREEN=$'\033[1;32m'
    VELTRIX_C_RESET=$'\033[0m'
else
    VELTRIX_C_CYAN=''
    VELTRIX_C_GREEN=''
    VELTRIX_C_RESET=''
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
# When run via `sudo bash install.sh`, $HOME is /root. Use SUDO_USER's home instead.
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"

# ⚠️ EVERY PATH BELOW IS BUILT ON $REAL_HOME, and an empty one does not fail — it
# rebases the whole installer onto /. Guarded because that exact class of bug had been
# live in this file for four days (see PKG_CACHE below): an empty prefix produces a
# VALID path, so nothing errors at the point of the mistake. `$USER` is normally set
# even over ssh, so this guard is hardening rather than a fix for something observed —
# but it costs one comparison and it is the difference between a clear message and
# `mkdir /src`.
if [ -z "$REAL_USER" ] || [ -z "$REAL_HOME" ]; then
    echo "  [ERR] Cannot determine the installing user's home directory." >&2
    echo "        REAL_USER='${REAL_USER}' (from \$SUDO_USER or \$USER), REAL_HOME='${REAL_HOME}'." >&2
    echo "        Run the installer from a login shell, or pass it explicitly:" >&2
    echo "          sudo SUDO_USER=\"\$(id -un)\" ./install.sh" >&2
    exit 1
fi

CONFIG_DIR="${REAL_HOME}/.config/veltrix"

# Where makepkg builds the local `veltrix` package and caches its sources.
#
# ⚠️ RESTORED 2026-08-24 — it had been UNSET since #200 (2026-08-20). That PR removed
# the last from-source dependency and deleted this assignment along with the code that
# used it, but FOUR uses survived, in `ensure_pkg_cache`, `build_install_pkg` and
# `build_local_veltrix_pkg`. All three are still reachable through the local-package
# fallback — the "correct but slow" path taken whenever the tree is not exactly the
# published release, which includes every branch, and every user whenever veltrix-repo
# has not published the current version yet.
#
# With it empty, that path built `/src`, `/veltrix` and `SRCDEST=/src`:
#   - run normally (install.sh runs as the USER and sudo's per command), it DIES at
#     `mkdir -p /src` — found in the VM, 2026-08-24;
#   - run as `sudo ./install.sh`, the same lines SUCCEED as root and write two
#     directories into the root filesystem, with `rm -rf "$pdir"` meaning `rm -rf
#     /veltrix`.
#
# Four days without anyone noticing, because CI never runs install.sh on a real
# system and an empty prefix makes a valid path rather than an error. That is the
# whole argument for the REAL_HOME guard above, and for the VM.
PKG_CACHE="${REAL_HOME}/.cache/veltrix/pkgbuild"

# Update plumbing (see header). SOURCE_FILE records a DEV install's source clone.
SOURCE_FILE="$CONFIG_DIR/.source"
REPO_URL="https://github.com/adnqcr7-code/veltrix.git"

# ── Mode selection ────────────────────────────────────────────────────────────
# update       = pull the registered source, then re-exec the NEW installer
# update-apply = internal: like system, but skips unchanged deps and never
#                touches the user's dev/source markers
MODE=""
for arg in "$@"; do
    case "$arg" in
        --dev)          MODE="dev" ;;
        --update)       MODE="update" ;;
        --update-apply) MODE="update-apply" ;;
        --help) echo "Usage: $0 [--dev|--update]"; exit 0 ;;
    esac
done

# No mode, or the retired --system: say how the desktop is actually installed and
# stop. A message rather than a default, because the default USED to install the
# desktop — anyone re-running an old command, or following an old page, must be
# told what replaced it instead of quietly getting a developer install.
if [ -z "$MODE" ]; then
    cat >&2 <<'USAGE'
install.sh installs a DEVELOPMENT copy of VELTRIX. To install the desktop
itself, use the package — pacman then owns every file, and upgrades and removal
are ordinary pacman:

    # TODO — the [veltrix] repo and its signing key do not exist yet (see README).
    # Every command below is COMMENTED OUT on purpose: nothing here may run until a
    # release publishes the repo and the real key + fingerprint. When it does, uncomment
    # and fill in the fingerprint; the curl already pins HTTPS (--proto=https) and the
    # key MUST be verified against the fingerprint published in the release notes
    # (independent channel) before --lsign-key runs.
    # curl --proto=https -O https://adnqcr7-code.github.io/veltrix-repo/veltrix.gpg
    # sudo pacman-key --add veltrix.gpg
    # sudo pacman-key --lsign-key <FINGERPRINT — published with the first release>

    # then add to /etc/pacman.conf:
    #   [veltrix]
    #   SigLevel = Required DatabaseOptional
    #   Server = https://adnqcr7-code.github.io/veltrix-repo/$arch

    sudo pacman -Syu veltrix && veltrix-setup

The full instructions, including what each step does, are in the README under
"Installation". To work ON the desktop instead, re-run this as:

    ./install.sh --dev
USAGE
    exit 1
fi

# Install banner (fresh --dev installs only) — the header the install
# terminal shows, matching the install-flow concept (Nov 12 2026).
if [ "$MODE" = "dev" ]; then
    echo ""
    echo "${VELTRIX_C_CYAN}VELTRIX Setup${VELTRIX_C_RESET}"
    echo "================"
fi

# ── User execution helper ────────────────────────────────────────────────────
# Run a command as the unprivileged user. makepkg refuses to run as root, so when
# the installer itself is invoked via `sudo` we drop back to $REAL_USER (with -H so
# npm caches land in the user's home, not /root).
run_user() {
    if [ "$(id -u)" -eq 0 ]; then sudo -u "$REAL_USER" -H "$@"; else "$@"; fi
}

# Normalize a just-copied system tree to exactly 644 (files) / 755 (dirs).
# `cp -r` preserves the repo's restrictive modes (660/770, root-owned after
# sudo), and `chmod -R a+rX` only ADDS bits — it leaves 660 files 664
# (group-writable) instead of 644. No file in any tree §4 copies is meant to
# be executable (verified 2026-11-13: none has the exec bit in the repo), so
# exact modes are safe, and are what scripts/verify-installed-perms.sh asserts.
fix_tree_perms() {
    sudo find "$1" -type f -exec chmod 644 {} +
    sudo find "$1" -type d -exec chmod 755 {} +
}

# sync_tree <src> <dest> [extra rsync args...] — replace a whole installed
# tree with the repo's copy, but only COPY the files whose content changed
# (rsync --checksum), instead of rm -rf + cp -r which re-copies every file
# on every update. --delete removes files the repo dropped (an update
# REPLACES, never accumulates). Modes are normalised by fix_tree_perms
# afterwards, exactly as the cp -r path did. (2026-11-14, fast updates:
# Adnan felt the update "reinstalling files that I have" — the re-copy
# of every tree was part of it.)
#
# Runs under sudo (the destination is root-owned, like every other §4
# copy) with --chown=root:root so the installed files stay root-owned,
# as `sudo cp` left them. --no-times: the mtime of a file rsync does NOT
# transfer is left alone, and a file it DOES transfer is changed by
# content — preserving the source mtime buys nothing here and fails
# (exit 23) when the tree holds a file owned by someone else.
# Falls back to the old rm -rf + cp -r when rsync is unavailable or the
# sync fails, so a missing rsync never breaks an install.
sync_tree() {
    local src="$1" dest="$2"; shift 2
    sudo mkdir -p "$dest"
    if command -v rsync >/dev/null 2>&1 \
        && sudo rsync -a --checksum --delete --no-times --chown=root:root "$@" "$src/" "$dest/"; then
        :
    else
        echo "  [WARN] rsync sync of $src failed or rsync is missing — falling back to a full copy." >&2
        sudo rm -rf "$dest"
        sudo cp -r "$src" "$dest"
    fi
    fix_tree_perms "$dest"
}

# Create the build cache with the USER owning it — ANCESTORS INCLUDED. Under sudo
# a bare `mkdir -p "$PKG_CACHE/…"` creates ~/.cache and ~/.cache/veltrix as root
# whenever they don't exist yet, and from then on everything the user's own
# session writes there fails silently (Astal's frequents cache, the album-art
# cache, and `veltrix-update`'s work dir — the list and the repair for installs
# already poisoned are in bin/veltrix-setup, beside the same fix for ~/.config).
# The trailing colon in `chown "$REAL_USER:"` here and below sets the group to the
# user's login group; without it chown leaves the group as root. See the longer note
# in bin/veltrix-setup.
ensure_pkg_cache() {
    mkdir -p "$PKG_CACHE/src"
    chown "$REAL_USER:" "${REAL_HOME}/.cache" "${REAL_HOME}/.cache/veltrix" 2>/dev/null || true
    chown -R "$REAL_USER:" "$PKG_CACHE" 2>/dev/null || true
}

# makepkg the PKGBUILD in dir $1, then hand the result to pacman.
#
# NO --overwrite here (removed in the Phase 0 fix pass): earlier Veltrix releases
# `meson install`-ed these libs straight into /usr as UNTRACKED files, and
# --overwrite '*' was the one-time hand-off that gave those paths to pacman. That
# migration is spent (2026-08); kept, the flag would let every dev install silently
# clobber ANY file owned by ANY package. A conflict now fails loud instead — the
# right outcome, since a file pacman already owns is a real conflict to resolve,
# not something to pave over.
#
# NO --skipinteg either (removed in the same pass): integrity checks are the point
# of makepkg, and a git source with sha256sums=('SKIP') already skips itself
# honestly — the flag only ever hid a REAL sum failing.
# $2… (optional) NAME the split packages to install. It is not a refinement:
# packaging/veltrix/PKGBUILD emits THREE packages — `veltrix`, `veltrix-kit`
# (which the desktop depends on) and `veltrix-installer` — and this script must
# never hand somebody the third. It runs on an Arch that is already in use, where
# a program whose job is to erase a disk has no business being installed, and the
# old `ls -t | head -1` would have picked whichever file makepkg happened to write
# last. All the named packages go to ONE `pacman -U`: files moved from the desktop
# to the kit (#108 phase 4) only change owner cleanly inside a single transaction.
# ⚠️ No `makepkg --pkg`: pacman 7.0 removed it and makepkg 7.1 answers
# `invalid option '--pkg'`, so this path was dead until 2026-09-23. makepkg builds
# every package; the names below pick which ones are installed.
build_install_pkg() {
    local dir="$1"; shift
    ensure_pkg_cache
    chown -R "$REAL_USER:" "$dir" 2>/dev/null || true
    # -f rebuild, --nodeps (install order is managed below)
    run_user bash -c "cd '$dir' && SRCDEST='$PKG_CACHE/src' makepkg -f --noconfirm --nodeps --noprogressbar"
    local pkgfiles=() want f
    if [ $# -gt 0 ]; then
        for want in "$@"; do
            # Anchored to the requested name — `veltrix-*` would also match
            # `veltrix-installer-*`, which is the exact mistake this guards.
            f="$(ls -t "$dir/$want"-[0-9]*.pkg.tar.* 2>/dev/null | head -1)"
            [ -n "$f" ] || { echo "  [ERR] makepkg produced no $want package in $dir" >&2; exit 1; }
            pkgfiles+=("$f")
        done
    else
        f="$(ls -t "$dir"/*.pkg.tar.* 2>/dev/null | head -1)"
        [ -n "$f" ] || { echo "  [ERR] makepkg produced no package in $dir" >&2; exit 1; }
        pkgfiles+=("$f")
    fi
    sudo pacman -U --noconfirm "${pkgfiles[@]}"
}

# Build the veltrix package itself from THIS tree and install it (§6). Uses the
# same PKGBUILD releases ship (packaging/veltrix/): makepkg finds a source file
# of the expected name in the build dir and skips the download, so we pack the
# working tree — as-is, uncommitted changes included: this is the escape-hatch/
# non-release path and must install what's here — under the tarball name and
# prefix the PKGBUILD expects. Build artifacts and node_modules are excluded
# because build() regenerates them. The SH transform flags keep symlink/hardlink
# TARGETS untouched (assets contain relative symlinks).
build_local_veltrix_pkg() {
    local pdir="$PKG_CACHE/veltrix" pkgver
    pkgver="$(grep '^pkgver=' "$REPO_DIR/packaging/veltrix/PKGBUILD" | head -1 | cut -d= -f2)"
    if [ "$pkgver" != "$(cat "$REPO_DIR/VERSION")" ]; then
        echo "  [WARN] packaging/veltrix/PKGBUILD pkgver=$pkgver ≠ VERSION=$(cat "$REPO_DIR/VERSION") —"
        echo "         these are bumped together in release commits; packaging this tree as $pkgver."
    fi
    ensure_pkg_cache
    rm -rf "$pdir"
    mkdir -p "$pdir"
    cp "$REPO_DIR/packaging/veltrix/PKGBUILD" "$REPO_DIR/packaging/veltrix/veltrix.install" "$pdir/"
    tar -C "$REPO_DIR" -czf "$pdir/veltrix-$pkgver.tar.gz" \
        --exclude='./.git' --exclude='./session/target' \
        --exclude='./lib/veltrix-host/build' --exclude='./build/veltrix-host' \
        --exclude='./ui/shell/node_modules' --exclude='./ui/shell/@girs' \
        --exclude='./ui/settings/build' --exclude='./ui/shell/build' --exclude='./ui/greeter/build' \
        --exclude='./ui/greeter/node_modules' --exclude='./ui/lockscreen/build' \
        --exclude='./ui/lockscreen/node_modules' \
        --exclude='./packaging/veltrix/src' --exclude='./packaging/veltrix/pkg' \
        --exclude='./packaging/veltrix/*.tar.*' \
        --transform "s|^\.|veltrix-$pkgver|SH" .
    build_install_pkg "$pdir" veltrix veltrix-kit
}

echo ""
echo "  Veltrix Installer"
echo "  Mode: $MODE"
echo "  Repo: $REPO_DIR"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Update mode: refresh the registered source, then hand over to the NEW installer
# (--update-apply) so the update always runs with the just-pulled logic.
# ─────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = "update" ]; then
    SRC=""
    [ -f "$SOURCE_FILE" ] && SRC="$(cat "$SOURCE_FILE")"
    if [ -z "$SRC" ] || [ ! -d "$SRC/.git" ]; then
        # Pre-registration installs: fall back to the checkout we're running from.
        if [ -d "$REPO_DIR/.git" ]; then
            SRC="$REPO_DIR"
        else
            echo "  [ERR] No registered source and this directory is not a git checkout." >&2
            echo "        Re-clone the repo and run ./install.sh once to (re)register it:" >&2
            echo "          git clone $REPO_URL && cd veltrix && ./install.sh" >&2
            exit 1
        fi
    fi

    echo "  Updating source: $SRC"
    if [ -n "$(run_user git -C "$SRC" status --porcelain)" ]; then
        echo "  [ERR] $SRC has local changes — refusing to update over them." >&2
        echo "        Commit/stash them (or update manually with git), then retry. Local" >&2
        echo "        fixes meant to survive updates belong committed on a local/patches" >&2
        echo "        branch — see the veltrix skill, 'Carrying a GLOBAL fix locally'." >&2
        exit 1
    fi
    # Fetch ONLY release tags (v*), never --tags: the repo also carries MOVING
    # utility tags (ci-assets, re-pointed on every typings republish) and git
    # refuses to clobber a changed local tag, aborting the whole update. Release
    # tags are immutable so the plain (non-forced) refspec is safe; the branch
    # itself is fetched by the pull below.
    run_user git -C "$SRC" fetch origin 'refs/tags/v*:refs/tags/v*'

    # Dev clones follow their branch; everyone else jumps to the newest release
    # tag when releases exist (the stable channel), or fast-forwards main before
    # the first release.
    latest_tag="$(run_user git -C "$SRC" tag -l 'v*' --sort=-v:refname | head -1)"
    if [ -f "$CONFIG_DIR/.dev" ] || [ -z "$latest_tag" ]; then
        run_user git -C "$SRC" pull --ff-only origin "$(run_user git -C "$SRC" rev-parse --abbrev-ref HEAD)" \
            || { echo "  [ERR] fast-forward pull failed (diverged history?) — update manually with git." >&2; exit 1; }
    else
        # Local commits the release doesn't include (agent-carried patches — see the
        # veltrix skill, "Carrying a GLOBAL fix locally") would be silently dropped by
        # the checkout below. Refuse loudly; the carry flow rebases + --update-apply.
        local_commits="$(run_user git -C "$SRC" rev-list --count "$latest_tag..HEAD" --not --remotes=origin 2>/dev/null || echo 0)"
        if [ "${local_commits:-0}" -gt 0 ]; then
            echo "  [ERR] $SRC carries $local_commits local commit(s) that $latest_tag doesn't include —" >&2
            echo "        updating would silently stop applying them. Ask your agent to update:" >&2
            echo "        it rebases the patches onto $latest_tag and re-runs the apply pass" >&2
            echo "        (git rebase $latest_tag && ./install.sh --update-apply)." >&2
            exit 1
        fi
        run_user git -C "$SRC" checkout -q "$latest_tag"
        echo "  Source at release $latest_tag"
    fi

    # The install now follows a branch, not a release: clear the release
    # marker (see --dev above) before handing over. Placed after the pull /
    # checkout, so a failed refresh keeps the old marker.
    rm -f "$CONFIG_DIR/.release"

    exec bash "$SRC/install.sh" --update-apply
fi


# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 (pacman) carries its own fingerprint: an update skips the sync when the
# package list has not changed, but a CHANGED list (e.g. a new runtime tool like
# playerctl) must still run — otherwise updated installs silently miss
# dependencies that fresh installs get.
#
# This used to sit beside a second fingerprint, the upstream pins, which decided
# whether the Astal stack had to be recompiled. There is no upstream stack left
# to recompile since 0.8.0, so this is the only one.
# ─────────────────────────────────────────────────────────────────────────────
PACMAN_SHA_FILE="/usr/share/veltrix/pins-pacman"
SYNC_PACMAN="yes"
# ── The dependency list is DERIVED from the package, never kept beside it ────
# A second, hand-maintained list of 80 names used to live here. By 2026-09-02 it
# had drifted from `depends=()` in BOTH directions at once (#379): `dconf`, `git`
# and `libwireplumber` were real dependencies it never installed — the desktop
# worked because they happened to arrive transitively — while eight names it DID
# install had no use anywhere in the tree, left over from the Astal build
# toolchain whose packages were purged on 2026-08-24. Two hand-kept lists for one
# product is a promise to keep them in step, kept by nobody.
#
# So the PKGBUILD's arrays ARE the dependency statement, and this reads them.
# Only the two arrays are sourced — the same idiom the `pkgbuild` CI job uses —
# never the whole file, so none of its functions or top-level statements run.
#
# ⚠️ Version constraints are stripped. `hyprland>=0.56` is valid *dependency*
# syntax and is NOT a valid pacman target: passed through, it makes the install
# fail to parse its own arguments. The floor stays enforced where it belongs, by
# the package.
# ⚠️ The range MUST end on `/^)/` — a closing paren in column 1 — and both arrays
# are written to close that way for this reason. `depends=()` contains a comment
# line ending in `)` ("…native C/TS)"), so a looser end pattern stops the range
# there, sources an unterminated `depends=(` and yields an EMPTY array. Caught
# only because of the sanity check below; nothing else would have said a word.
_pkgbuild_array() {
    local name="$1" pkgbuild="$REPO_DIR/packaging/veltrix/PKGBUILD"
    source <(sed -n "/^$name=(/,/^)/p" "$pkgbuild") 2>/dev/null || return 1
    local -n _arr="$name" 2>/dev/null || return 1
    printf '%s\n' "${_arr[@]}"
}
PACMAN_DEPS="$(
    { _pkgbuild_array depends; _pkgbuild_array makedepends; } \
        | sed 's/[<>=].*//' | grep -v '^$' | tr '\n' ' '
)"
# The ONLY names not derived, and both are build tools rather than dependencies:
# the package's build() runs under makepkg, which supplies `base-devel` on its
# own, and this script compiles the same C without makepkg — so it has to ask.
# `glib2-devel` carries the .pc files `pkg-config --cflags glib-2.0` needs; Arch
# split them out of `glib2`. Anything added here is a claim that the DEV path
# needs it and the package does not — if that is not true, it belongs in the
# PKGBUILD instead.
PACMAN_DEPS="$PACMAN_DEPS base-devel glib2-devel"

# Fail loudly rather than install a truncated list: a `depends=()` that stops
# sourcing (an unquoted `>` did exactly that in v0.6.0) would otherwise silently
# reduce this to the two build tools above.
if [ "$(printf '%s' "$PACMAN_DEPS" | wc -w)" -lt 40 ]; then
    echo "install.sh: could not read the dependency arrays from packaging/veltrix/PKGBUILD" >&2
    echo "            (got: $PACMAN_DEPS)" >&2
    exit 1
fi
DEPS_LIST_SHA="$(printf '%s' "$PACMAN_DEPS" | sha256sum | awk '{print $1}')"
OLD_VERSION="$(cat /usr/share/veltrix/VERSION 2>/dev/null || echo "?")"
# `--update-apply` is the second half of `--update`, and both only ever run against
# a dev install now — the stable channel that used to reach this script is gone
# with the system path (2026-09-02). Refuse rather than half-install: an
# --update-apply on a machine with no .dev used to mean "apply a system install",
# and that no longer exists.
if [ "$MODE" = "update-apply" ] && [ ! -f "$CONFIG_DIR/.dev" ]; then
    echo "install.sh --update-apply: this machine has no dev install to update" >&2
    echo "            ($CONFIG_DIR/.dev is missing). A packaged install updates with" >&2
    echo "            'veltrix-update', and a fresh one is 'pacman -Syu veltrix'." >&2
    exit 1
fi
if [ "$MODE" = "update-apply" ] || [ "$MODE" = "dev" ]; then
    if [ -f "$PACMAN_SHA_FILE" ] && [ "$DEPS_LIST_SHA" = "$(cat "$PACMAN_SHA_FILE")" ]; then
        SYNC_PACMAN="no"
    else
        echo "  Package list changed (or not yet recorded) — phase 1 will run."
    fi
fi

# (System environment detection — keyboard layout / timezone / locale — lives
# in bin/veltrix-setup now, next to its only consumers: the per-user config
# seeds and the greetd template.)


# ─────────────────────────────────────────────────────────────────────────────
# Extra apps — the install-terminal apps question (iPad Mode, Nov 12 2026).
#
# WHERE IT LIVES: this script, the install terminal, AFTER everything is
# ready (§1–§4) and BEFORE first-time setup (§5) and the login handoff. It is
# NOT a GUI step, NOT a first-boot/desktop prompt, and NOT asked again on
# updates. Flow: git clone → ./install.sh --dev → packages ready → this
# question → first login. (The repo URL in the flow — github.com/adnqcr7-code/
# veltrix — does not exist yet; Phase 11 publish.)
#
# HOW IT WORKS:
#   1. §1 pre-downloads the repo packages (apps_predownload, pacman -Sw) so
#      the picked ones install from the local cache in seconds.
#   2. ask_extra_apps prints the numbered list 1–10, parses space-separated
#      numbers or 'all', re-prompts on invalid input, never crashes, and
#      records the choice in $APPS_CHOICE_FILE (/etc/veltrix/apps.json).
#   3. install_extra_apps installs exactly what was picked, from the cache.
#      A failed app is warned about, recorded in the choice file's "failed"
#      list, and never blocks the install.
#   4. A recorded choice is never asked twice: re-running ./install.sh --dev
#      skips the question (see the call site before §5).
#
# WHAT EACH APP MEANS (honest — nothing faked):
#   WhatsApp            — web app: a .desktop file that opens the site
#     (xdg-open). There is no package to install; the "install" is instant
#     and the site needs network to USE.
#   Telegram, VLC, LibreOffice, VS Code, Discord, GIMP — repo packages
#     (telegram-desktop, vlc, libreoffice-fresh, code, discord, gimp),
#     pre-downloaded into the pacman cache in §1.
#   Spotify, FreeTube   — Flatpak from Flathub (com.spotify.Client,
#     io.freetubeapp.FreeTube). NOT pre-downloaded: Flatpak has no
#     download-only step this script can run offline, so they download
#     when picked. The prompt says so. FreeTube replaces the YouTube
#     web app (v1.2, Adnan's safer/halal call): a privacy-focused
#     YouTube client — no ads, no tracking, no account, no
#     recommendation feed pushing content — instead of opening
#     youtube.com in a browser, with its ads, tracking and algorithmic
#     recommendations. It still plays YouTube videos (that is what it
#     is for); it just does it without the parts that push content at
#     you. Upstream notes it is still in beta.
#   VS Code is the open-source `code` build from extra, not the
#   Microsoft-branded build (AUR-only).
#   Vile              — Adnan's own privacy browser (v48 source, vendored
#     in vile/). Built from source with CMake + Qt6 WebEngine when picked:
#     the build deps (cmake, sqlite, qt6-base, qt6-webengine) are installed
#     on demand, never pre-downloaded, and the build takes a few minutes
#     on the Dell — the prompt says so. The binary lands in
#     /usr/local/bin/vile with a vile.desktop file and its own icon.
#     There is no package, no Flatpak and no download URL: the source
#     travels in the release tarball (see vile/VENDORED.md). Picking
#     nothing installs nothing Vile.
#
# TEST SEAMS (test-only — never honoured in a shipped install):
# VELTRIX_APPS_NO_SUDO=1 runs the privileged commands directly;
# VELTRIX_APPS_CHOICE_FILE, VELTRIX_APPS_DESKTOP_DIR and
# VELTRIX_APPS_VERSIONS_FILE override the output paths. VELTRIX_VILE_BIN_DIR
# and VELTRIX_VILE_ICON_DIR override where the Vile binary and icon are
# installed. The prompt function is exercised by tests that extract
# it from this file (see the iPad Mode report) — never by copying it.
# A shipped install must leave all three unset: with the choice-file
# seam set, a root `tee` write follows whatever path it names.
#
# DISCLOSURE (security review F6/F7 — what this block changes on the
# machine, in the open, before it happens): §1 pre-downloads the 6
# repo packages (~700 MB, LibreOffice alone ~400 MB) into the pacman
# cache BEFORE the user is asked — the §1 output says so before it
# runs, and the fork README lists it. Picking Spotify or FreeTube adds Flathub as
# a persistent SYSTEM-wide Flatpak remote (any user can then install
# from Flathub) — the prompt says so, and the README lists it. Removal:
# see the README ("Removing the extra apps").
# ─────────────────────────────────────────────────────────────────────────────
APPS_CHOICE_FILE="${VELTRIX_APPS_CHOICE_FILE:-/etc/veltrix/apps.json}"
APPS_DESKTOP_DIR="${VELTRIX_APPS_DESKTOP_DIR:-/usr/share/applications}"
# The list, in the order the prompt shows it. Index i (0-based) is number i+1.
APPS_IDS=(freetube whatsapp telegram spotify vlc libreoffice vscode discord gimp vile)
APPS_NAMES=("FreeTube" "WhatsApp" "Telegram" "Spotify" "VLC" "LibreOffice" "VS Code" "Discord" "GIMP" "Vile")
# Repo package per app; empty = no package (web app, Spotify/FreeTube via Flatpak, Vile built from source).
APPS_PKGS=("" "" "telegram-desktop" "" "vlc" "libreoffice-fresh" "code" "discord" "gimp" "")
# Vile's version, as recorded in the versions log (CMake project version
# 0.1.0; "v48" is the iteration count of the vendored source — see vile/VENDORED.md).
VILE_VERSION="0.1.0 (v48)"
# Where the Vile binary and icon are installed (test seams below).
VILE_BIN_DIR="${VELTRIX_VILE_BIN_DIR:-/usr/local/bin}"
VILE_ICON_DIR="${VELTRIX_VILE_ICON_DIR:-/usr/share/icons/hicolor/256x256/apps}"
# The ids the user picked this run (set by ask_extra_apps).
APPS_PICKED=()
# Ids that failed to install this run (set by install_extra_apps); the
# final banner surfaces them (security review F8) instead of printing
# a green "complete" over silent failures.
APPS_FAILED=()
# 1 once apps_predownload has downloaded the repo packages in §1.
# ask_extra_apps prints the honest line for the state it finds: when
# §1 was skipped (deps unchanged) the cache may be cold, so the
# "pre-downloaded" claim must not be printed (code review §3.14).
APPS_PREDOWNLOADED=0
# Where installed versions are logged (security review F9).
APPS_VERSIONS_FILE="${VELTRIX_APPS_VERSIONS_FILE:-/etc/veltrix/apps-versions.log}"

# Run a privileged command, or run it directly under the test seam.
apps_sudo() {
    if [ -n "${VELTRIX_APPS_NO_SUDO:-}" ]; then "$@"; else sudo "$@"; fi
}

# Prompt language from $LANG (en/ar/es, default en). App names stay English.
apps_lang() {
    local lang="${LANG:-en}"
    lang="${lang%%_*}"; lang="${lang%%.*}"; lang="${lang,,}"
    case "$lang" in ar|es) printf '%s' "$lang" ;; *) printf 'en' ;; esac
}

# User-facing prompt strings. `invalid` and `installing` carry one %s each.
apps_msg() {
    local lang; lang="$(apps_lang)"
    case "$1" in
        question) case "$lang" in
            ar) printf '%s' "ما التطبيقات التي تريد تثبيتها؟" ;;
            es) printf '%s' "¿Qué aplicaciones quieres instalar?" ;;
            *)  printf '%s' "Which apps do you want installed?" ;; esac ;;
        hint) case "$lang" in
            ar) printf '%s' "اكتب الأرقام مفصولة بمسافات. اكتب all للكل." ;;
            es) printf '%s' "Escribe los números, separados por espacios. Escribe all para todas." ;;
            *)  printf '%s' "Type the numbers, separated by spaces. Type all for everything." ;; esac ;;
        predownload) case "$lang" in
            ar) printf '%s' "معظم التطبيقات مُنزَّلة مسبقًا — تُثبَّت في ثوانٍ. (سبوتيفاي وفري تيوب يُنزَّلان من Flathub.)" ;;
            es) printf '%s' "La mayoría de las aplicaciones ya están descargadas: se instalan en segundos. (Spotify y FreeTube se descargan de Flathub.)" ;;
            *)  printf '%s' "Most apps are pre-downloaded — they install in seconds. (Spotify and FreeTube download from Flathub.)" ;; esac ;;
        predownload-cold) case "$lang" in
            ar) printf '%s' "ستُنزَّل التطبيقات التي تختارها عند تثبيتها — لم تُنزَّل مسبقًا هذه المرة. (سبوتيفاي وفري تيوب يُنزَّلان من Flathub.)" ;;
            es) printf '%s' "Las aplicaciones que elijas se descargarán al instalarse: esta vez no se pre-descargaron. (Spotify y FreeTube se descargan de Flathub.)" ;;
            *)  printf '%s' "The apps you pick will download when installed — they were not pre-downloaded this run. (Spotify and FreeTube download from Flathub.)" ;; esac ;;
        flathub) case "$lang" in
            ar) printf '%s' "اختيار سبوتيفاي أو فري تيوب يضيف Flathub كمصدر تطبيقات دائم لكل مستخدمي الجهاز." ;;
            es) printf '%s' "Elegir Spotify o FreeTube añade Flathub como fuente de aplicaciones permanente para todos los usuarios de la máquina." ;;
            *)  printf '%s' "Picking Spotify or FreeTube adds Flathub as a permanent system-wide app source for all users of this machine." ;; esac ;;
        choice) case "$lang" in
            ar) printf '%s' "اختيارك: " ;;
            es) printf '%s' "Tu elección: " ;;
            *)  printf '%s' "Your choice: " ;; esac ;;
        press_enter) case "$lang" in
            ar) printf '%s' "اضغط Enter عند الانتهاء." ;;
            es) printf '%s' "Pulsa Enter cuando termines." ;;
            *)  printf '%s' "Press Enter when you're done." ;; esac ;;
        invalid) case "$lang" in
            ar) printf '%s' "غير صالح: %s — اكتب أرقامًا من 1 إلى 10 مفصولة بمسافات، أو 'all'." ;;
            es) printf '%s' "No válido: %s — escribe números del 1 al 10 separados por espacios, o 'all'." ;;
            *)  printf '%s' "Not valid: %s — type numbers 1–10 separated by spaces, or 'all'." ;; esac ;;
        none) case "$lang" in
            ar) printf '%s' "لا تطبيقات إضافية — المتابعة." ;;
            es) printf '%s' "Sin aplicaciones extra: continuando." ;;
            *)  printf '%s' "No extra apps — continuing." ;; esac ;;
        installing) case "$lang" in
            ar) printf '%s' "جارٍ التثبيت: %s" ;;
            es) printf '%s' "Instalando: %s" ;;
            *)  printf '%s' "Installing: %s" ;; esac ;;
        ready) case "$lang" in
            ar) printf '%s' "كل شيء جاهز." ;;
            es) printf '%s' "Todo está listo." ;;
            *)  printf '%s' "Everything is ready." ;; esac ;;
        already) case "$lang" in
            ar) printf '%s' "تم اختيار التطبيقات الإضافية مسبقًا (انظر %s) — تخطٍّ." ;;
            es) printf '%s' "Las aplicaciones extra ya se eligieron (ver %s): omitiendo." ;;
            *)  printf '%s' "Extra apps already chosen (see %s) — skipping." ;; esac ;;
    esac
}

# One-line description per app, in the prompt language.
apps_desc() {
    local lang; lang="$(apps_lang)"
    case "$1" in
        freetube) case "$lang" in ar) printf '%s' "مشاهدة الفيديوهات — بدون إعلانات أو تتبّع" ;; es) printf '%s' "ver vídeos — sin anuncios ni rastreo" ;; *) printf '%s' "watch videos — no ads, no tracking" ;; esac ;;
        whatsapp) case "$lang" in ar) printf '%s' "الرسائل والمكالمات" ;; es) printf '%s' "mensajes y llamadas" ;; *) printf '%s' "messages and calls" ;; esac ;;
        telegram) case "$lang" in ar) printf '%s' "الرسائل والقنوات" ;; es) printf '%s' "mensajes y canales" ;; *) printf '%s' "messages and channels" ;; esac ;;
        spotify) case "$lang" in ar) printf '%s' "الموسيقى والبودكاست" ;; es) printf '%s' "música y pódcasts" ;; *) printf '%s' "music and podcasts" ;; esac ;;
        vlc) case "$lang" in ar) printf '%s' "تشغيل أي فيديو أو صوت" ;; es) printf '%s' "reproducir cualquier vídeo o audio" ;; *) printf '%s' "play any video or audio" ;; esac ;;
        libreoffice) case "$lang" in ar) printf '%s' "المستندات وجداول البيانات" ;; es) printf '%s' "documentos y hojas de cálculo" ;; *) printf '%s' "documents and spreadsheets" ;; esac ;;
        vscode) case "$lang" in ar) printf '%s' "محرر أكواد" ;; es) printf '%s' "editor de código" ;; *) printf '%s' "code editor" ;; esac ;;
        discord) case "$lang" in ar) printf '%s' "الدردشة والمجتمعات" ;; es) printf '%s' "chat y comunidades" ;; *) printf '%s' "chat and communities" ;; esac ;;
        gimp) case "$lang" in ar) printf '%s' "محرر صور" ;; es) printf '%s' "editor de imágenes" ;; *) printf '%s' "image editor" ;; esac ;;
        vile) case "$lang" in ar) printf '%s' "متصفح خاص — يُبنى من المصدر (بضع دقائق)" ;; es) printf '%s' "navegador privado — se compila desde el código (unos minutos)" ;; *) printf '%s' "private browser — built from source (a few minutes)" ;; esac ;;
    esac
}

# Download-only the repo packages into the pacman cache (§1, fresh --dev
# only). Nothing is installed here — the user has not been asked yet. A
# failure is a warning: the picked apps then download at install time.
# Disclosure (F6): the call site in §1 prints the plan and the size
# BEFORE this runs; this function also sets APPS_PREDOWNLOADED so the
# prompt prints the honest line if §1 was skipped and the cache is cold.
apps_predownload() {
    if [ "$MODE" != "dev" ]; then return 0; fi
    # FAST UPDATE (2026-11-14): when a choice is already recorded, the
    # apps question is never re-asked (see the call site before §5) — so
    # the pre-download warms a cache nothing will read. The picked apps
    # are already installed, and install_extra_apps never runs on an
    # update. Skip the ~700 MB download; a fresh install (no choice file)
    # still pre-downloads, as before.
    if [ -f "$APPS_CHOICE_FILE" ]; then
        echo "  Extra apps already chosen (recorded in $APPS_CHOICE_FILE) — skipping the ~700 MB pre-download."
        return 0
    fi
    local pkgs="" p
    for p in "${APPS_PKGS[@]}"; do [ -n "$p" ] && pkgs="$pkgs $p"; done
    # Unquoted on purpose: word-splitting wanted (same idiom as the deps install).
    # shellcheck disable=SC2086
    if ! apps_sudo pacman -Sw --noconfirm --needed $pkgs; then
        echo "  [WARN] Could not pre-download the extra apps — the ones you pick will be downloaded when installed, if the network is up." >&2
    else
        APPS_PREDOWNLOADED=1
    fi
}

# Write {"apps": [...], "failed": [...]} to the choice file.
# Symlink-safe (F5) and guarded (F4): the file is written to a temp
# file in the same directory and moved into place, so a planted symlink
# at the destination is replaced, never followed, and the victim behind
# it is untouched. A refused symlink or a failed write prints a warning
# and returns 1 — callers MUST guard the call, because under `set -e`
# an unguarded failure here aborts the whole install after §4
# succeeded, over a non-critical bookkeeping write. Explicit mode 644
# (F11): the mode must not depend on root's ambient umask.
apps_write_choice() {
    local apps_json="$1" failed_json="$2"
    if [ -L "$APPS_CHOICE_FILE" ]; then
        echo "  [WARN] $APPS_CHOICE_FILE is a symlink — refusing to write the extra-apps choice there." >&2
        return 1
    fi
    local dir tmp
    dir="$(dirname "$APPS_CHOICE_FILE")"
    tmp="$dir/.apps.json.tmp.$$"
    if ! apps_sudo mkdir -p "$dir"; then
        echo "  [WARN] Could not create $dir — the extra-apps choice was not recorded." >&2
        return 1
    fi
    if ! printf '{\n  "apps": [%s],\n  "failed": [%s]\n}\n' "$apps_json" "$failed_json" \
        | apps_sudo tee "$tmp" >/dev/null; then
        echo "  [WARN] Could not write the extra-apps choice — continuing without recording it." >&2
        return 1
    fi
    apps_sudo chmod 644 "$tmp" 2>/dev/null || true
    if ! apps_sudo mv "$tmp" "$APPS_CHOICE_FILE"; then
        echo "  [WARN] Could not record the extra-apps choice — continuing without it." >&2
        apps_sudo rm -f "$tmp" 2>/dev/null || true
        return 1
    fi
    return 0
}

# Log one installed app's version (F9): `pacman -Q <pkg>` for repo
# packages, `flatpak list` for Spotify. Best-effort only — a failed
# lookup must never fail the install.
apps_log_version() {
    local id="$1" pkg="$2"
    apps_sudo mkdir -p "$(dirname "$APPS_VERSIONS_FILE")" 2>/dev/null || true
    {
        if [ "$id" = "spotify" ]; then
            apps_sudo flatpak list --app 2>/dev/null | grep -F "com.spotify.Client" || echo "spotify: version unknown"
        elif [ "$id" = "freetube" ]; then
            apps_sudo flatpak list --app 2>/dev/null | grep -F "io.freetubeapp.FreeTube" || echo "freetube: version unknown"
        elif [ "$id" = "vile" ]; then
            # Vile ships no --version flag (QCommandLineParser has only
            # --help), so the version is the vendored source's own label.
            echo "vile $VILE_VERSION"
        elif [ -n "$pkg" ]; then
            apps_sudo pacman -Q "$pkg" 2>/dev/null || echo "$pkg: version unknown"
        else
            echo "$id: web app (no package)"
        fi
    } | apps_sudo tee -a "$APPS_VERSIONS_FILE" >/dev/null 2>&1 || true
}

# The prompt itself. Prints the ready summary, the numbered list, and reads
# the choice; sets APPS_PICKED (ids, in list order) and records the choice.
ask_extra_apps() {
    echo ""
    # These four lines depend on `set -e`: §4 has no `|| true` escape on
    # any of the four steps they name, so reaching here means all four
    # succeeded. If a §4 step ever gains a guarded fallback, check it
    # here instead of printing [ok] unconditionally (code review §3.5).
    echo "  ${VELTRIX_C_GREEN}[ok] Hyprland${VELTRIX_C_RESET}"
    echo "  ${VELTRIX_C_GREEN}[ok] Veltrix shell${VELTRIX_C_RESET}"
    echo "  ${VELTRIX_C_GREEN}[ok] Prayer times & Hijri calendar${VELTRIX_C_RESET}"
    echo "  ${VELTRIX_C_GREEN}[ok] Fonts${VELTRIX_C_RESET}"
    echo "  ${VELTRIX_C_GREEN}$(apps_msg ready)${VELTRIX_C_RESET}"
    echo ""
    echo "$(apps_msg question)"
    echo "$(apps_msg hint)"
    if [ "$APPS_PREDOWNLOADED" -eq 1 ]; then
        echo "$(apps_msg predownload)"
    else
        echo "$(apps_msg predownload-cold)"
    fi
    echo "$(apps_msg flathub)"
    echo ""
    local i
    for i in "${!APPS_IDS[@]}"; do
        printf '%s%d.%s %s — %s\n' "$VELTRIX_C_CYAN" "$((i+1))" "$VELTRIX_C_RESET" \
            "${APPS_NAMES[$i]}" "$(apps_desc "${APPS_IDS[$i]}")"
    done
    echo ""
    local line token n picked=() invalid=() ok all=0 tokens=()
    while true; do
        if ! IFS= read -r -p "$(apps_msg choice)" line; then
            # read fails on EOF — but a piped final line WITHOUT a
            # trailing newline still lands in $line (code review §3.2):
            # keep it (do NOT clear it) and let the parse below treat
            # it as input. EOF-with-nothing leaves $line empty, which
            # the empty check below turns into "none". Never loops.
            :
        fi
        # Empty input = none.
        if [ -z "${line//[[:space:]]/}" ]; then
            picked=()
            break
        fi
        # 'all' on its own (any case) = everything. Matched on the
        # whitespace-NORMALISED line (F10): "a l l" is three tokens,
        # not the word "all", and must not select everything.
        local trimmed
        trimmed="$(printf '%s' "$line" | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//')"
        if printf '%s' "$trimmed" | grep -qi '^all$'; then
            picked=(1 2 3 4 5 6 7 8 9 10)
            break
        fi
        invalid=(); picked=(); ok=1
        # read -ra, not `for token in $line` (F1): an unquoted expansion
        # glob-expands the user's input before the numeric check, so a
        # `*` in a directory with single-digit files silently selected
        # apps. read -ra splits on whitespace with no globbing.
        read -ra tokens <<< "$line"
        for token in "${tokens[@]}"; do
            if ! [[ "$token" =~ ^[0-9]+$ ]]; then ok=0; invalid+=("$token"); continue; fi
            # Reject long tokens before arithmetic (F2): $((10#…)) wraps
            # modulo 2^64, so 2^64+5 was silently accepted as 5.
            if [ "${#token}" -gt 2 ]; then ok=0; invalid+=("$token"); continue; fi
            n=$((10#$token))
            if [ "$n" -lt 1 ] || [ "$n" -gt 10 ]; then ok=0; invalid+=("$token"); continue; fi
            # Dedupe, keep first-seen order.
            case " ${picked[*]} " in *" $n "*) ;; *) picked+=("$n") ;; esac
        done
        if [ "$ok" -eq 1 ] && [ "${#picked[@]}" -gt 0 ]; then break; fi
        if [ "$ok" -eq 1 ]; then
            # All tokens were consumed by dedupe only if picked is empty —
            # unreachable (a valid token always lands in picked), but stay safe.
            break
        fi
        printf "$(apps_msg invalid)\n" "${invalid[*]}"
    done
    echo "$(apps_msg press_enter)"
    # Map numbers to ids, sorted by list order.
    APPS_PICKED=()
    local ids_json="" first=1 id names=""
    if [ "${#picked[@]}" -gt 0 ]; then
        picked=( $(printf '%s\n' "${picked[@]}" | sort -n) )
        for n in "${picked[@]}"; do
            id="${APPS_IDS[$((n-1))]}"
            APPS_PICKED+=("$id")
            if [ "$first" -eq 1 ]; then first=0; else ids_json="$ids_json, "; names="$names, "; fi
            ids_json="$ids_json\"$(apps_json_escape "$id")\""
            names="$names${APPS_NAMES[$((n-1))]}"
        done
        printf "$(apps_msg installing)\n" "$names"
    else
        echo "$(apps_msg none)"
    fi
    # Guarded (F4): a failed bookkeeping write warns and the install
    # goes on — APPS_PICKED is already set in memory, so the installs
    # below still run even if the choice was not recorded.
    apps_write_choice "$ids_json" "" || echo "  [WARN] Continuing without a recorded extra-apps choice." >&2
}

# Install one repo package (from the pre-downloaded cache when §1 ran).
apps_pkg() {
    apps_sudo pacman -S --noconfirm --needed "$1"
}

# Write a web-app .desktop file (WhatsApp): no package, the
# "install" is the file itself; the site needs network to USE.
# Explicit mode 644 (F11): must not depend on root's ambient umask.
apps_webapp() {
    local id="$1" name="$2" url="$3" icon="$4"
    {
        printf '[Desktop Entry]\n'
        printf 'Name=%s\n' "$name"
        printf 'Comment=%s (web app)\n' "$name"
        printf 'Exec=xdg-open %s\n' "$url"
        printf 'Icon=%s\n' "$icon"
        printf 'Terminal=false\nType=Application\nCategories=Network;\n'
    } | apps_sudo tee "$APPS_DESKTOP_DIR/veltrix-$id.desktop" >/dev/null \
        && apps_sudo chmod 644 "$APPS_DESKTOP_DIR/veltrix-$id.desktop" 2>/dev/null
}

# Spotify: Flatpak from Flathub. NOT pre-downloaded (see the block header);
# downloads when picked. flatpak itself is installed on demand if missing.
apps_spotify() {
    apps_sudo pacman -S --noconfirm --needed flatpak || return 1
    apps_sudo flatpak remote-add --if-not-exists --system flathub \
        https://flathub.org/repo/flathub.flatpakrepo || return 1
    apps_sudo flatpak install -y --system flathub com.spotify.Client || return 1
}

# FreeTube: Flatpak from Flathub (io.freetubeapp.FreeTube, AGPLv3). Same
# shape as Spotify — NOT pre-downloaded, downloads when picked. A
# privacy-focused YouTube client: no ads, no tracking, no account, no
# recommendation feed. It still plays YouTube videos; it just does it
# without the parts that push content at the user. Upstream notes it is
# still in beta, so a failed install is recorded like any other app and
# never blocks the install.
apps_freetube() {
    apps_sudo pacman -S --noconfirm --needed flatpak || return 1
    apps_sudo flatpak remote-add --if-not-exists --system flathub \
        https://flathub.org/repo/flathub.flatpakrepo || return 1
    apps_sudo flatpak install -y --system flathub io.freetubeapp.FreeTube || return 1
}

# Run a command as the unprivileged user. install.sh normally runs as the
# user and sudo's per command, but when it was itself invoked via sudo the
# top of the file defines run_user for exactly this — and the test harness
# sources only the apps block, where run_user does not exist. So prefer
# run_user when it is defined, run directly otherwise.
apps_run_user() {
    if command -v run_user >/dev/null 2>&1; then run_user "$@"; else "$@"; fi
}

# Vile: Adnan's own privacy browser (v48 source, vendored in vile/).
# Built from source with CMake + Qt6 WebEngine — on demand only when
# picked, never pre-downloaded, never by default. The build deps (cmake,
# sqlite, qt6-base, qt6-webengine) are installed here; base-devel (gcc,
# make) is already an installer dependency. Qt WebEngine is the big
# download (~100 MB+), and the build itself takes a few minutes on the
# Dell — the prompt says so, and the build log is kept on failure.
# Only the vile-qt target is built (never vile-demo). Installed: the
# binary to $VILE_BIN_DIR/vile, its icon to $VILE_ICON_DIR/vile.png,
# and a vile.desktop file (upstream ships none). A failed step returns
# 1 — install_extra_apps records it and never blocks the install.
apps_vile() {
    local src="$REPO_DIR/vile"
    if [ ! -d "$src" ]; then
        echo "  [WARN] Vile source not found at $src — cannot build." >&2
        return 1
    fi
    apps_sudo pacman -S --noconfirm --needed cmake sqlite qt6-base qt6-webengine || return 1
    local build log
    # The build dir is created AS THE USER (apps_run_user), not by this
    # script: under `sudo ./install.sh` a plain mktemp is root-owned,
    # but cmake runs as the user — it could not write its own build dir,
    # so every Vile build failed at configure (Nov 14 sweep #2).
    build="$(apps_run_user mktemp -d /tmp/vile-build.XXXXXX)" || return 1
    log="$build/build.log"
    echo "  Building Vile from source (a few minutes — Qt WebEngine build)…"
    if ! apps_run_user cmake -S "$src" -B "$build" -DCMAKE_BUILD_TYPE=Release >"$log" 2>&1; then
        echo "  [WARN] Vile: cmake configure failed — last lines of the build log:" >&2
        tail -n 30 "$log" >&2 || true
        rm -rf "$build"
        return 1
    fi
    if ! apps_run_user cmake --build "$build" --target vile-qt -j"$(nproc)" >>"$log" 2>&1; then
        echo "  [WARN] Vile: build failed — last lines of the build log:" >&2
        tail -n 30 "$log" >&2 || true
        rm -rf "$build"
        return 1
    fi
    local bin="$build/qt/vile-qt"
    if [ ! -x "$bin" ]; then
        echo "  [WARN] Vile: build finished but $bin is missing." >&2
        rm -rf "$build"
        return 1
    fi
    apps_sudo install -Dm755 "$bin" "$VILE_BIN_DIR/vile" || { rm -rf "$build"; return 1; }
    apps_sudo install -Dm644 "$src/qt/assets/logo-256.png" "$VILE_ICON_DIR/vile.png" || { rm -rf "$build"; return 1; }
    {
        printf '[Desktop Entry]\n'
        printf 'Name=Vile\n'
        printf 'Comment=A private browser\n'
        printf 'Exec=%s/vile\n' "$VILE_BIN_DIR"
        printf 'Icon=vile\n'
        printf 'Terminal=false\nType=Application\nCategories=Network;WebBrowser;\n'
        printf 'StartupWMClass=vile\n'
    } | apps_sudo tee "$APPS_DESKTOP_DIR/vile.desktop" >/dev/null \
        && apps_sudo chmod 644 "$APPS_DESKTOP_DIR/vile.desktop" 2>/dev/null \
        || { rm -rf "$build"; return 1; }
    # Best-effort icon-cache refresh so the icon shows without a logout —
    # only for the real icon dir, never for a test-seam override.
    if [ "$VILE_ICON_DIR" = "/usr/share/icons/hicolor/256x256/apps" ]; then
        apps_sudo gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
    fi
    rm -rf "$build"
}

# Escape one string for JSON (F3): backslash and double-quote only —
# ids come from a fixed list or from the prompt's tokens, so no other
# control characters can reach here, but the escape is what keeps a
# hostile id from corrupting apps.json.
apps_json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

# Install exactly the ids in "$@" (from APPS_PICKED). Every step is guarded:
# a failed app is recorded, warned about, and never blocks the install.
# Unknown ids (F3) are marked failed, never printed as [ok]: the prompt
# only ever passes validated ids, but this function must not trust its
# arguments blindly — and the choice file is built from validated ids
# only, so a raw id containing `"` cannot corrupt apps.json.
install_extra_apps() {
    if [ "$#" -eq 0 ]; then return 0; fi
    local failed=() id ok=1 known=0 succeeded=0
    local valid_ids=()
    for id in "$@"; do
        ok=1; known=0
        # Validate against the fixed list before anything else.
        local cand
        for cand in "${APPS_IDS[@]}"; do
            if [ "$id" = "$cand" ]; then known=1; break; fi
        done
        if [ "$known" -eq 0 ]; then
            echo "  [WARN] Unknown extra app '$id' — skipping; recorded as failed." >&2
            failed+=("$id")
            continue
        fi
        valid_ids+=("$id")
        case "$id" in
            freetube)  apps_freetube || ok=0 ;;
            whatsapp)  apps_webapp whatsapp "WhatsApp" "https://web.whatsapp.com" "internet-chat" || ok=0 ;;
            telegram)  apps_pkg "telegram-desktop" || ok=0 ;;
            spotify)   apps_spotify || ok=0 ;;
            vlc)       apps_pkg "vlc" || ok=0 ;;
            libreoffice) apps_pkg "libreoffice-fresh" || ok=0 ;;
            vscode)    apps_pkg "code" || ok=0 ;;
            discord)   apps_pkg "discord" || ok=0 ;;
            gimp)      apps_pkg "gimp" || ok=0 ;;
            vile)      apps_vile || ok=0 ;;
        esac
        if [ "$ok" -eq 1 ]; then
            echo "  ${VELTRIX_C_GREEN}[ok] ${id}${VELTRIX_C_RESET}"
            succeeded=$((succeeded + 1))
            local idx=0 pkg=""
            for idx in "${!APPS_IDS[@]}"; do
                if [ "${APPS_IDS[$idx]}" = "$id" ]; then pkg="${APPS_PKGS[$idx]}"; break; fi
            done
            apps_log_version "$id" "$pkg"
        else
            failed+=("$id")
            echo "  [WARN] $id could not be installed — recorded in $APPS_CHOICE_FILE; retry it later by hand." >&2
        fi
    done
    APPS_FAILED=("${failed[@]}")
    local ids_json="" failed_json="" first=1
    for id in "${valid_ids[@]}"; do
        if [ "$first" -eq 1 ]; then first=0; else ids_json="$ids_json, "; fi
        ids_json="$ids_json\"$(apps_json_escape "$id")\""
    done
    first=1
    for id in "${failed[@]}"; do
        if [ "$first" -eq 1 ]; then first=0; else failed_json="$failed_json, "; fi
        failed_json="$failed_json\"$(apps_json_escape "$id")\""
    done
    # Guarded (F4): a failed bookkeeping write warns; the install goes on.
    apps_write_choice "$ids_json" "$failed_json" \
        || echo "  [WARN] Continuing without a recorded extra-apps result." >&2
    echo "  Installed $succeeded of ${#valid_ids[@]} extra apps."
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. System dependencies
# ─────────────────────────────────────────────────────────────────────────────
if [ "$SYNC_PACMAN" = "no" ]; then
    echo "[1/5] System dependencies — skipped (package list unchanged)."
else
    echo "[1/5] System dependencies"
    # ── The upgrade is the USER'S, and it is shown ───────────────────────────
    # This runs on a machine we do not own — PRODUCT.md, "What does NOT change" —
    # and until 2026-09-02 it simply took it over: `-Syu --needed --noconfirm` is a
    # full, UNATTENDED system upgrade nobody asked for. Measured on one machine
    # that day: 44 packages, both kernels 7.1.11 → 7.2.2, which left the running
    # kernel with no modules directory on disk until a reboot (#378).
    #
    # The project already held the opposite position one file away, and said why:
    # bin/veltrix-update's PACKAGE path drops --noconfirm on purpose because "this
    # is a FULL system upgrade, the user should see what it pulls in".
    #
    # ⚠️ Dropping the `-Syu` would be the WRONG fix and was considered first. Arch
    # does not support partial upgrades: installing against a freshly synced DB
    # without upgrading is exactly how a new library lands beside its old
    # dependants (aquamarine's soname against an installed hyprtoolkit did this).
    # So the upgrade stays and only its manner changes — it is now SHOWN, it can
    # be DECLINED, and declining STOPS the install instead of walking into the
    # very state the -Syu exists to avoid.
    #
    # Safe to make interactive: nothing calls this script unattended. Its only
    # non-human callers are veltrix-update's dev and stable paths, both of which
    # run with the user at a terminal, and CI's headless smoke does its own
    # -Syu without going through here.
    echo "  Arch does not support partial upgrades, so Veltrix's dependencies cannot"
    echo "  be installed without bringing the system up to date first. pacman will"
    echo "  show you the transaction; declining it stops the install."
    echo ""
    echo "  A full system upgrade touches everything, not just Veltrix — back up"
    echo "  anything you cannot afford to lose before it runs."
    read -r -p "  Continue with the system upgrade? [y/N] " _ans
    case "$_ans" in
        y|Y|yes|YES) ;;
        *) echo "install.sh: stopped before the upgrade — nothing was installed." >&2; exit 1 ;;
    esac
    if ! sudo pacman -Syu; then
        echo "" >&2
        echo "install.sh: the system upgrade did not complete, so nothing was installed." >&2
        echo "            Veltrix's dependencies would have landed against out-of-date" >&2
        echo "            libraries. Re-run this script once 'sudo pacman -Syu' succeeds." >&2
        exit 1
    fi
    echo ""
    echo "  Installing Veltrix's dependencies..."
    # Unquoted on purpose: word-splitting wanted. The list is derived from the
    # package's own arrays — see the top of this script.
    sudo pacman -S --needed $PACMAN_DEPS
    # Pre-download the extra apps' packages (iPad Mode, Nov 12 2026): the apps
    # question comes after §4, and the picked ones must install from the local
    # cache in seconds. Download-only — nothing is installed until picked.
    # Disclosure BEFORE it runs (F6): ~700 MB total (LibreOffice alone
    # ~400 MB), downloaded even if the user ends up picking none. The
    # prompt after §4 says so again; the README lists it too. Skipped when
    # a choice is already recorded (an update — apps_predownload says so);
    # the disclosure below is only printed when the download will run.
    if [ ! -f "$APPS_CHOICE_FILE" ]; then
        echo "  Pre-downloading the optional extra apps' packages (~700 MB —"
        echo "  LibreOffice alone is ~400 MB) so the ones you pick later install"
        echo "  in seconds. Nothing is installed here, and picking none is fine."
    fi
    apps_predownload
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Configure GObject Introspection
# ─────────────────────────────────────────────────────────────────────────────
echo "[2/5] Configuring GObject Introspection..."
sudo ldconfig
# (GI_TYPELIB_PATH in /etc/environment is applied by veltrix-setup, called in §5.)

# ─────────────────────────────────────────────────────────────────────────────
# 3. Build the Veltrix UI bundle
# ─────────────────────────────────────────────────────────────────────────────
echo "[3/5] Building Veltrix UI..."
cd "$REPO_DIR/ui/shell"
# --prefer-offline: use the npm cache first (an update re-checks the same
# lockfile, so the packages are already cached — no network round-trips).
# --no-audit/--no-fund: skip the audit + funding network calls, which buy
# nothing on every update. (2026-11-14, fast updates.)
npm install --prefer-offline --no-audit --no-fund
# The kit's sheet first: the shell, greeter and lock load it at runtime, in the
# same provider as their own (tech-debt #108 phase 2, ui/lib/veltrix-kit/platform/kit-css.ts).
npx sass --no-charset ../lib/veltrix-kit/styles/kit.scss ../lib/veltrix-kit/kit.css && sed -i '/@charset/d' ../lib/veltrix-kit/kit.css
npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css
# The kit's modules (#108 phase 3): the shell, greeter and lock load them at
# runtime from /usr/share/veltrix-kit/js instead of carrying a copy each.
node "$REPO_DIR/scripts/bundle.mjs" kit "$REPO_DIR/ui/lib/veltrix-kit/build/js"

# Dev mode: generate the git-ignored @girs/ GI typings so typecheck + editor
# IntelliSense work straight after a clone — no manual step. Only if missing
# (regenerable, ~58MB); system mode doesn't typecheck so it's skipped.
if [ "$MODE" = "dev" ]; then
    echo "  Generating @girs/ TypeScript typings..."
    [ -d @girs ] || "$REPO_DIR/scripts/gen-types.sh" .
fi

if [ "$MODE" != "dev" ]; then
    echo "  Bundling shell UI..."
    mkdir -p build
    "$REPO_DIR/scripts/bundle.sh" app.ts build/veltrix --native-host=veltrix-shell --kit-external=/usr/share/veltrix-kit/js
    echo "  [OK] Bundle: $REPO_DIR/ui/shell/build/veltrix"
fi

echo "  Building Settings..."
cd "$REPO_DIR/ui/shell"
npx sass --no-charset ../settings/style.scss ../settings/style.css
cd "$REPO_DIR/ui/settings"
mkdir -p build
"$REPO_DIR/scripts/bundle.sh" app.ts build/veltrix-settings --native-host=veltrix-settings --kit-external=/usr/share/veltrix-kit/js
# What the native Settings reads besides Config1 (toolkit/PHASE1.md D4), as the PKGBUILD
# exports it: pages, strings and tokens with their format version.
node --experimental-strip-types "$REPO_DIR/scripts/export-settings-data.mjs" "$REPO_DIR/build/settings-data"
SASS="$REPO_DIR/ui/shell/node_modules/.bin/sass" \
    node --experimental-strip-types "$REPO_DIR/scripts/export-tokens.mjs" "$REPO_DIR/build/settings-data"

echo "  Building greeter..."
# Use the shell bundle's sass installation for SCSS compilation
cd "$REPO_DIR/ui/shell"
npx sass --no-charset ../greeter/style.scss ../greeter/style.css && sed -i '/@charset/d' ../greeter/style.css
cd "$REPO_DIR/ui/greeter"
mkdir -p build
"$REPO_DIR/scripts/bundle.sh" app.ts build/veltrix-greeter --native-host=veltrix-greeter --kit-external=/usr/share/veltrix-kit/js
echo "  [OK] Greeter bundle: $REPO_DIR/ui/greeter/build/veltrix-greeter"

echo "  Building lockscreen..."
cd "$REPO_DIR/ui/lockscreen"
mkdir -p build
"$REPO_DIR/scripts/bundle.sh" app.ts build/veltrix-lock --native-host=veltrix-lock --kit-external=/usr/share/veltrix-kit/js
echo "  [OK] Lockscreen bundle: $REPO_DIR/ui/lockscreen/build/veltrix-lock"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Install system files
# ─────────────────────────────────────────────────────────────────────────────
echo "[4/5] Installing system files..."

# ── Timestamped backup before anything destructive ─────────────────────────
# §4 removes the veltrix packages and then rm -rf's /usr/share/veltrix subtrees
# wholesale. If the copy below fails halfway, the previous working desktop is
# gone with nothing to roll back to. Snapshot both trees first (bundles + assets
# only, no user data) under /var/tmp, timestamped; the path is printed so a bad
# install can be undone with one `cp -a`.
_backup_dir="/var/tmp/veltrix-backup-$(date +%Y%m%d-%H%M%S)"
_backup_made=no
for _tree in /usr/share/veltrix /usr/share/veltrix-kit; do
    if [ -e "$_tree" ]; then
        sudo mkdir -p "$_backup_dir" && sudo cp -a "$_tree" "$_backup_dir/" && _backup_made=yes
    fi
done
[ "$_backup_made" = yes ] && echo "  Backup of the previous install → $_backup_dir"

# ── Prune older backups: one snapshot per install, not one per update ───────
# Every install snapshots both trees (~tens of MB), and nothing ever removed
# them — each update left another full copy in /var/tmp forever, so updating
# duplicated the whole desktop on disk once per version. An update must leave
# exactly one live install plus a way back, not a growing pile: keep the two
# newest backups (the one just made, plus the previous one, so a bad update
# can still be undone across one more) and delete the rest. Best-effort on
# purpose: a prune failure must not fail an otherwise good install.
for _old_backup in $(sudo ls -dt /var/tmp/veltrix-backup-* 2>/dev/null | tail -n +3 || true); do
    sudo rm -rf "$_old_backup" && echo "  Pruned old backup: $_old_backup" || echo "  [WARN] could not prune old backup $_old_backup" >&2
done

# ── Dev installs copy source files straight into /usr ────────────────────────
# If the desktop PACKAGE is installed, pacman owns those paths and the next
# -Syu would clobber the dev copies — remove it first (files re-copied below).
#
# ⚠️ EVERY copy below sets its mode EXPLICITLY — `install -Dm755` for
# executables, `install -Dm644` for data, `cp -r` + `fix_tree_perms` for whole
# trees. A plain `sudo cp` preserves the repo's working-tree modes (data 660,
# scripts 770) on root-owned files, which left /usr/bin/veltrix-* unreadable
# and the systemd units invisible on the Dell (2026-11-13) — a desktop that
# silently never started, fixed only by hand-running chmod 755/644. Never
# reintroduce a bare `sudo cp` of a system file; scripts/verify-installed-perms.sh
# (run at the end of §4) fails the install if any mode regresses.
#
# ⚠️ BOTH names, and this is not belt-and-braces. The package was renamed
# `veltrix` → `veltrix` on 2026-08-30, and a machine that has not yet taken
# the migrating upgrade still carries the old one. `pacman -Qq veltrix` on such a
# machine does not error in a way anybody notices — it just says "not installed",
# so the removal would be SKIPPED and the next -Syu would quietly overwrite the
# dev copies with packaged files. Query by name; `provides` does not help here.
for _pkg in veltrix veltrix; do
    if pacman -Qq "$_pkg" >/dev/null 2>&1; then
        echo "  Removing the $_pkg package (dev installs manage /usr files directly)..."
        sudo pacman -R --noconfirm "$_pkg"
    fi
done

# Version file
sudo mkdir -p /usr/share/veltrix
sudo install -Dm644 "$REPO_DIR/VERSION" /usr/share/veltrix/VERSION

# Hyprland config (dev: symlink hyprland.lua to the repo so edits apply live;
# system installs get a real copy from the package instead)
sudo mkdir -p /usr/share/veltrix/config/hypr
sudo ln -sf "$REPO_DIR/config/hypr/hyprland.lua" /usr/share/veltrix/config/hypr/hyprland.lua
sudo install -Dm644 "$REPO_DIR/config/hypr/hypridle.conf" /usr/share/veltrix/config/hypr/hypridle.conf

# Setup payloads consumed by veltrix-setup (greetd templates, per-user seeds) —
# the same layout the veltrix pacman package ships, so veltrix-setup reads ONE
# place regardless of how Veltrix was installed. defaults/wallpaper is excluded:
# the wallpaper already ships at its canonical /usr/share/veltrix/wallpaper.jpg.
# sync_tree (not rm -rf + cp -r) so an update only copies the files that
# changed. The wallpaper dir is excluded from the sync and removed after —
# it is installed separately below, and must not linger in defaults.
sync_tree "$REPO_DIR/defaults" /usr/share/veltrix/defaults --exclude 'wallpaper/'
sudo rm -rf /usr/share/veltrix/defaults/wallpaper
sync_tree "$REPO_DIR/config/greetd" /usr/share/veltrix/config/greetd

# Assistant skills: markdown playbooks bin/veltrix-agent loads on demand (its
# load_skill tool). Replaced wholesale rather than merged, so a skill deleted
# upstream actually disappears. A --dev install reads the repo's skills/ directly
# (the .dev marker wins in skillsDir()), so this copy is what non-dev installs get.
sync_tree "$REPO_DIR/skills" /usr/share/veltrix/skills

# Default wallpapers (desktop, greeter, and bundled offline collection).
if [ -d "$REPO_DIR/defaults/wallpaper" ]; then
    # Replaced whole, like the trees above: a wallpaper the repo drops must
    # not linger in the installed collection.
    sudo rm -rf /usr/share/veltrix/wallpapers
    sudo mkdir -p /usr/share/veltrix/wallpapers
    sudo install -m644 "$REPO_DIR/defaults/wallpaper/"*.jpg /usr/share/veltrix/wallpapers/ 2>/dev/null || true
    if [ -f "$REPO_DIR/defaults/wallpaper/wallpaper.jpg" ]; then
        sudo install -Dm644 "$REPO_DIR/defaults/wallpaper/wallpaper.jpg" /usr/share/veltrix/wallpaper.jpg
    fi
    if [ -f "$REPO_DIR/defaults/wallpaper/wallpaper-greeter.jpg" ]; then
        sudo install -Dm644 "$REPO_DIR/defaults/wallpaper/wallpaper-greeter.jpg" /usr/share/veltrix/wallpaper-greeter.jpg
    fi
    sudo rm -f /usr/share/veltrix/wallpaper.png
fi

# Shell UI bundle + style
# Migration: drop the pre-rename system tree (ui/ags-v3 → ui/shell, 2026-06)
sudo rm -rf /usr/share/veltrix/ui/ags-v3
sudo mkdir -p /usr/share/veltrix/ui/settings/build
sudo install -Dm755 "$REPO_DIR/ui/settings/build/veltrix-settings" /usr/share/veltrix/ui/settings/build/
sudo install -Dm644 "$REPO_DIR/ui/settings/style.css" /usr/share/veltrix/ui/settings/
# Replaced whole, so a file the export no longer writes does not linger.
sync_tree "$REPO_DIR/build/settings-data" /usr/share/veltrix/settings-data
sudo mkdir -p /usr/share/veltrix/ui/shell/build
if [ "$MODE" != "dev" ]; then
    sudo install -Dm755 "$REPO_DIR/ui/shell/build/veltrix" /usr/share/veltrix/ui/shell/build/
fi
sudo install -Dm644 "$REPO_DIR/ui/shell/style.css" /usr/share/veltrix/ui/shell/
# Static assets (icons, svgs) — resolved via SHELL_ROOT in prod (core/Paths.ts).
sync_tree "$REPO_DIR/ui/shell/assets" /usr/share/veltrix/ui/shell/assets

# The Veltrix icon theme (#587) lives inside assets/ — the only copy of those
# drawings. /usr/share/icons/veltrix is a symlink to it, so the theme sits where
# themes are found (Settings lists it; theme authors start from it) without a
# second copy that could drift. The migration line drops the old generated
# veltrix-symbolic theme, which was that second copy.
sudo rm -rf /usr/share/icons/veltrix-symbolic
sudo rm -rf /usr/share/icons/veltrix
sudo ln -s /usr/share/veltrix/ui/shell/assets/icons/veltrix /usr/share/icons/veltrix

# The kit's compiled sheet, where every app that wears the kit finds it when it
# is not running from a checkout. Its own directory, not under veltrix/: it is the
# kit package's file (tech-debt #108), and the greeter and lock always read it here.
sudo install -Dm644 "$REPO_DIR/ui/lib/veltrix-kit/kit.css" /usr/share/veltrix-kit/kit.css
# ...and its modules, which the greeter and lock (and the shell outside dev mode)
# import at runtime. Replaced whole: chunk names are content hashes, so copying
# over the old directory would keep chunks nothing imports any more.
sync_tree "$REPO_DIR/ui/lib/veltrix-kit/build/js" /usr/share/veltrix-kit/js
# The rest of what the `veltrix-kit` package ships (#108 phase 4): the API version
# and the sources an app outside this repo typechecks against. Same layout as the
# package's, so an app author's tsconfig works on either kind of install.
sudo install -Dm644 "$REPO_DIR/ui/lib/veltrix-kit/package.json" /usr/share/veltrix-kit/package.json
sudo rm -rf /usr/share/veltrix-kit/src
(cd "$REPO_DIR/ui/lib/veltrix-kit" && find . -name '*.ts' -not -path './build/*' -print0 |
    sudo xargs -0 -I{} install -Dm644 {} /usr/share/veltrix-kit/src/{})
fix_tree_perms /usr/share/veltrix-kit

# Greeter bundle + style
sudo mkdir -p /usr/share/veltrix/ui/greeter/build
sudo install -Dm755 "$REPO_DIR/ui/greeter/build/veltrix-greeter" /usr/share/veltrix/ui/greeter/build/
sudo install -Dm644 "$REPO_DIR/ui/greeter/style.css" /usr/share/veltrix/ui/greeter/

# Veltrix installs NO GTK theme (commandment 11, tech-debt #107). Our processes ask
# for `Empty`, which GTK resolves out of its own gresource — see ui/lib/veltrix-kit/platform/gtk-theme.ts
# for why a theme of ours on disk was worse than none. These two are the artefacts
# that used to be installed here; remove them so a machine upgraded from an older
# checkout stops offering them in every theme chooser on the system.
sudo rm -rf /usr/share/themes/veltrix
sudo rm -rf /usr/share/themes/crystal-shell

# Lockscreen bundle (shares greeter's style.css)
sudo mkdir -p /usr/share/veltrix/ui/lockscreen/build
sudo install -Dm755 "$REPO_DIR/ui/lockscreen/build/veltrix-lock" /usr/share/veltrix/ui/lockscreen/build/

# Session wrapper scripts — every one installed 755 (the old single `chmod +x`
# line listed only 30 of these and never covered veltrix-power-key,
# veltrix-kbd-light or veltrix-media-key at all; install -D sets the mode per
# file, so a binary added here cannot silently ship unreadable again).
sudo install -Dm755 "$REPO_DIR/bin/veltrix"     /usr/bin/veltrix
sudo install -Dm755 "$REPO_DIR/bin/veltrix-ui"  /usr/bin/veltrix-ui
sudo install -Dm755 "$REPO_DIR/bin/veltrix-settings" /usr/bin/veltrix-settings
sudo install -Dm755 "$REPO_DIR/bin/veltrix-greeter"   /usr/bin/veltrix-greeter
sudo install -Dm755 "$REPO_DIR/bin/veltrix-lock"      /usr/bin/veltrix-lock
sudo install -Dm755 "$REPO_DIR/bin/veltrix-before-sleep" /usr/bin/veltrix-before-sleep
sudo install -Dm755 "$REPO_DIR/bin/veltrix-after-sleep"  /usr/bin/veltrix-after-sleep
sudo install -Dm755 "$REPO_DIR/bin/veltrix-display-brightness" /usr/bin/veltrix-display-brightness
sudo install -Dm755 "$REPO_DIR/bin/veltrix-power-key" /usr/bin/veltrix-power-key
sudo install -Dm755 "$REPO_DIR/bin/veltrix-kbd-light" /usr/bin/veltrix-kbd-light
sudo install -Dm755 "$REPO_DIR/bin/veltrix-media-key" /usr/bin/veltrix-media-key
sudo install -Dm755 "$REPO_DIR/bin/veltrix-doctor" /usr/bin/veltrix-doctor
sudo install -Dm755 "$REPO_DIR/bin/veltrix-bug-report" /usr/bin/veltrix-bug-report
sudo install -Dm755 "$REPO_DIR/bin/veltrix-portal"    /usr/bin/veltrix-portal
sudo install -Dm755 "$REPO_DIR/bin/veltrix-share-chooser" /usr/bin/veltrix-share-chooser
sudo install -Dm755 "$REPO_DIR/bin/veltrix-mcp" /usr/bin/veltrix-mcp
sudo install -Dm755 "$REPO_DIR/bin/veltrix-agent" /usr/bin/veltrix-agent
sudo install -Dm755 "$REPO_DIR/bin/veltrix-a11y"      /usr/bin/veltrix-a11y
sudo install -Dm755 "$REPO_DIR/bin/veltrix-act"       /usr/bin/veltrix-act
sudo install -Dm755 "$REPO_DIR/bin/veltrix-type"      /usr/bin/veltrix-type
sudo install -Dm755 "$REPO_DIR/bin/veltrix-click"     /usr/bin/veltrix-click
sudo install -Dm755 "$REPO_DIR/bin/veltrix-wm"        /usr/bin/veltrix-wm
sudo install -Dm755 "$REPO_DIR/bin/veltrix-hook"      /usr/bin/veltrix-hook
sudo install -Dm755 "$REPO_DIR/bin/veltrix-update" /usr/bin/veltrix-update
# Background updater (1.0): the unprivileged downloader the shell spawns,
# and the privileged apply helper pkexec runs as root. No systemd unit for
# either: the shell spawns the downloader, and pkexec spawns the helper on
# demand — a unit nothing starts is dead weight.
sudo install -Dm755 "$REPO_DIR/bin/veltrix-update-download" /usr/bin/veltrix-update-download
sudo install -Dm755 "$REPO_DIR/bin/veltrix-update-helper" /usr/bin/veltrix-update-helper
sudo install -Dm755 "$REPO_DIR/bin/veltrix-setup" /usr/bin/veltrix-setup
sudo install -Dm755 "$REPO_DIR/bin/veltrix-greeter-session" /usr/bin/veltrix-greeter-session
sudo install -Dm755 "$REPO_DIR/bin/veltrix-migrate" /usr/bin/veltrix-migrate
sudo install -Dm755 "$REPO_DIR/bin/veltrix-language" /usr/bin/veltrix-language
sudo install -Dm755 "$REPO_DIR/bin/veltrix-hijri-date" /usr/bin/veltrix-hijri-date
sudo install -Dm755 "$REPO_DIR/bin/veltrix-prayer-times" /usr/bin/veltrix-prayer-times
sudo install -Dm755 "$REPO_DIR/bin/veltrix-prayer-lock" /usr/bin/veltrix-prayer-lock
sudo install -Dm755 "$REPO_DIR/bin/veltrix-weather" /usr/bin/veltrix-weather
sudo install -Dm755 "$REPO_DIR/bin/veltrix-content-safety" /usr/bin/veltrix-content-safety
sudo install -Dm755 "$REPO_DIR/bin/veltrix-anonymity" /usr/bin/veltrix-anonymity
sudo install -Dm755 "$REPO_DIR/bin/veltrix-halal-audio" /usr/bin/veltrix-halal-audio
# The migration units, at the same path the package ships them to, so
# veltrix-migrate reads ONE location in both modes. Sourced, never executed —
# 644 is the right mode (the old plain `cp` left them 660 root-owned).
sudo rm -rf /usr/share/veltrix/migrations
sudo mkdir -p /usr/share/veltrix/migrations
sudo install -m644 -t /usr/share/veltrix/migrations/ "$REPO_DIR"/migrations/*.sh
# Content Safety's blocklist, at the same path the package ships it to.
sudo mkdir -p /usr/share/veltrix/content-safety
sudo install -Dm644 "$REPO_DIR/defaults/content-safety/blocklist.txt" /usr/share/veltrix/content-safety/blocklist.txt
# Anonymity's Tor drop-in, at the same path the package ships it to.
# The helper copies it to /etc/tor/torrc.d/ when Tor mode is turned on
# and removes it again when it is turned off; the main torrc is never
# edited. Tor mode itself is OFF by default — nothing is applied here.
sudo mkdir -p /usr/share/veltrix/anonymity
sudo install -Dm644 "$REPO_DIR/defaults/anonymity/torrc-veltrix.conf" /usr/share/veltrix/anonymity/torrc-veltrix.conf
# VoiceOnly (Adnan's vocal-only tool) + the word-scan module (parent's),
# vendored verbatim in fork/voiceonly/ — at the same path the package ships
# them to. The helper imports voiceonly.py and invokes wordscan.py from here.
# Replaced whole, like the trees above: a file the repo drops (or a stale
# static asset) must not linger in the installed tree.
sudo rm -rf /usr/share/veltrix/voiceonly
sudo mkdir -p /usr/share/veltrix/voiceonly/static
sudo install -Dm644 "$REPO_DIR/voiceonly/voiceonly.py" /usr/share/veltrix/voiceonly/voiceonly.py
sudo install -Dm644 "$REPO_DIR/voiceonly/wordscan.py" /usr/share/veltrix/voiceonly/wordscan.py
sudo install -Dm644 "$REPO_DIR/voiceonly/blacklist.txt" /usr/share/veltrix/voiceonly/blacklist.txt
sudo install -Dm755 "$REPO_DIR/voiceonly/run.sh" /usr/share/veltrix/voiceonly/run.sh
sudo install -m644 -t /usr/share/veltrix/voiceonly/static/ "$REPO_DIR/voiceonly/static/"*

# Content Safety, default ON (Adnan, 2026-11-12): apply the system layers
# NOW, at install time, so a fresh install is actually protected instead of
# showing the toggle ON while nothing is blocked (M2, fix pass). Best-effort
# on purpose: if the apply fails here, the shell's startup reconcile offers
# one-tap "Apply protection" at first login instead of failing the install.
# (S1, fix pass #3) Same guard as post_install (N5): a state file or a
# hosts backup means a previous on/off cycle already happened, and
# re-applying would silently re-enable protection a user deliberately
# turned off. Skip silently, like post_install — the dev path is not exempt
# from the principle just because re-running install.sh re-applies other
# things.
if [ ! -e /etc/veltrix/content-safety/state.json ] && [ ! -e /etc/hosts.veltrix-backup ]; then
    sudo "$REPO_DIR/bin/veltrix-content-safety" on \
        && echo "  Content Safety is on by default — CleanBrowsing DNS + hosts block; turn it off in Settings → Safety." \
        || echo "  [WARN] Content Safety could not be applied at install time — it will be offered at first login." >&2
fi

# ── Hijri date + prayer times data (Phase 1 / Phase 6): `hijridate` and
# `al-falak` have no Arch packages, and Arch blocks `pip install --user`
# (PEP 668, externally-managed-environment) — so the data lives in a
# per-user venv the helpers re-exec into when the system python lacks them
# (see bin/veltrix-hijri-date, bin/veltrix-prayer-times). Pinned AND
# hash-pinned: defaults/python-venv-requirements.txt (hijridate 2.6.0,
# al-falak 1.2.1 — the bar's anchors were verified against hijridate 2.6.0;
# the prayer times against al-falak 1.2.1, ICSWO + searchtruth + timesprayer,
# max deviation 2 min after the mosque calibration — see
# docs/prayer-lock-fix-report-1.md). bin/veltrix-setup owns venv creation for
# packaged installs (fix pass #1, code #11); this block is the dev path and
# keeps the same file, so the two never drift. Created as the USER
# (run_user), never root — and fail-soft: without network the install still
# succeeds and the bar shows the Gregorian clock only until the venv is
# created (see docs/dell-validation-phase1.md), and the prayer lock simply
# never fires until al-falak is installed.
if run_user python3 -m venv "$REAL_HOME/.local/share/veltrix/venv" 2>/dev/null; then
    # FAST UPDATE (2026-11-14): pip install --require-hashes re-resolves
    # and re-verifies every pinned package on every update, even when
    # nothing changed. Record the requirements file's hash in the venv;
    # when it matches AND the venv already imports the modules, skip the
    # pip install entirely. A changed requirements file, a missing hash
    # record, or a venv that cannot import the modules all fall through
    # to the install below — so a broken or outdated venv self-heals.
    _venv_dir="$REAL_HOME/.local/share/veltrix/venv"
    _venv_hash_file="$_venv_dir/.requirements.sha256"
    _venv_skip=0
    if [ -f "$REPO_DIR/defaults/python-venv-requirements.txt" ] && [ -f "$_venv_hash_file" ]; then
        _req_hash="$(sha256sum "$REPO_DIR/defaults/python-venv-requirements.txt" | awk '{print $1}')"
        if [ "$_req_hash" = "$(run_user cat "$_venv_hash_file" 2>/dev/null || true)" ] \
            && run_user "$_venv_dir/bin/python" -c "import hijridate, alfalak" 2>/dev/null; then
            _venv_skip=1
            echo "  Python venv already has hijridate/al-falak (requirements unchanged) — skipping pip install."
        fi
    fi
    if [ "$_venv_skip" = 0 ]; then
    if [ -f "$REPO_DIR/defaults/python-venv-requirements.txt" ]; then
        if run_user "$REAL_HOME/.local/share/veltrix/venv/bin/pip" install --quiet --require-hashes -r "$REPO_DIR/defaults/python-venv-requirements.txt"; then
            printf '%s\n' "$(sha256sum "$REPO_DIR/defaults/python-venv-requirements.txt" | awk '{print $1}')" \
                | run_user tee "$_venv_hash_file" >/dev/null 2>&1 || true
        else
            echo "WARNING: hijridate/al-falak did not install — the Hijri date will be absent and the prayer lock will not fire until the venv is created (docs/dell-validation-phase1.md, docs/prayer-lock-report.md)." >&2
        fi
    else
        run_user "$REAL_HOME/.local/share/veltrix/venv/bin/pip" install --quiet "hijridate==2.6.0" "al-falak==1.2.1" \
            || echo "WARNING: hijridate/al-falak did not install — the Hijri date will be absent and the prayer lock will not fire until the venv is created (docs/dell-validation-phase1.md, docs/prayer-lock-report.md)." >&2
    fi
    fi
else
    echo "WARNING: could not create ~/.local/share/veltrix/venv — the Hijri date will be absent until the venv is created (docs/dell-validation-phase1.md)." >&2
fi

# ── Skip the native C builds when their inputs are unchanged ─────────────────
# (2026-11-14, fast updates.) The four builds below (veltrix-host,
# veltrix-input, libveltrix-wl, libveltrix-auth) recompile from scratch on
# every install because they build into a fresh mktemp dir. Their inputs
# are a handful of C files + build scripts + the toolchain, so hash them
# all into one stamp; when the stamp matches the last successful build
# AND every expected output is already installed, skip all four. Any
# source change, toolchain change, or missing output rebuilds — the stamp
# is only a cache key, never a promise, so a stale or wrong stamp costs a
# rebuild, never a broken install. The stamp covers the pam file too
# (config/pam/veltrix-lock is installed by the auth block, not built).
_c_stamp_file="/usr/share/veltrix/.c-sources.sha256"
_c_vp_xml="/usr/share/wlr-protocols/unstable/wlr-virtual-pointer-unstable-v1.xml"
_c_stamp="$(
    {
        cc --version 2>/dev/null | head -1
        wayland-scanner --version 2>/dev/null || true
        g-ir-scanner --version 2>/dev/null || true
        pkg-config --modversion wayland-client 2>/dev/null || true
        ( cd "$REPO_DIR" && find lib/veltrix-host lib/veltrix-wl lib/veltrix-auth -type f -not -path '*/build/*' -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum )
        sha256sum "$REPO_DIR/bin/veltrix-input.c" "$REPO_DIR/config/pam/veltrix-lock" "$REPO_DIR/config/polkit/org.veltrix.content-safety.policy" "$_c_vp_xml" 2>/dev/null
    } | sha256sum | awk '{print $1}'
)"
_c_skip=0
_c_missing=""
for _c_out in /usr/bin/veltrix-input \
    /usr/lib/libveltrix-wl.so.0.0.0 /usr/lib/girepository-1.0/VeltrixWl-1.0.typelib /usr/share/gir-1.0/VeltrixWl-1.0.gir \
    /usr/lib/libveltrix-auth.so.0.0.0 /usr/lib/girepository-1.0/VeltrixAuth-1.0.typelib /usr/share/gir-1.0/VeltrixAuth-1.0.gir \
    /etc/pam.d/veltrix-lock; do
    [ -e "$_c_out" ] || _c_missing="$_c_missing $_c_out"
done
if [ -f "$REPO_DIR/lib/veltrix-host/hosts" ]; then
    while IFS= read -r _c_host; do
        # The hosts file carries comment lines (# ...) and blank lines —
        # only a veltrix-* token is a host name. (Without this, the comments
        # become bogus "missing" outputs and the skip never fires.)
        case "$_c_host" in
            veltrix-*) ;;
            *) continue ;;
        esac
        [ "$_c_host" = "veltrix-installer" ] && continue
        [ -x "/usr/lib/veltrix/$_c_host" ] || _c_missing="$_c_missing /usr/lib/veltrix/$_c_host"
    done < "$REPO_DIR/lib/veltrix-host/hosts"
fi
if [ -f "$_c_stamp_file" ] && [ "$_c_stamp" = "$(cat "$_c_stamp_file" 2>/dev/null || true)" ] && [ -z "$_c_missing" ]; then
    _c_skip=1
    echo "  Native C libraries unchanged (sources + toolchain match the last build) — skipping the rebuild."
elif [ -n "$_c_missing" ]; then
    echo "  Native C libraries will rebuild (missing output(s):${_c_missing})."
fi

# The private runners embed libgjs and keep each program's executable identity
# (lib/veltrix-host/hosts). The installer's belongs to its own package, not here.
if [ "$_c_skip" = 0 ]; then
HOST_BUILD="$(mktemp -d)"
"$REPO_DIR/lib/veltrix-host/build.sh" "$HOST_BUILD"
for host in "$HOST_BUILD"/veltrix-*; do
    [ "${host##*/}" = veltrix-installer ] && continue
    sudo install -Dm755 "$host" "/usr/lib/veltrix/${host##*/}"
done
rm -rf "$HOST_BUILD"
fi
# Remove hosts this tree no longer builds: a renamed or deleted host would
# otherwise linger in /usr/lib/veltrix forever. The hosts file is the single
# source of truth for the names (lib/veltrix-host/hosts — "add a name HERE
# only"); veltrix-installer is IN it, so the installer package's copy is
# never touched here. Guarded on the file existing: without it, the grep
# would match nothing and every host would look orphaned.
if [ -f "$REPO_DIR/lib/veltrix-host/hosts" ]; then
    for _host in /usr/lib/veltrix/veltrix-*; do
        [ -e "$_host" ] || continue
        if ! grep -qx "${_host#/usr/lib/veltrix/}" "$REPO_DIR/lib/veltrix-host/hosts" 2>/dev/null; then
            echo "  Removing orphaned host ${_host#/usr/lib/veltrix/} (no longer built)..."
            sudo rm -f "$_host" || echo "  [WARN] could not remove orphaned host $_host" >&2
        fi
    done
fi

# The native veltrix-ipc client is built with sessiond below. Its default TS
# Request(as) compatibility route stays unchanged; Rust sessions opt in explicitly.

# Compile the synthetic-pointer backend (veltrix-input): a tiny zwlr_virtual_pointer_v1
# Wayland client. wayland-scanner generates the protocol glue from wlr-protocols, then cc
# links it against libwayland-client. No new build system — the toolchain is already a dep.
if [ "$_c_skip" = 0 ]; then
VP_XML=/usr/share/wlr-protocols/unstable/wlr-virtual-pointer-unstable-v1.xml
VP_BUILD="$(mktemp -d)"
wayland-scanner client-header "$VP_XML" "$VP_BUILD/wlr-virtual-pointer-unstable-v1-client-protocol.h"
wayland-scanner private-code  "$VP_XML" "$VP_BUILD/wlr-virtual-pointer-unstable-v1-protocol.c"
cc -O2 "$REPO_DIR/bin/veltrix-input.c" "$VP_BUILD/wlr-virtual-pointer-unstable-v1-protocol.c" \
    -I"$VP_BUILD" $(pkg-config --cflags --libs wayland-client) -o "$VP_BUILD/veltrix-input"
sudo install -m755 "$VP_BUILD/veltrix-input" /usr/bin/veltrix-input
rm -rf "$VP_BUILD"
fi

# libveltrix-wl: the Wayland shim GJS cannot do without (window capture for real
# thumbnails, hyprland-surface set_visible_region for the layer-blur cost, and
# hyprland-focus-grab-v1 — which is MANDATORY since 2026-08-05, not an
# enhancement: the full-screen catcher buttons that used to fake "click outside
# closes" are gone, so without this library nothing dismisses. Hence the symbol
# check after the install: a tree that builds an older shim must fail HERE, not
# with a silent desktop.) Built
# the same way as veltrix-input — no build system, just cc + wayland-scanner —
# plus g-ir-scanner so `import VeltrixWl from "gi://VeltrixWl"` resolves.
#
# The typelib goes to the DEFAULT girepository path, so nothing has to set
# GI_TYPELIB_PATH: the shell, the greeter and the lockscreen all find it.
if [ "$_c_skip" = 0 ]; then
WL_BUILD="$(mktemp -d)"
"$REPO_DIR/lib/veltrix-wl/build.sh" "$WL_BUILD" >/dev/null
sudo install -Dm755 "$WL_BUILD/libveltrix-wl.so.0.0.0" /usr/lib/libveltrix-wl.so.0.0.0
sudo ln -sf libveltrix-wl.so.0.0.0 /usr/lib/libveltrix-wl.so.0
sudo ln -sf libveltrix-wl.so.0    /usr/lib/libveltrix-wl.so
sudo install -Dm644 "$WL_BUILD/VeltrixWl-1.0.typelib" \
    /usr/lib/girepository-1.0/VeltrixWl-1.0.typelib
sudo install -Dm644 "$WL_BUILD/VeltrixWl-1.0.gir" \
    /usr/share/gir-1.0/VeltrixWl-1.0.gir
sudo ldconfig
# The shim and the shell ship together but are separate artefacts, so "built from
# an older tree" is a real state. Assert the API the shell now REQUIRES.
if ! grep -q "focus_grab_acquire" "$WL_BUILD/VeltrixWl-1.0.gir"; then
    echo "FATAL: libveltrix-wl built without focus_grab_* — outside-click dismissal would be dead." >&2
    exit 1
fi
rm -rf "$WL_BUILD"
fi

# libveltrix-auth: PAM authentication for the lockscreen
if [ "$_c_skip" = 0 ]; then
AUTH_BUILD="$(mktemp -d)"
"$REPO_DIR/lib/veltrix-auth/build.sh" "$AUTH_BUILD" >/dev/null
sudo install -Dm755 "$AUTH_BUILD/libveltrix-auth.so.0.0.0" /usr/lib/libveltrix-auth.so.0.0.0
sudo ln -sf libveltrix-auth.so.0.0.0 /usr/lib/libveltrix-auth.so.0
sudo ln -sf libveltrix-auth.so.0    /usr/lib/libveltrix-auth.so
sudo install -Dm644 "$AUTH_BUILD/VeltrixAuth-1.0.typelib" \
    /usr/lib/girepository-1.0/VeltrixAuth-1.0.typelib
sudo install -Dm644 "$AUTH_BUILD/VeltrixAuth-1.0.gir" \
    /usr/share/gir-1.0/VeltrixAuth-1.0.gir
# ⚠️ NEVER clobber an existing one. This file is in the package's `backup=()`
# precisely because it is where someone adds fprintd or a hardware key to the
# unlock stack — a promise the pacman path keeps and this one used to break on
# every re-run. Same three cases pacman has: absent → install; identical →
# nothing; changed → keep theirs, drop ours beside it, say so.
if [ ! -f /etc/pam.d/veltrix-lock ]; then
    sudo install -Dm644 "$REPO_DIR/config/pam/veltrix-lock" /etc/pam.d/veltrix-lock
elif ! cmp -s "$REPO_DIR/config/pam/veltrix-lock" /etc/pam.d/veltrix-lock; then
    sudo install -Dm644 "$REPO_DIR/config/pam/veltrix-lock" /etc/pam.d/veltrix-lock.new
    echo "  [WARN] /etc/pam.d/veltrix-lock differs from the shipped version and was KEPT."
    echo "         The new one is at /etc/pam.d/veltrix-lock.new — diff them if unlocking misbehaves."
fi
# Polkit action for Content Safety (Settings → Safety): without it the
# pkexec prompt for veltrix-content-safety is the generic "run as super
# user" text. The file is ours, not user-edited, so a plain copy is right.
sudo install -Dm644 "$REPO_DIR/config/polkit/org.veltrix.content-safety.policy" \
    /usr/share/polkit-1/actions/org.veltrix.content-safety.policy
# Polkit action for the background updater (Settings → About / the shell's
# update notification): the apply helper runs as root through pkexec,
# authorised without a password for the active local session. No password
# is saved anywhere, so there is no prompt to show — the policy is the
# whole authorisation surface for that action.
sudo install -Dm644 "$REPO_DIR/config/polkit/org.veltrix.update.policy" \
    /usr/share/polkit-1/actions/org.veltrix.update.policy
# Polkit actions for Anonymity (Settings → Safety → Anonymity): three
# verbs, deliberately NOT one authorisation level — turning Tor mode ON
# needs no password for the active session (enabling protection is always
# safe), turning it OFF and installing the tor package need the admin
# password (so malware cannot silently de-anonymise the user, and a package
# install never happens silently). See the policy file's header.
sudo install -Dm644 "$REPO_DIR/config/polkit/org.veltrix.anonymity.policy" \
    /usr/share/polkit-1/actions/org.veltrix.anonymity.policy
sudo ldconfig
rm -rf "$AUTH_BUILD"
# All four native builds succeeded — record the stamp so the next update
# can skip them. Written only here, after every build + install, so a
# failed build never records a stamp for outputs that were not produced.
printf '%s\n' "$_c_stamp" | sudo tee "$_c_stamp_file" >/dev/null || true
fi

# The session daemon is always compiled, including --dev: it is a separate
# service and UI reloads do not rebuild or restart it.
echo "  Building veltrix-sessiond..."
(cd "$REPO_DIR/session" && run_user env CARGO_TARGET_DIR=target RUSTUP_TOOLCHAIN=stable cargo build --release --locked --workspace --features audio-native)
sudo install -Dm755 "$REPO_DIR/session/target/release/veltrix-sessiond" /usr/bin/veltrix-sessiond
sudo install -Dm755 "$REPO_DIR/session/target/release/veltrix-ipc" /usr/bin/veltrix-ipc
# Register only this user's exact development executables, after an explicit dev
# install/update. The helper atomically writes a root-owned 0644 access.d file;
# package installations do not ship developer grants. No trust from .dev/env alone.
if [ "$MODE" = "dev" ] || [ "$MODE" = "update-apply" ]; then
    sudo /usr/bin/python3 "$REPO_DIR/scripts/dev/register-ipc-access.py" \
        --repo "$REPO_DIR" --uid "$(id -u "$REAL_USER")"
fi
# The factory Super+P action launches this Rust toplevel. Build/install only the
# selector; this does not install or take over the native Settings application.
echo "  Building veltrix-display-selector and the Rust shell..."
(cd "$REPO_DIR/toolkit" && run_user env CARGO_TARGET_DIR=target RUSTUP_TOOLCHAIN=stable cargo build --release --locked -p nk-settings --bin veltrix-display-selector -p veltrix-shell --bin veltrix-shell)
sudo install -Dm755 "$REPO_DIR/toolkit/target/release/veltrix-display-selector" /usr/bin/veltrix-display-selector
sudo install -Dm755 "$REPO_DIR/toolkit/target/release/veltrix-shell" /usr/bin/veltrix-shell
sudo install -Dm644 "$REPO_DIR/config/wireplumber/veltrix-audio.lua" /usr/share/wireplumber/scripts/veltrix/audio.lua
sudo install -Dm644 "$REPO_DIR/config/wireplumber/60-veltrix-audio.conf" /usr/share/wireplumber/wireplumber.conf.d/60-veltrix-audio.conf

# systemd user unit — the shell respawns on crash instead of leaving a bare
# compositor (see bin/veltrix.service). NOT enabled by target: it's
# started explicitly from the Veltrix Hyprland config so it can't leak into other
# Hyprland sessions (see the unit's NOTE and the migration disable in step 7).
sudo mkdir -p /usr/lib/systemd/user
sudo install -Dm644 "$REPO_DIR/bin/veltrix.service" /usr/lib/systemd/user/veltrix.service
sudo install -Dm644 "$REPO_DIR/bin/veltrix-sessiond.service" /usr/lib/systemd/user/veltrix-sessiond.service
sudo install -Dm644 "$REPO_DIR/bin/veltrix-sessiond-legacy.service" /usr/lib/systemd/user/veltrix-sessiond-legacy.service
sudo install -Dm644 "$REPO_DIR/bin/veltrix-rust-shell.service" /usr/lib/systemd/user/veltrix-rust-shell.service
# Anonymity's boot restore — a SYSTEM unit, not a user one: the nftables
# ruleset does not survive a reboot, so it must be re-applied before the
# network is up. Unlike the user units above it IS enabled (by target):
# when Tor mode is off, `veltrix-anonymity apply` exits doing nothing, so
# an enabled unit costs nothing on a machine that never turns Tor mode on.
# The enable is guarded on a running systemd: in a chroot or a dev VM the
# unit file is still installed, and the first boot enables it. (A plain
# `systemctl enable` works offline, but a symlink into a target that was
# never booted is exactly the kind of surprise this installer avoids.)
sudo install -Dm644 "$REPO_DIR/bin/veltrix-anonymity.service" /usr/lib/systemd/system/veltrix-anonymity.service
if [ -d /run/systemd/system ]; then
    sudo systemctl enable veltrix-anonymity.service
fi
# Only OPP asks our agent before receiving EACH file; FTP/PCSuite bypass it.
sudo install -Dm644 "$REPO_DIR/config/bluetooth/obex-opp-only.conf" \
    /usr/lib/systemd/user/obex.service.d/50-veltrix-opp-only.conf

# Wayland session entry (shared file: config/wayland-sessions/, also shipped by
# the veltrix pacman package — keep ONE source, don't reintroduce a heredoc here)
sudo mkdir -p /usr/share/wayland-sessions
sudo install -Dm644 "$REPO_DIR/config/wayland-sessions/veltrix.desktop" /usr/share/wayland-sessions/veltrix.desktop
# uwsm env fragment: a system-wide $BROWSER must not contradict Settings → Default
# Apps. Shared file (config/uwsm/), also shipped by the pacman package.
sudo install -Dm644 "$REPO_DIR/config/uwsm/veltrix-browser" /usr/share/uwsm/env-hyprland.d/veltrix-browser
# Default terminal for Terminal=true entries (config/xdg-terminal-exec/, also shipped by
# the pacman package): a system default, so a user's own xdg-terminals.list still wins.
sudo install -Dm644 "$REPO_DIR/config/xdg-terminal-exec/Hyprland-xdg-terminals.list" \
    /usr/share/xdg-terminal-exec/Hyprland-xdg-terminals.list
# Default apps in the Veltrix session (config/mimeapps/, also shipped by the pacman
# package): a system default, so a user's own mimeapps.list still wins.
sudo install -Dm644 "$REPO_DIR/config/mimeapps/veltrix-mimeapps.list" \
    /usr/share/applications/veltrix-mimeapps.list

# Application entries
sudo mkdir -p /usr/share/applications
sudo install -m644 -t /usr/share/applications/ "$REPO_DIR/config/applications/"*.desktop
sudo update-desktop-database /usr/share/applications/ 2>/dev/null || true

# XDG portals
# - veltrix.portal declares Veltrix's own Settings backend (veltrix-portal
#   daemon, D-Bus-activated): serves org.freedesktop.appearance accent-color so
#   libadwaita/GNOME apps follow the Veltrix accent under Hyprland. The Settings
#   portal AGGREGATES backends (verified in x-d-p 1.20 src/settings.c): veltrix
#   serves the whole org.freedesktop.appearance namespace plus org.veltrix.appearance
#   (the appearance contract, architecture.md); gtk keeps serving
#   org.gnome.desktop.interface (fonts, icons, cursor).
# - Config goes in /etc/xdg-desktop-portal/hyprland-portals.conf (matched via
#   XDG_CURRENT_DESKTOP=Hyprland; /etc outranks /usr/share, and the /usr/share
#   one is OWNED BY THE HYPRLAND PACKAGE — never overwrite it). NOTE: the
#   portals/ subdir is for .portal files ONLY — a .conf there is dead (we
#   shipped one there by mistake once; remove it on upgrade).
# (Shared files: config/portal/, also shipped by the veltrix pacman package —
# keep ONE source, don't reintroduce heredocs here.)
sudo mkdir -p /usr/share/xdg-desktop-portal/portals /usr/share/dbus-1/services /etc/xdg-desktop-portal
sudo rm -f /usr/share/xdg-desktop-portal/portals/veltrix.conf  # misplaced legacy
sudo install -Dm644 "$REPO_DIR/config/portal/veltrix.portal" /usr/share/xdg-desktop-portal/portals/veltrix.portal
sudo install -Dm644 "$REPO_DIR/config/portal/org.freedesktop.impl.portal.desktop.veltrix.service" /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.veltrix.service
sudo install -Dm644 "$REPO_DIR/config/portal/hyprland-portals.conf" /etc/xdg-desktop-portal/hyprland-portals.conf
# The Veltrix session (Hyalo, XDG_CURRENT_DESKTOP=Veltrix) reads veltrix-portals.conf; its
# screen sharing is xdg-desktop-portal-wlr with Veltrix's picker (bin/veltrix-share-chooser).
sudo install -Dm644 "$REPO_DIR/config/portal/veltrix-portals.conf" /etc/xdg-desktop-portal/veltrix-portals.conf
sudo install -Dm644 "$REPO_DIR/config/portal/xdpw-veltrix.conf" /etc/xdg/xdg-desktop-portal-wlr/Veltrix
# System dconf defaults (icon theme, accent, colour scheme) — the same two files the
# package installs, from the same generator, so a --dev machine is not the one place
# where a new account starts on Adwaita and veltrix-setup warns on every run.
# /etc/dconf/profile/user is ours outright (no package owns it; see its header).
sudo install -Dm644 "$REPO_DIR/config/dconf/profile-user" /etc/dconf/profile/user
"$REPO_DIR/scripts/gen-dconf-defaults.sh" "$REPO_DIR/defaults/appearance.json" \
    | sudo install -Dm644 /dev/stdin /etc/dconf/db/local.d/00-veltrix-appearance
sudo dconf update

# The desktop's settings schemas (#573). Same path as the package in BOTH modes:
# a copy in ~/.local/share/glib-2.0/schemas would SHADOW the system one (measured
# 2026-09-14), and outlive the dev checkout that put it there. Re-run this after
# editing config/gsettings/ — the shell reads the COMPILED schema, not the XML.
sudo install -Dm644 -t /usr/share/glib-2.0/schemas "$REPO_DIR"/config/gsettings/*.gschema.xml
sudo glib-compile-schemas /usr/share/glib-2.0/schemas
# Only now restart the portals: restarting xdg-desktop-portal re-activates veltrix-portal at
# once, and one started before the schemas are compiled serves the OLD schema until it dies
# (it is D-Bus activated, so it outlives a session restart — seen live 2026-10-19).
pkill -f veltrix-portal 2>/dev/null || true
systemctl --user restart xdg-desktop-portal 2>/dev/null || true

# fontconfig: per-language CJK variant. Arch's noto-fonts-cjk ships no
# fontconfig rules and fontconfig's own 65-nonlatin.conf hardcodes the KR face,
# so zh/ja sessions render their Han characters with Korean stroke forms.
# The rules prepend the regional face by text language; the 65-0- filename MUST
# sort before 65-nonlatin.conf (see the file's header comment). (Shared file:
# config/fontconfig/, also shipped by the veltrix pacman package — keep ONE source.)
sudo mkdir -p /usr/share/fontconfig/conf.avail /etc/fonts/conf.d
sudo install -Dm644 "$REPO_DIR/config/fontconfig/65-0-veltrix-noto-cjk.conf" /usr/share/fontconfig/conf.avail/65-0-veltrix-noto-cjk.conf
sudo ln -sf /usr/share/fontconfig/conf.avail/65-0-veltrix-noto-cjk.conf /etc/fonts/conf.d/65-0-veltrix-noto-cjk.conf

# fontconfig: per-language Arabic faces (Noto Sans Arabic for UI, Noto Naskh
# Arabic for Quranic/serif). Same 65-0- rule, same reason. (Bilingual feature,
# 2026-11-12. Shared file: config/fontconfig/, also shipped by the veltrix
# pacman package — keep ONE source.)
sudo install -Dm644 "$REPO_DIR/config/fontconfig/65-0-veltrix-noto-arabic.conf" /usr/share/fontconfig/conf.avail/65-0-veltrix-noto-arabic.conf
sudo ln -sf /usr/share/fontconfig/conf.avail/65-0-veltrix-noto-arabic.conf /etc/fonts/conf.d/65-0-veltrix-noto-arabic.conf

# ── No orphans: an update replaces, never accumulates ───────────────────────
# A file this tree no longer ships must disappear instead of lingering beside
# its replacement. Three places copy by name and never removed the old one:
#   /usr/bin/veltrix-* — a renamed or deleted CLI would stay executable
#     forever. The shipped set is bin/veltrix-* plus the binaries §4 and
#     the PKGBUILD build (veltrix-input, veltrix-sessiond, veltrix-ipc,
#     veltrix-display-selector, veltrix-shell, veltrix-hyalo,
#     veltrix-hyalo-session) — keep that list in step with the installs
#     above and with scripts/verify-installed-perms.sh, which requires
#     every name on it to exist. veltrix-hyalo and veltrix-hyalo-session
#     are NOT in bin/ (cargo builds them, the PKGBUILD installs them to
#     /usr/bin) — without the exemption below this sweep deleted the
#     compositor itself on every update (Nov 14 sweep #1).
#   /usr/share/applications/*.desktop — a removed app entry would stay in
#     every launcher. Only our names are touched (veltrix-*, org.veltrix.*);
#     the mimeapps list beside them is not a .desktop file and is untouched.
# Placed here, after every §4 install, so the built binaries exist before
# anything is judged orphaned. All best-effort: a leftover orphan is untidy,
# not a failed install.
for _bin in /usr/bin/veltrix-*; do
    [ -e "$_bin" ] || continue
    _name="${_bin#/usr/bin/}"
    case "$_name" in
        veltrix-input|veltrix-sessiond|veltrix-ipc|veltrix-display-selector|veltrix-shell|veltrix-hyalo|veltrix-hyalo-session) ;;
        *)
            [ -f "$REPO_DIR/bin/$_name" ] && continue
            echo "  Removing orphaned /usr/bin/$_name (no longer shipped)..."
            sudo rm -f "$_bin" || echo "  [WARN] could not remove orphaned /usr/bin/$_name" >&2
            ;;
    esac
done
for _desktop in /usr/share/applications/veltrix-*.desktop /usr/share/applications/org.veltrix.*.desktop; do
    [ -e "$_desktop" ] || continue
    _name="${_desktop#/usr/share/applications/}"
    if [ ! -f "$REPO_DIR/config/applications/$_name" ]; then
        echo "  Removing orphaned application entry $_name (no longer shipped)..."
        sudo rm -f "$_desktop" || echo "  [WARN] could not remove orphaned application entry $_name" >&2
    fi
done

# ── Verify the installed permissions — FAIL LOUDLY, never silently broken ────
# The Dell's 2026-11-13 failure was a silent one: the install printed success
# while /usr/bin/veltrix-* and the units were unreadable. This pass asserts
# every file §4 installed is world-readable (executables world-executable)
# and aborts the install naming the file if any check fails. It also runs
# from bootstrap.sh after the install, and on --update-apply (same §4).
# --dev skips the installed shell bundle (dev runs it from source).
if [ "$MODE" = "dev" ]; then
    bash "$REPO_DIR/scripts/verify-installed-perms.sh" --dev
else
    bash "$REPO_DIR/scripts/verify-installed-perms.sh"
fi

# The pacman list fingerprint — --update compares it to decide whether
# phase 1 (package sync) can be skipped.
printf '%s\n' "$DEPS_LIST_SHA" | sudo tee "$PACMAN_SHA_FILE" > /dev/null

# ── Extra apps (iPad Mode, Nov 12 2026) ─────────────────────────────────────
# The apps question lives HERE: after everything is ready (§1–§4) and before
# first-time setup (§5) and the login handoff. Fresh --dev installs only —
# updates never re-ask, and a recorded choice is never asked twice (delete
# $APPS_CHOICE_FILE to be asked again). Nothing here runs on the finished
# desktop: veltrix-setup and the session never call it.
if [ "$MODE" = "dev" ]; then
    if [ -f "$APPS_CHOICE_FILE" ]; then
        printf "$(apps_msg already)\n" "$APPS_CHOICE_FILE"
    else
        # Guarded (F4): the prompt and the installs must never abort the
        # install under set -e — both already guard their own writes,
        # this is the belt to those braces.
        ask_extra_apps || echo "  [WARN] The extra-apps question failed — continuing without it." >&2
        install_extra_apps "${APPS_PICKED[@]}" || echo "  [WARN] The extra-apps install failed — continuing." >&2
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. First-time setup — install-mode markers here; everything else is delegated
#    to veltrix-setup (ONE implementation, shared with the pacman-package path).
# ─────────────────────────────────────────────────────────────────────────────
echo "[5/5] Initializing user configuration..."
mkdir -p "$CONFIG_DIR"
# Own the parent too: under sudo, `mkdir -p` can create ~/.config itself as
# root, which silently breaks the whole session (rationale in bin/veltrix-setup).
chown "$REAL_USER:" "${REAL_HOME}/.config" "$CONFIG_DIR"

# Dev mode marker. An update never changes the install's mode: --update-apply
# leaves the marker exactly as it found it.
if [ "$MODE" = "dev" ]; then
    echo "$REPO_DIR" > "$CONFIG_DIR/.dev"
    chown "$REAL_USER:" "$CONFIG_DIR/.dev"
    echo "  [Dev] veltrix-ui will run from: $REPO_DIR"
    # A branch-based install is not a release install: clear the release
    # marker (if any) so the update check compares the tree's VERSION,
    # never a stale release number.
    rm -f "$CONFIG_DIR/.release"
fi

# ── Source registration ──────────────────────────────────────────────
# A dev install registers its own clone: that is the path `veltrix-update` follows
# to update it. update-apply never re-registers — it runs FROM the clone it is
# updating, and rewriting the marker mid-update could only ever change it to the
# value it already has, or to a wrong one.
if [ "$MODE" = "dev" ]; then
    echo "$REPO_DIR" > "$SOURCE_FILE"
    chown "$REAL_USER:" "$SOURCE_FILE"
fi

# Everything else a first login needs — per-user config seeding, uwsm env +
# NVIDIA autodetect, greetd/DM setup, service enablement — lives in
# bin/veltrix-setup: ONE idempotent implementation, shared with the package
# path (`pacman -S veltrix && veltrix-setup`) and with veltrix-update. §6 just
# refreshed /usr/bin/veltrix-setup and its /usr/share/veltrix payloads, so run
# the installed copy. (The old --dev-repo flag is gone: hypridle.conf is user
# state written by Settings → Power, never a symlink into the repo.)
bash /usr/bin/veltrix-setup

echo ""
if [ "$MODE" = "update-apply" ]; then
    NEW_VERSION="$(cat "$REPO_DIR/VERSION" 2>/dev/null || echo "?")"
    if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
        echo "  ✓ Update complete (version $NEW_VERSION)"
    else
        echo "  ✓ Update complete: $OLD_VERSION → $NEW_VERSION"
    fi
    # Reload the running shell so the new bundle takes effect now; greeter and
    # lockscreen pick theirs up on next use. Harmless if the session isn't ours.
    if run_user systemctl --user is-active --quiet veltrix-rust-shell.service 2>/dev/null; then
        run_user systemctl --user restart veltrix-rust-shell.service || true
    elif run_user systemctl --user is-active --quiet veltrix.service 2>/dev/null; then
        run_user systemctl --user restart veltrix.service || true
        echo "  Shell reloaded."
    fi
else
    echo "  ✓ Dev install complete"
    # Failed extra apps are NOT buried under a green "complete" (F8):
    # if any picked app failed, say so here, with where it is recorded.
    if [ "${#APPS_FAILED[@]}" -gt 0 ]; then
        echo "  [WARN] These extra apps did NOT install: ${APPS_FAILED[*]}"
        echo "         Recorded in $APPS_CHOICE_FILE — retry them by hand (see the README, 'Removing the extra apps')."
    fi
    echo "  veltrix-ui will run from source at $REPO_DIR"
    echo "  Select 'Veltrix' at the login screen; update later with: veltrix-update"
    echo ""
    # Leaving dev mode is no longer "run this script the other way" — this script
    # has no other way since 2026-09-02. It is: drop the marker, then install the
    # package, which then owns the files this dev install copied into /usr.
    echo "  To go back to a packaged install: rm $CONFIG_DIR/.dev, then"
    echo "  'sudo pacman -Syu veltrix && veltrix-setup' (see the README)."
fi
echo ""
