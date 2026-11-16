#!/usr/bin/env bash
# wordscan-install-probe — `download-models` installs faster-whisper first
# (Nov 14 sweep #5).
#
#   bash scripts/dev/wordscan-install-probe.sh
#
# End to end, in a throwaway HOME: a fresh venv with NO faster-whisper
# (the fresh-install state), then `download-models`, then `check`, then a
# REAL scan of one second of silence. The scan matters: it loads the tiny
# model and decodes the audio through av, so it proves the pinned
# `av==15.1.0` actually works with faster-whisper 1.2.1 (an unpinned av
# >= 19 crashes in av.open() on a kwarg faster-whisper still passes).
#
# Slow by design: pip-installing faster-whisper + its wheels and
# downloading the ~75 MB tiny model takes minutes on first run. Nothing
# here touches the real HOME — everything lives under a mktemp dir on the
# main disk (NOT /tmp: on this VM /tmp is a small tmpfs and the venv +
# wheels + model do not fit in it).
set -u
FORK="$(cd "$(dirname "$0")/../.." && pwd)"
HA="$FORK/bin/veltrix-halal-audio"
TMP="$(mktemp -d /home/hatch/wordscan-probe.XXXXXX)"
export HOME="$TMP/home"
mkdir -p "$HOME"
VENV="$HOME/.local/share/veltrix/venv"
fail=0
check() { # check <name> <command...>
    local name="$1"; shift
    if "$@"; then echo "PASS: $name"; else echo "FAIL: $name"; fail=1; fi
}

python3 -m venv "$VENV" || { echo "FAIL: could not create test venv"; exit 1; }

echo "--- 0. fresh venv: faster-whisper is missing (the bug as found) ---"
"$VENV/bin/python" -c "import faster_whisper" 2>/dev/null \
    && { echo "FAIL: test venv already has faster-whisper"; exit 1; }
echo "PASS: test venv starts without faster-whisper"
python3 "$HA" check > "$TMP/check-before.json"
python3 -c "import json,sys; d=json.load(open('$TMP/check-before.json')); sys.exit(0 if d['faster_whisper_installed'] is False else 1)" \
    && echo "PASS: check reports faster-whisper missing before install" \
    || { echo "FAIL: check reports faster-whisper missing before install"; fail=1; }

echo "--- 1. download-models installs faster-whisper, then the model ---"
python3 "$HA" download-models > "$TMP/download.log" 2> "$TMP/download.err"
rc=$?
check "download-models exits 0 (rc=$rc)" test "$rc" -eq 0
grep -q "whisper tiny model downloaded" "$TMP/download.log" \
    && echo "PASS: tiny model downloaded" \
    || { echo "FAIL: tiny model downloaded"; fail=1; }
"$VENV/bin/python" -c "import faster_whisper; print(faster_whisper.__version__)" > "$TMP/fw-version.txt" 2>/dev/null \
    && echo "PASS: faster-whisper imports in the venv ($(cat "$TMP/fw-version.txt"))" \
    || { echo "FAIL: faster-whisper imports in the venv"; fail=1; }
"$VENV/bin/python" -c "import av; print(av.__version__)" > "$TMP/av-version.txt" 2>/dev/null \
    && echo "PASS: av imports in the venv ($(cat "$TMP/av-version.txt"))" \
    || { echo "FAIL: av imports in the venv"; fail=1; }

echo "--- 2. check now reports the scanner ready ---"
python3 "$HA" check > "$TMP/check-after.json"
python3 -c "import json,sys; d=json.load(open('$TMP/check-after.json')); sys.exit(0 if d['faster_whisper_installed'] and d['whisper_model_cached'] else 1)" \
    && echo "PASS: check reports faster-whisper installed + model cached" \
    || { echo "FAIL: check reports faster-whisper installed + model cached"; fail=1; }

echo "--- 3. a real scan: 1 s of silence through the tiny model + av ---"
python3 - "$TMP/silence.wav" <<'PY'
import sys, wave
w = wave.open(sys.argv[1], "wb")
w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"\x00\x00" * 16000)
w.close()
PY
python3 "$HA" scan "$TMP/silence.wav" > "$TMP/scan.json" 2> "$TMP/scan.err"
rc=$?
check "scan of silence exits 0 (rc=$rc)" test "$rc" -eq 0
python3 -c "import json,sys; d=json.load(open('$TMP/scan.json')); sys.exit(0 if d.get('verdict')=='clean' else 1)" \
    && echo "PASS: silence scans clean (real transcribe ran)" \
    || { echo "FAIL: silence scans clean"; cat "$TMP/scan.err" | tail -5; fail=1; }

echo "--- 4. download-models again: idempotent, no reinstall ---"
python3 "$HA" download-models > "$TMP/download2.log" 2> "$TMP/download2.err"
check "second download-models exits 0 (rc=$?)" test "$?" -eq 0

rm -rf "$TMP"
if [ "$fail" -eq 0 ]; then echo "TEST: ALL PASSED"; else echo "TEST: FAILURE(S)"; fi
exit "$fail"
