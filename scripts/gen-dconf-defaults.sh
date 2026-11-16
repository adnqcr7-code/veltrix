#!/usr/bin/env bash
# gen-dconf-defaults.sh — the system dconf keyfile, generated from defaults/appearance.json.
#
#   scripts/gen-dconf-defaults.sh [defaults/appearance.json] > …/etc/dconf/db/local.d/00-veltrix-appearance
#
# ONE generator for both install paths — the PKGBUILD (packaged installs) and
# install.sh --dev — so the value a fresh account starts with cannot differ between
# them. Before this existed only the PKGBUILD wrote it, and a --dev machine had no
# system default at all (veltrix-setup's "[WARN] the system icon-theme default is not
# in effect" on every run).
#
# What goes in, and why each key is a system DEFAULT rather than a per-user write:
# see the comment above its use in packaging/veltrix/PKGBUILD, and the appearance
# contract in .claude/skills/veltrix/references/architecture.md (accent-color and
# color-scheme LIVE in gsettings).
#
# ⚠️ `gtk-theme` is for THIRD-PARTY applications — Veltrix's own processes load no GTK
# theme at all (commandment 11, ui/lib/veltrix-kit/platform/gtk-theme.ts). Its seed is `Default`, the name
# GTK's built-in answers to, and that is a FIX rather than a rename: it said `Adwaita`
# until 2026-09-20 and a clean Arch has no /usr/share/themes/Adwaita, so GTK fell back
# to the built-in anyway while Settings displayed a theme that was on no disk and in
# none of its own options (tech-debt #107).
#
# ⚠️ `accent-color` is a GNOME ENUM, not a free name: gsettings-desktop-schemas
# allows only blue, teal, green, yellow, orange, red, pink, purple, slate — there
# is NO cyan. Veltrix's own accent is a hex (org.veltrix.appearance accent-hex,
# picked in Studio; cyan #00E5FF is the default), but the name PUBLISHED to
# GNOME must be one of the nine, so this generator translates the DEFAULT
# accent's name: cyan → blue (libadwaita blue #3584e4, the default and the
# closest named accent to cyan that reads as blue — the Files app's logo
# colour). Writing the Veltrix name raw was the Files bug of 2026-11-13:
# `accent-color='cyan'` compiled into dconf unvalidated, so a `get_string`
# reader saw "cyan" while a `get_enum` reader (libadwaita's GSettings impl,
# xdg-desktop-portal-gtk) fell back to the schema default — and a GSettings
# write of "cyan" is REFUSED, so ThemeManager's normaliser could never dislodge
# a stored user-db "purple" (user-db beats this system default), and Nautilus
# kept painting purple #9141ac selections. The portal serves the accent-hex
# RGB (bin/veltrix-portal) — the toolkit nearest-matches it against its
# palette — so the two channels agree on the colour family and neither can
# ever say purple for the DEFAULT. Keep this translation in sync with
# nearestGnomeAccent in ui/lib/veltrix-kit/platform/accent.ts, GNOME_ACCENT
# in ui/shell/core/ThemeManager.ts (the default's published name) and the
# repair in ui/shell/core/AppearanceSync.ts (seedAndRepair).
set -euo pipefail
src="${1:-defaults/appearance.json}"
[ -f "$src" ] || { echo "gen-dconf-defaults: no such file: $src" >&2; exit 1; }

field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$src" | head -1; }
icon_theme="$(field iconTheme)"
gtk_theme="$(field themeFamily)"
cursor_theme="$(field cursorTheme)"
accent="$(field accent)"
is_dark="$(sed -n 's/.*"isDark"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$src" | head -1)"
[ -n "$icon_theme" ] || { echo "gen-dconf-defaults: no iconTheme in $src" >&2; exit 1; }
[ -n "$gtk_theme" ]  || { echo "gen-dconf-defaults: no themeFamily in $src" >&2; exit 1; }
[ -n "$cursor_theme" ] || { echo "gen-dconf-defaults: no cursorTheme in $src" >&2; exit 1; }
[ -n "$accent" ]     || { echo "gen-dconf-defaults: no accent in $src" >&2; exit 1; }
[ -n "$is_dark" ]    || { echo "gen-dconf-defaults: no isDark in $src" >&2; exit 1; }
scheme=prefer-light; [ "$is_dark" = true ] && scheme=prefer-dark

# Veltrix accent name → the GNOME enum name published to third-party apps.
# Only the nine names above are valid; anything else (including our own "cyan")
# would be an invalid raw value in dconf again. "cyan" is blue: the Files app
# must select blue, never purple.
case "$accent" in
    blue|teal|green|yellow|orange|red|pink|purple|slate) gnome_accent="$accent" ;;
    *) gnome_accent="blue" ;;
esac
# Purple is never the system DEFAULT here even though it is a valid GNOME
# name and a valid user accent (a preset since 2026-11-15): a default that
# said purple would publish purple to every fresh account. A user's own
# purple lives in their user-db, not in this file.
[ "$gnome_accent" = "purple" ] && gnome_accent="blue"

cat <<KEYFILE
# Generated from defaults/appearance.json by scripts/gen-dconf-defaults.sh. Edit that
# file, not this one — and note this is a DEFAULT: whatever the person chose in their
# own dconf wins, because /etc/dconf/profile/user reads user-db first.
[org/gnome/desktop/interface]
icon-theme='$icon_theme'
gtk-theme='$gtk_theme'
cursor-theme='$cursor_theme'
accent-color='$gnome_accent'
color-scheme='$scheme'

# The window buttons, for apps that draw their own title bar AND for Hyalo's controls, which
# follow this key (ui/shell/core/WindowButtons.ts). GNOME's own default is close alone.
# Close, minimize and maximize on the RIGHT, in the standard order (#724): minimize,
# maximize, close — the Linux and Windows convention, close last. Settings offers the
# side alone; minimize is always there. (The macOS order on the left, with the traffic-light
# circles, was removed 2026-11-13: the buttons are normal buttons now.)
[org/gnome/desktop/wm/preferences]
button-layout='appmenu:minimize,maximize,close'
KEYFILE
