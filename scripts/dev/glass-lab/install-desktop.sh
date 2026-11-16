#!/usr/bin/env bash
# Puts the glass lab in the app grid as «Laboratorio de cristal» (a .desktop entry in the user's
# applications directory, pointing at THIS checkout's glass-lab.sh). Run it again after moving
# the checkout. --remove takes it out.
set -euo pipefail
here=$(dirname "$(realpath "$0")")
repo=$(realpath "$here/../../..")
dest="${XDG_DATA_HOME:-$HOME/.local/share}/applications/org.veltrix.GlassLab.desktop"
if [ "${1:-}" = "--remove" ]; then rm -f "$dest"; echo "removed $dest"; exit 0; fi
mkdir -p "$(dirname "$dest")"
cat >"$dest" <<EOF
[Desktop Entry]
Type=Application
Name=Laboratorio de cristal
Comment=El cristal de Veltrix sobre una maqueta del escritorio
Exec=$here/glass-lab.sh
Icon=$repo/ui/shell/assets/veltrix/assets/veltrix-symbolic.svg
Terminal=false
Categories=Development;Graphics;
StartupWMClass=veltrix-hyalo
EOF
echo "installed $dest"
