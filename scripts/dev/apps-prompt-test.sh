#!/bin/bash
# Prompt + install test for the iPad Mode fix pass #1.
# Extracts the REAL apps block from fork/install.sh (no copies) and runs
# the v1 cases plus the new ones: no-newline piped input, glob expansion,
# integer wrap-around, "a l l", unknown ids, symlink refusal, guarded write.
set -u
FORK="$HOME/workspace/veltrix/fork"
TDIR="$(mktemp -d /tmp/apps-fix-test.XXXXXX)"
trap 'rm -rf "$TDIR"' EXIT
mkdir -p "$TDIR/bin" "$TDIR/choice" "$TDIR/desktop" "$TDIR/cwd"

# PATH shims that log argv (pacman/flatpak never really run).
cat > "$TDIR/bin/pacman" <<'EOF'
#!/bin/bash
echo "pacman $*" >> "$SHIM_LOG"
if [ "${SHIM_PACMAN_FAIL:-0}" = "1" ]; then exit 1; fi
# -Q prints a fake version line
if [ "$1" = "-Q" ]; then echo "$2 1.0-1"; exit 0; fi
exit 0
EOF
cat > "$TDIR/bin/flatpak" <<'EOF'
#!/bin/bash
echo "flatpak $*" >> "$SHIM_LOG"
if [ "$1" = "list" ]; then echo "Spotify com.spotify.Client 1.2.3 stable system"; echo "FreeTube io.freetubeapp.FreeTube 0.26.0 stable system"; exit 0; fi
exit 0
EOF
# cmake shim: configure logs and succeeds; --build creates a fake vile-qt
# binary at the expected path (no Qt6 in this sandbox — the real build is
# a Dell test). Parses -B / --build from argv like the real cmake would.
cat > "$TDIR/bin/cmake" <<'EOF'
#!/bin/bash
echo "cmake $*" >> "$SHIM_LOG"
build=""; prev=""
for a in "$@"; do
    if [ "$prev" = "-B" ] || [ "$prev" = "--build" ]; then build="$a"; fi
    prev="$a"
done
# Who owns the build dir at configure time — the sudo case asserts this
# is the user (nobody), not root: a root-owned dir is the bug.
if [ -n "$build" ]; then stat -c "owner:%U %n" "$build" >> "$SHIM_LOG" 2>/dev/null || true; fi
if [ "$1" = "--build" ]; then
    mkdir -p "$build/qt"
    printf '#!/bin/sh\nexit 0\n' > "$build/qt/vile-qt"
    chmod +x "$build/qt/vile-qt"
fi
exit 0
EOF
chmod 755 "$TDIR/bin/pacman" "$TDIR/bin/flatpak" "$TDIR/bin/cmake"

# Extract the apps block from install.sh itself.
awk '/^APPS_CHOICE_FILE=/{f=1} f{print} /^# 1\. System dependencies/{if(f) exit}' \
    "$FORK/install.sh" > "$TDIR/apps-block.sh"
bash -n "$TDIR/apps-block.sh" || { echo "EXTRACT SYNTAX FAIL"; exit 1; }
wc -l "$TDIR/apps-block.sh"

export VELTRIX_APPS_NO_SUDO=1
export PATH="$TDIR/bin:$PATH"
export SHIM_LOG="$TDIR/shim.log"
export VELTRIX_C_GREEN="" VELTRIX_C_CYAN="" VELTRIX_C_RESET=""
MODE=dev
# apps_vile reads $REPO_DIR (defined at the top of install.sh, outside the
# extracted apps block) for the vendored Vile source.
REPO_DIR="$FORK"

run_prompt() { # $1=input file (or /dev/null), $2=tag
    local input="$1" tag="$2"
    export VELTRIX_APPS_CHOICE_FILE="$TDIR/choice/$tag.json"
    export VELTRIX_APPS_DESKTOP_DIR="$TDIR/desktop"
    export VELTRIX_APPS_VERSIONS_FILE="$TDIR/choice/versions-$tag.log"
    rm -f "$VELTRIX_APPS_CHOICE_FILE"
    ( cd "$TDIR/cwd" && . "$TDIR/apps-block.sh" >/dev/null 2>&1
      ask_extra_apps < "$input" > "$TDIR/out-$tag.txt" 2>&1
      echo "rc=$?" >> "$TDIR/out-$tag.txt"
      printf '%s' "$(cat "$VELTRIX_APPS_CHOICE_FILE" 2>/dev/null)" > "$TDIR/apps-$tag.json" )
    echo "--- $tag: $(cat "$TDIR/apps-$tag.json" 2>/dev/null | tr -d '\n ')"
}

check() { # $1=tag $2=expected apps json fragment $3=desc
    if grep -qF "$2" "$TDIR/apps-$3.json" 2>/dev/null; then echo "PASS: $1";
    else echo "FAIL: $1 (got: $(cat "$TDIR/apps-$3.json" 2>/dev/null | tr -d '\n '))"; fi
}

# --- v1 cases (all 11) ---
printf '1 3 5\n' > "$TDIR/in1"; run_prompt "$TDIR/in1" c01; check "c01 1 3 5" '"apps": ["freetube", "telegram", "vlc"]' c01
printf 'all\n' > "$TDIR/in2"; run_prompt "$TDIR/in2" c02; check "c02 all" '"apps": ["freetube", "whatsapp", "telegram", "spotify", "vlc", "libreoffice", "vscode", "discord", "gimp", "vile"]' c02
printf '\n' > "$TDIR/in3"; run_prompt "$TDIR/in3" c03; check "c03 empty" '"apps": []' c03
printf '99\n1 2\n' > "$TDIR/in4"; run_prompt "$TDIR/in4" c04; check "c04 99 then 1 2" '"apps": ["freetube", "whatsapp"]' c04
printf 'abc\n2\n' > "$TDIR/in5"; run_prompt "$TDIR/in5" c05; check "c05 abc then 2" '"apps": ["whatsapp"]' c05
printf 'ALL\n' > "$TDIR/in6"; run_prompt "$TDIR/in6" c06; check "c06 ALL" '"gimp"' c06
printf '2 2 3\n' > "$TDIR/in7"; run_prompt "$TDIR/in7" c07; check "c07 dedupe" '"apps": ["whatsapp", "telegram"]' c07
printf '0\n9\n' > "$TDIR/in8"; run_prompt "$TDIR/in8" c08; check "c08 0 then 9" '"apps": ["gimp"]' c08
printf '1,2\n3\n' > "$TDIR/in9"; run_prompt "$TDIR/in9" c09; check "c09 1,2 then 3" '"apps": ["telegram"]' c09
printf '1 2 6\n' > "$TDIR/in10"; run_prompt "$TDIR/in10" c10; check "c10 1 2 6" '"apps": ["freetube", "whatsapp", "libreoffice"]' c10
run_prompt /dev/null c11; check "c11 EOF" '"apps": []' c11

# --- NEW: no trailing newline (code §3.2) ---
printf '1 2' > "$TDIR/in12"; run_prompt "$TDIR/in12" c12; check "c12 no-newline '1 2' kept" '"apps": ["freetube", "whatsapp"]' c12
# --- NEW: glob expansion (F1) — cwd contains files named 3 and 7 ---
touch "$TDIR/cwd/3" "$TDIR/cwd/7"
printf '*\n' > "$TDIR/in13"; run_prompt "$TDIR/in13" c13
if grep -q "Not valid" "$TDIR/out-c13.txt" && grep -q '"apps": \[\]' "$TDIR/apps-c13.json"; then echo "PASS: c13 glob '*' rejected, none chosen";
else echo "FAIL: c13 glob (out: $(grep -o 'Not valid[^ ]*' "$TDIR/out-c13.txt" | head -1); apps: $(cat "$TDIR/apps-c13.json" | tr -d '\n '))"; fi
printf '[1-9]\n' > "$TDIR/in13b"; run_prompt "$TDIR/in13b" c13b
if grep -q '"apps": \[\]' "$TDIR/apps-c13b.json"; then echo "PASS: c13b glob '[1-9]' rejected"; else echo "FAIL: c13b glob apps: $(cat "$TDIR/apps-c13b.json" | tr -d '\n ')"; fi
rm -f "$TDIR/cwd/3" "$TDIR/cwd/7"
# --- NEW: integer wrap-around (F2) ---
printf '18446744073709551621\n4\n' > "$TDIR/in14"; run_prompt "$TDIR/in14" c14; check "c14 wrap 2^64+5 rejected then 4" '"apps": ["spotify"]' c14
# --- NEW: "a l l" must NOT select everything (F10) ---
printf 'a l l\n' > "$TDIR/in15"; run_prompt "$TDIR/in15" c15
if grep -q '"apps": \[\]' "$TDIR/apps-c15.json"; then echo "PASS: c15 'a l l' selects nothing"; else echo "FAIL: c15 'a l l' apps: $(cat "$TDIR/apps-c15.json" | tr -d '\n ')"; fi
# --- NEW: '  all  ' still works with surrounding spaces ---
printf '  all  \n' > "$TDIR/in16"; run_prompt "$TDIR/in16" c16; check "c16 '  all  ' works" '"gimp", "vile"' c16
# --- NEW: Vile is number 10; 11 is out of range ---
printf '10\n' > "$TDIR/in17"; run_prompt "$TDIR/in17" c17; check "c17 '10' picks Vile" '"apps": ["vile"]' c17
printf '11\n10\n' > "$TDIR/in18"; run_prompt "$TDIR/in18" c18; check "c18 11 rejected then 10" '"apps": ["vile"]' c18
if grep -q "Not valid" "$TDIR/out-c18.txt"; then echo "PASS: c18 '11' printed Not valid"; else echo "FAIL: c18 no Not valid line"; fi

# --- install_extra_apps: unknown ids (F3), shimmed fail, versions log (F9) ---
export VELTRIX_APPS_CHOICE_FILE="$TDIR/choice/install.json"
export VELTRIX_APPS_DESKTOP_DIR="$TDIR/desktop"
export VELTRIX_APPS_VERSIONS_FILE="$TDIR/choice/versions.log"
rm -f "$SHIM_LOG"; touch "$SHIM_LOG"
export SHIM_PACMAN_FAIL=0
( cd "$TDIR/cwd" && . "$TDIR/apps-block.sh" >/dev/null 2>&1
  install_extra_apps freetube whatsapp spotify discord 'bogus-id' "'; rm -rf /'" > "$TDIR/out-install.txt" 2>&1
  echo "rc=$?" >> "$TDIR/out-install.txt" )
echo "--- install: $(cat "$TDIR/choice/install.json" | tr -d '\n ')"
if grep -q "bogus-id" "$TDIR/out-install.txt" && grep -q "\[WARN\] Unknown extra app 'bogus-id'" "$TDIR/out-install.txt" \
   && grep -q "\[WARN\] Unknown extra app ''; rm -rf /'" "$TDIR/out-install.txt" \
   && ! grep -q '\[ok\] bogus-id' "$TDIR/out-install.txt" && ! grep -q '\[ok\] .*rm -rf' "$TDIR/out-install.txt" \
   && python3 -c "import json,sys; d=json.load(open('$TDIR/choice/install.json')); assert d['failed']==['bogus-id', \"'; rm -rf /'\"], d; print('json ok')"; then echo "PASS: install unknown ids marked failed, no false [ok], JSON valid";
else echo "FAIL: install unknown ids"; cat "$TDIR/out-install.txt"; fi
if grep -q "Installed 4 of 4 extra apps" "$TDIR/out-install.txt"; then echo "PASS: install count 4 of 4 (valid only)"; else echo "FAIL: install count line: $(grep Installed "$TDIR/out-install.txt")"; fi
if grep -q "discord 1.0-1" "$TDIR/choice/versions.log" && grep -q "com.spotify.Client" "$TDIR/choice/versions.log" && grep -q "io.freetubeapp.FreeTube" "$TDIR/choice/versions.log"; then echo "PASS: versions logged"; else echo "FAIL: versions log: $(cat "$TDIR/choice/versions.log" 2>/dev/null)"; fi

# --- Vile install: not picked = nothing installed; picked = binary +
# desktop file + icon + version log, deps + build driven via shims ---
export VELTRIX_APPS_CHOICE_FILE="$TDIR/choice/vile.json"
export VELTRIX_APPS_DESKTOP_DIR="$TDIR/desktop"
export VELTRIX_APPS_VERSIONS_FILE="$TDIR/choice/vile-versions.log"
export VELTRIX_VILE_BIN_DIR="$TDIR/vilebin"
export VELTRIX_VILE_ICON_DIR="$TDIR/icons"
rm -f "$SHIM_LOG"; touch "$SHIM_LOG"
( cd "$TDIR/cwd" && . "$TDIR/apps-block.sh" >/dev/null 2>&1
  install_extra_apps discord > "$TDIR/out-vile-nopick.txt" 2>&1; echo "rc=$?" >> "$TDIR/out-vile-nopick.txt" )
if [ ! -e "$TDIR/vilebin/vile" ] && [ ! -e "$TDIR/desktop/vile.desktop" ] && [ ! -e "$TDIR/icons/vile.png" ]; then
  echo "PASS: vile not picked = nothing Vile installed"
else echo "FAIL: vile leaked without being picked"; ls "$TDIR/vilebin" "$TDIR/desktop/vile.desktop" "$TDIR/icons" 2>/dev/null; fi
( cd "$TDIR/cwd" && . "$TDIR/apps-block.sh" >/dev/null 2>&1
  install_extra_apps vile > "$TDIR/out-vile.txt" 2>&1; echo "rc=$?" >> "$TDIR/out-vile.txt" )
if [ -x "$TDIR/vilebin/vile" ] && [ "$(stat -c %a "$TDIR/desktop/vile.desktop")" = "644" ] \
   && grep -q "^Exec=$TDIR/vilebin/vile$" "$TDIR/desktop/vile.desktop" \
   && grep -q "^Icon=vile$" "$TDIR/desktop/vile.desktop" \
   && grep -q "^StartupWMClass=vile$" "$TDIR/desktop/vile.desktop" \
   && [ -f "$TDIR/icons/vile.png" ] \
   && grep -q "vile 0.1.0 (v48)" "$TDIR/choice/vile-versions.log" \
   && grep -q "Installed 1 of 1 extra apps" "$TDIR/out-vile.txt" \
   && grep -q '"apps": \["vile"\]' "$TDIR/choice/vile.json" \
   && grep -q "pacman -S --noconfirm --needed cmake sqlite qt6-base qt6-webengine" "$SHIM_LOG" \
   && grep -q "cmake --build .* --target vile-qt" "$SHIM_LOG"; then
  echo "PASS: vile picked = binary + desktop + icon + version + deps + build"
else echo "FAIL: vile install"; cat "$TDIR/out-vile.txt"; echo "--- shim:"; cat "$SHIM_LOG"; echo "--- desktop:"; cat "$TDIR/desktop/vile.desktop" 2>/dev/null; echo "--- versions:"; cat "$TDIR/choice/vile-versions.log" 2>/dev/null; fi
if [ "$(stat -c %a "$TDIR/choice/install.json")" = "644" ]; then echo "PASS: apps.json mode 644"; else echo "FAIL: apps.json mode $(stat -c %a "$TDIR/choice/install.json")"; fi
if [ "$(stat -c %a "$TDIR/desktop/veltrix-whatsapp.desktop")" = "644" ]; then echo "PASS: .desktop mode 644"; else echo "FAIL: .desktop mode $(stat -c %a "$TDIR/desktop/veltrix-whatsapp.desktop" 2>/dev/null)"; fi

# --- install with a failing app: rc=0, failed surfaced, banner var set ---
export SHIM_PACMAN_FAIL=1
( cd "$TDIR/cwd" && . "$TDIR/apps-block.sh" >/dev/null 2>&1
  install_extra_apps vlc gimp > "$TDIR/out-installfail.txt" 2>&1; echo "rc=$?" >> "$TDIR/out-installfail.txt"
  echo "APPS_FAILED=${APPS_FAILED[*]}" >> "$TDIR/out-installfail.txt" )
if grep -q "rc=0" "$TDIR/out-installfail.txt" && grep -q "Installed 0 of 2" "$TDIR/out-installfail.txt" && grep -q "APPS_FAILED=vlc gimp" "$TDIR/out-installfail.txt"; then echo "PASS: all-fail rc=0, APPS_FAILED set"; else echo "FAIL: all-fail"; cat "$TDIR/out-installfail.txt"; fi
export SHIM_PACMAN_FAIL=0

# --- symlink refusal + guarded write (F4/F5) ---
export VELTRIX_APPS_CHOICE_FILE="$TDIR/choice/symlink.json"
echo "VICTIM-CONTENT" > "$TDIR/choice/victim.txt"
ln -s "$TDIR/choice/victim.txt" "$TDIR/choice/symlink.json"
( cd "$TDIR/cwd" && . "$TDIR/apps-block.sh" >/dev/null 2>&1
  printf '1\n' | ask_extra_apps > "$TDIR/out-symlink.txt" 2>&1; echo "rc=$?" >> "$TDIR/out-symlink.txt" )
if grep -q "rc=0" "$TDIR/out-symlink.txt" && grep -q "is a symlink — refusing" "$TDIR/out-symlink.txt" && [ "$(cat "$TDIR/choice/victim.txt")" = "VICTIM-CONTENT" ]; then
  echo "PASS: symlink refused, victim intact, prompt survived (rc=0)"
else echo "FAIL: symlink case"; cat "$TDIR/out-symlink.txt"; echo "victim: $(cat "$TDIR/choice/victim.txt")"; fi
# --- choice path is a directory (F4 proof from v1: must survive) ---
export VELTRIX_APPS_CHOICE_FILE="$TDIR/choice"
( cd "$TDIR/cwd" && . "$TDIR/apps-block.sh" >/dev/null 2>&1
  printf '1\n' | ask_extra_apps > "$TDIR/out-dirpath.txt" 2>&1; echo "rc=$?" >> "$TDIR/out-dirpath.txt"
  echo "SURVIVED" >> "$TDIR/out-dirpath.txt" )
if grep -q "SURVIVED" "$TDIR/out-dirpath.txt" && grep -q "rc=0" "$TDIR/out-dirpath.txt"; then echo "PASS: unwritable choice path survives (F4)"; else echo "FAIL: dirpath case"; cat "$TDIR/out-dirpath.txt"; fi
# --- Vile under sudo (Nov 14 sweep #2) ---
# install.sh invoked as `sudo ./install.sh` runs as root, but cmake runs
# as the user (apps_run_user). The build dir MUST be user-owned: a plain
# mktemp is root-owned and the user's cmake cannot write into it, so
# every Vile build failed at configure. Simulate sudo: this harness runs
# as root, and run_user drops to `nobody` (setpriv) the way the real
# run_user drops to $REAL_USER.
export VELTRIX_APPS_CHOICE_FILE="$TDIR/choice/vile-sudo.json"
export VELTRIX_APPS_DESKTOP_DIR="$TDIR/desktop"
export VELTRIX_APPS_VERSIONS_FILE="$TDIR/choice/vile-sudo-versions.log"
export VELTRIX_VILE_BIN_DIR="$TDIR/vilebin-sudo"
export VELTRIX_VILE_ICON_DIR="$TDIR/icons-sudo"
mkdir -p "$TDIR/vilebin-sudo" "$TDIR/icons-sudo"
# The harness dir is mktemp 0700 root-owned: nobody must be able to reach
# the shim binaries (and the cwd) or the simulation fails on traversal,
# not on the build dir — which would prove nothing.
chmod 755 "$TDIR" "$TDIR/bin" "$TDIR/cwd"
rm -f "$SHIM_LOG"; touch "$SHIM_LOG"; chmod 666 "$SHIM_LOG"
run_user() { setpriv --reuid=nobody --regid=nogroup --clear-groups "$@"; }
export -f run_user 2>/dev/null || true
# Control first: the ORIGINAL block (plain mktemp, fix reverted) must FAIL
# the same way the Dell did — nobody's cmake cannot write a root-owned dir.
sed 's/build="$(apps_run_user mktemp -d \/tmp\/vile-build.XXXXXX)"/build="$(mktemp -d \/tmp\/vile-build.XXXXXX)"/' \
    "$TDIR/apps-block.sh" > "$TDIR/apps-block-orig.sh"
bash -n "$TDIR/apps-block-orig.sh" || { echo "FAIL: orig block syntax"; exit 1; }
( cd "$TDIR/cwd" && . "$TDIR/apps-block-orig.sh" >/dev/null 2>&1
  install_extra_apps vile > "$TDIR/out-vile-sudo-control.txt" 2>&1; echo "rc=$?" >> "$TDIR/out-vile-sudo-control.txt" )
if [ ! -e "$TDIR/vilebin-sudo/vile" ] && grep -q "build finished but.*vile-qt.*missing\|cmake configure failed" "$TDIR/out-vile-sudo-control.txt" \
   && grep -q "owner:root" "$SHIM_LOG"; then
  echo "PASS: control — root-owned build dir fails the user cmake (the bug as found)"
else echo "FAIL: control — original block unexpectedly installed Vile under sudo"; cat "$TDIR/out-vile-sudo-control.txt"; echo "--- shim:"; cat "$SHIM_LOG"; fi
# Then the FIXED block, same simulation, must install Vile.
rm -f "$SHIM_LOG"; touch "$SHIM_LOG"; chmod 666 "$SHIM_LOG"
( cd "$TDIR/cwd" && . "$TDIR/apps-block.sh" >/dev/null 2>&1
  install_extra_apps vile > "$TDIR/out-vile-sudo.txt" 2>&1; echo "rc=$?" >> "$TDIR/out-vile-sudo.txt" )
if [ -x "$TDIR/vilebin-sudo/vile" ] && grep -q "Installed 1 of 1 extra apps" "$TDIR/out-vile-sudo.txt" \
   && grep -q "owner:nobody" "$SHIM_LOG"; then
  echo "PASS: vile under sudo installs (build dir user-owned)"
else echo "FAIL: vile under sudo"; cat "$TDIR/out-vile-sudo.txt"; echo "--- shim:"; cat "$SHIM_LOG"; fi
unset -f run_user 2>/dev/null || true
echo "ALL PROMPT TESTS DONE"
