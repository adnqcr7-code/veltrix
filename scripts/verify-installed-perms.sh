#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-installed-perms.sh — assert the installed Veltrix files are readable
# (and executables executable) by the user who runs the desktop.
#
# WHY THIS EXISTS (2026-11-13, Dell install). The repo's working-tree modes
# are restrictive by default (data 660, scripts 770, root-owned once copied
# with sudo), so a plain `sudo cp` into /usr left /usr/bin/veltrix-* unreadable
# and the systemd units invisible — a desktop that silently never started,
# fixed on the Dell only by hand-running chmod 755/644. install.sh §4 now
# sets every mode explicitly (install -D / chmod -R a+rX), and this script is
# the backstop: it runs at the end of §4 (and from bootstrap.sh after the
# install) and FAILS LOUDLY, naming the file and its actual mode, instead of
# letting a broken install look complete.
#
# Usage: ./scripts/verify-installed-perms.sh [--dev]
#   --dev   the shell bundle is NOT installed (dev runs it from source), so
#           /usr/share/veltrix/ui/shell/build/veltrix is not required.
# Reads only (stat); needs no sudo. Exit 0 = PASS, 1 = FAIL (lists every bad
# file). Symlinks are skipped — their target's mode is what matters, and the
# two symlinked installs (hyprland.lua → the repo, icons/veltrix → assets)
# are owned/readable by the installing user already.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DEV_MODE=no
for arg in "$@"; do
    case "$arg" in
        --dev) DEV_MODE=yes ;;
        --help) echo "Usage: $0 [--dev]"; exit 0 ;;
        *) echo "verify-installed-perms.sh: unknown argument '$arg'" >&2; exit 2 ;;
    esac
done

FAILURES=0
CHECKS=0

_fail() { # _fail <path> <actual-mode-or-MISSING> <what-was-needed>
    printf '  [FAIL] %s (mode %s) — needs %s\n' "$1" "$2" "$3" >&2
    FAILURES=$((FAILURES + 1))
}

# _check_mode <path> <need> — need is "r" (world-readable) or "rx".
_check_mode() {
    local path="$1" need="$2" mode_str mode
    CHECKS=$((CHECKS + 1))
    if [ -L "$path" ]; then
        return 0  # symlink: mode is irrelevant, target checked where it lives
    fi
    if [ ! -e "$path" ]; then
        _fail "$path" "MISSING" "to exist, $need for others"
        return 0
    fi
    mode_str="$(stat -c %a -- "$path" 2>/dev/null)" || { _fail "$path" "UNSTATABLE" "$need for others"; return 0; }
    mode=$((8#$mode_str))
    if (( (mode & 004) == 0 )); then
        _fail "$path" "$mode_str" "world-readable"
    elif [ "$need" = "rx" ] && (( (mode & 001) == 0 )); then
        _fail "$path" "$mode_str" "world-executable"
    fi
}

# _check_tree <dir> <need> — every regular file under <dir> must be o+r
# (and o+x when need=rx); every directory must be o+rx so it is traversable.
_check_tree() {
    local dir="$1" need="$2" f d mode_str mode
    if [ ! -d "$dir" ]; then
        _fail "$dir" "MISSING" "directory to exist"
        return 0
    fi
    while IFS= read -r -d '' f; do
        CHECKS=$((CHECKS + 1))
        mode_str="$(stat -c %a -- "$f" 2>/dev/null)" || { _fail "$f" "UNSTATABLE" "world-readable"; continue; }
        mode=$((8#$mode_str))
        if (( (mode & 004) == 0 )); then
            _fail "$f" "$mode_str" "world-readable"
        elif [ "$need" = "rx" ] && (( (mode & 001) == 0 )); then
            _fail "$f" "$mode_str" "world-executable"
        fi
    done < <(find "$dir" -type f -print0 2>/dev/null)
    while IFS= read -r -d '' d; do
        CHECKS=$((CHECKS + 1))
        mode_str="$(stat -c %a -- "$d" 2>/dev/null)" || { _fail "$d" "UNSTATABLE" "world-executable (traverse)"; continue; }
        mode=$((8#$mode_str))
        if (( (mode & 005) != 005 )); then
            _fail "$d" "$mode_str" "world-readable + traversable (o+rx)"
        fi
    done < <(find "$dir" -type d -print0 2>/dev/null)
}

# ── Executables: the session entry and every CLI the desktop/shell calls ─────
for _bin in veltrix veltrix-ui veltrix-settings veltrix-greeter veltrix-lock \
    veltrix-greeter-session veltrix-before-sleep veltrix-after-sleep \
    veltrix-display-brightness veltrix-power-key veltrix-kbd-light veltrix-media-key \
    veltrix-doctor veltrix-portal veltrix-share-chooser veltrix-mcp veltrix-agent \
    veltrix-a11y veltrix-act veltrix-type veltrix-click veltrix-wm veltrix-hook \
    veltrix-update veltrix-setup veltrix-migrate veltrix-language veltrix-hijri-date \
    veltrix-prayer-times veltrix-prayer-lock veltrix-weather veltrix-content-safety \
    veltrix-halal-audio veltrix-input veltrix-sessiond veltrix-ipc \
    veltrix-display-selector veltrix-shell; do
    _check_mode "/usr/bin/$_bin" rx
done
# Any future veltrix-* binary added to /usr/bin must satisfy the same rule —
# the list above names the load-bearing ones, this sweep catches the rest.
while IFS= read -r -d '' _f; do
    _check_mode "$_f" rx
done < <(find /usr/bin -maxdepth 1 -name 'veltrix*' -type f -print0 2>/dev/null)

# Bundled UI entry points (read by gjs; shipped 755 like the repo builds them).
_check_mode /usr/share/veltrix/ui/settings/build/veltrix-settings rx
_check_mode /usr/share/veltrix/ui/greeter/build/veltrix-greeter rx
_check_mode /usr/share/veltrix/ui/lockscreen/build/veltrix-lock rx
if [ "$DEV_MODE" = no ]; then
    _check_mode /usr/share/veltrix/ui/shell/build/veltrix rx
fi
_check_mode /usr/share/veltrix/voiceonly/run.sh rx
_check_mode /usr/lib/libveltrix-wl.so.0.0.0 rx
_check_mode /usr/lib/libveltrix-auth.so.0.0.0 rx

# ── Data files: world-readable, or the reader (greeter, systemd, portal) ────
# cannot open them. Includes the two units whose missing chmod broke the Dell.
for _f in \
    /usr/share/veltrix/VERSION \
    /usr/share/veltrix/config/hypr/hypridle.conf \
    /usr/share/veltrix/content-safety/blocklist.txt \
    /usr/share/veltrix/voiceonly/voiceonly.py \
    /usr/share/veltrix/voiceonly/wordscan.py \
    /usr/share/veltrix/voiceonly/blacklist.txt \
    /usr/share/veltrix/ui/settings/style.css \
    /usr/share/veltrix/ui/shell/style.css \
    /usr/share/veltrix/ui/greeter/style.css \
    /usr/share/veltrix-kit/kit.css \
    /usr/share/veltrix-kit/package.json \
    /usr/lib/systemd/user/veltrix.service \
    /usr/lib/systemd/user/veltrix-sessiond.service \
    /usr/lib/systemd/user/veltrix-sessiond-legacy.service \
    /usr/lib/systemd/user/veltrix-rust-shell.service \
    /usr/lib/systemd/user/obex.service.d/50-veltrix-opp-only.conf \
    /usr/share/wayland-sessions/veltrix.desktop \
    /usr/share/xdg-desktop-portal/portals/veltrix.portal \
    /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.veltrix.service \
    /etc/xdg-desktop-portal/hyprland-portals.conf \
    /etc/xdg-desktop-portal/veltrix-portals.conf \
    /etc/xdg/xdg-desktop-portal-wlr/Veltrix \
    /etc/pam.d/veltrix-lock \
    /usr/share/polkit-1/actions/org.veltrix.content-safety.policy \
    /usr/share/wireplumber/scripts/veltrix/audio.lua \
    /usr/share/wireplumber/wireplumber.conf.d/60-veltrix-audio.conf \
    /usr/lib/girepository-1.0/VeltrixWl-1.0.typelib \
    /usr/lib/girepository-1.0/VeltrixAuth-1.0.typelib \
    /usr/share/gir-1.0/VeltrixWl-1.0.gir \
    /usr/share/gir-1.0/VeltrixAuth-1.0.gir \
    /usr/share/uwsm/env-hyprland.d/veltrix-browser \
    /usr/share/xdg-terminal-exec/Hyprland-xdg-terminals.list \
    /usr/share/applications/veltrix-mimeapps.list \
    /etc/dconf/profile/user \
    /etc/dconf/db/local.d/00-veltrix-appearance \
    /usr/share/fontconfig/conf.avail/65-0-veltrix-noto-cjk.conf \
    /usr/share/fontconfig/conf.avail/65-0-veltrix-noto-arabic.conf \
    ; do
    _check_mode "$_f" r
done
# GSettings schemas are installed by glob — check whichever are present.
for _f in /usr/share/glib-2.0/schemas/org.veltrix.*.gschema.xml; do
    [ -f "$_f" ] && _check_mode "$_f" r
done

# ── Payload trees: every file o+r, every dir o+rx ────────────────────────────
# (This is what catches a future `cp -r` that forgets its chmod: the trees
# hold the defaults, skills, settings data, assets, migrations, blocklist and
# voiceonly payloads, all of which the desktop reads as the session user.)
_check_tree /usr/share/veltrix r
_check_tree /usr/share/veltrix-kit r
_check_tree /usr/lib/systemd/user r
_check_tree /usr/lib/veltrix rx

if [ "$FAILURES" -gt 0 ]; then
    printf 'verify-installed-perms: FAIL — %d of %d checks bad. The desktop will not start correctly like this.\n' "$FAILURES" "$CHECKS" >&2
    printf 'Fix: re-run ./install.sh --dev (it sets every mode explicitly), or chmod the files above (755 executables, 644 data).\n' >&2
    exit 1
fi
printf 'verify-installed-perms: PASS — %d checks, all installed files world-readable (executables world-executable).\n' "$CHECKS"
exit 0
