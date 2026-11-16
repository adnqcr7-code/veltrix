#!/bin/sh
# Run the REAL Veltrix shell (from the repo checkout, dev mode) as a client of Hyalo, sealed
# off from the live session:
#   - HOME and XDG_CONFIG_HOME are a throwaway copy, so nothing it writes (veltrix-*.lua, the
#     Hyprland config it generates, dconf) reaches the real files;
#   - its own D-Bus session bus, so it does not collide with the live shell's org.veltrix.Shell;
#   - no HYPRLAND_INSTANCE_SIGNATURE, so hyprctl and the IPC socket find nothing to drive.
# Must be started with WAYLAND_DISPLAY pointing at Hyalo.
#   hyalo/scripts/sandboxed-shell.sh [veltrix repo]
set -eu
repo=$(realpath "${1:-${VELTRIX_REPO:-$HOME/Dev/Distroia}}")
real_home=$HOME
box=${VELTRIX_SANDBOX:-$(mktemp -d /tmp/veltrix-hyalo-home.XXXXXX)}
mkdir -p "$box/.config" "$box/.local/share" "$box/mirror"
# Hyalo gives clients Xwayland's DISPLAY too. Our session launcher pins GTK to
# Wayland; the test must do the same or the bar becomes an ordinary X11 window.
export GDK_BACKEND=wayland VELTRIX_GREETER_MIRROR_DIR="$box/mirror"
# The user's Veltrix config, without hooks (a hook is a user script: it could act on the live
# session) and without its git history.
cp -a "$real_home/.config/veltrix" "$box/.config/" && rm -rf "$box/.config/veltrix/hooks" "$box/.config/veltrix/.git"
# HYALO_GLASS_TUNING=file: the glass's numbers for this run instead of the user's
# glass-tuning.conf, to compare values without touching the live session's.
[ -n "${HYALO_GLASS_TUNING:-}" ] && cp "$HYALO_GLASS_TUNING" "$box/.config/veltrix/glass-tuning.conf"
[ -f "$real_home/.config/dconf/user" ] && mkdir -p "$box/.config/dconf" \
  && cp "$real_home/.config/dconf/user" "$box/.config/dconf/user"
[ -d "$real_home/.config/gtk-4.0" ] && cp -r "$real_home/.config/gtk-4.0" "$box/.config/"

wp=${HYALO_WALLPAPER:-$(sed -n 's/.*"path" *: *"\([^"]*\)".*/\1/p' "$real_home/.config/veltrix/wallpaper")}

unset HYPRLAND_INSTANCE_SIGNATURE
unset DBUS_SESSION_BUS_ADDRESS
# Its own runtime dir too: scripts/run.sh writes the bundle to $XDG_RUNTIME_DIR/veltrix-run-app.js,
# the very path the LIVE shell's bundle has. The Wayland socket is passed as an absolute path.
case "$WAYLAND_DISPLAY" in /*) ;; *) export WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ;; esac
mkdir -p "$box/run" && chmod 700 "$box/run"
export XDG_RUNTIME_DIR="$box/run"
export HOME="$box" XDG_CONFIG_HOME="$box/.config" XDG_DATA_HOME="$box/.local/share" \
  XDG_CACHE_HOME="$box/.cache" \
  XDG_DATA_DIRS="$real_home/.local/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"

# The checkout's own libveltrix-wl first (the material protocol's client half lives there).
wl_build=${VELTRIX_WL_BUILD:-$repo/lib/veltrix-wl/build}
export GI_TYPELIB_PATH="$wl_build${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
export LD_LIBRARY_PATH="$wl_build${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# The wallpaper, so the glass has a backdrop to blur. awww restores from its own cache,
# which the throwaway HOME does not have, so the user's wallpaper is set explicitly.
awww-daemon >/dev/null 2>&1 &
( for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; awww img "$wp" --transition-type none 2>/dev/null && break; done ) &

# HYALO_DRIVER=script: a script run on the private bus beside the shell (veltrix-ipc reaches
# the sandboxed shell, veltrix-hyalo msg the nested Hyalo); the shell stops when it ends.
if [ -n "${HYALO_DRIVER:-}" ]; then
  exec dbus-run-session -- sh -c '"$1" "$2" & shell=$!; sh "$3"; kill $shell' \
    sh "$repo/scripts/run.sh" "$repo/ui/shell/app.ts" "$(realpath "$HYALO_DRIVER")"
fi
# HYALO_IPC_AFTER="20:toggleCC": one veltrix-ipc action on the private bus after N seconds.
if [ -n "${HYALO_IPC_AFTER:-}" ]; then
  exec dbus-run-session -- sh -c '"$1" "$2" & sleep "${3%%:*}"; veltrix-ipc "${3#*:}"; wait' \
    sh "$repo/scripts/run.sh" "$repo/ui/shell/app.ts" "$HYALO_IPC_AFTER"
fi
exec dbus-run-session -- "$repo/scripts/run.sh" "$repo/ui/shell/app.ts"
