#!/usr/bin/env python3
"""wordscan-whitelist-probe — the first clean scan on a fresh install must
whitelist the song, not crash (Nov 14 sweep #6).

`save_whitelist` used to write the JSON straight to
~/.local/share/veltrix/halal-audio/whitelist.json, a directory nothing
creates — so the first CLEAN scan died with FileNotFoundError instead of
recording the song. The fix creates the parents first.

Runs with plain python3: no faster-whisper, no model, no audio decoding —
`transcribe` is stubbed, because the bug is in the whitelist write, not
the transcription. A negative control proves the probe catches the bug:
the old one-liner (`Path.write_text` with no mkdir) fails on the same
fresh path.

Usage: python3 scripts/dev/wordscan-whitelist-probe.py
Exit 0 = all pass.
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "voiceonly"))
import wordscan as ws

failures = []


def check(name, cond, extra=""):
    print(f"{'PASS' if cond else 'FAIL'}: {name}" + (f" — {extra}" if extra else ""))
    if not cond:
        failures.append(name)


def main():
    # 1. save_whitelist into a never-created nested dir (fresh-install shape).
    d = Path(tempfile.mkdtemp()) / "veltrix" / "halal-audio"
    p = d / "whitelist.json"
    assert not d.exists()
    ws.save_whitelist(p, {"abc": {"filename": "x.mp3", "added": "now"}})
    check("save_whitelist creates missing parents",
          json.loads(p.read_text()) == {"abc": {"filename": "x.mp3", "added": "now"}})

    # 2. Negative control: the old one-liner fails on the same shape.
    d2 = Path(tempfile.mkdtemp()) / "veltrix" / "halal-audio" / "whitelist.json"
    try:
        d2.write_text(json.dumps({}), encoding="utf-8")
        check("control: plain write_text fails without the dir", False,
              "write unexpectedly succeeded")
    except FileNotFoundError:
        check("control: plain write_text fails without the dir", True)

    # 3. Full scan() path, transcription stubbed: a clean song on a fresh
    #    install is whitelisted instead of crashing.
    ws.transcribe = lambda path, model: "hello world, clean lyrics"
    audio = Path(tempfile.mkdtemp()) / "song.mp3"
    audio.write_bytes(b"\x00" * 100)
    wl = Path(tempfile.mkdtemp()) / "fresh" / "dir" / "whitelist.json"
    bl = Path(tempfile.mkdtemp()) / "blacklist.txt"
    bl.write_text("shit\n", encoding="utf-8")
    res = ws.scan(audio, blacklist_path=bl, whitelist_path=wl)
    check("scan() clean on fresh install whitelists",
          res.get("verdict") == "clean" and res.get("whitelisted") is True
          and res.get("scanned") is True, str(res))
    check("scan() wrote the whitelist file",
          wl.is_file() and bool(json.loads(wl.read_text())))

    # 4. A flagged song still never whitelists (the fix must not change that).
    ws.transcribe = lambda path, model: "this song says shit out loud"
    wl2 = Path(tempfile.mkdtemp()) / "fresh2" / "whitelist.json"
    res2 = ws.scan(audio, blacklist_path=bl, whitelist_path=wl2)
    check("flagged song is not whitelisted",
          res2.get("verdict") == "flagged" and not wl2.exists(), str(res2))

    print("TEST: ALL PASSED" if not failures else f"TEST: {len(failures)} FAILURE(S)")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
