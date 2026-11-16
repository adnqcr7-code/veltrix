#!/usr/bin/env python3
"""WordScan: the words half of VELTRIX's Halal Audio filter.

What it does
------------
Fast, on-device check of a song's words against a blacklist.

1. Hash the audio file (SHA-256) and check the local whitelist FIRST.
   If the song is already on the whitelist, the scan is SKIPPED and it
   plays instantly -- no speech-to-text, no waiting, no cost.
2. If it is not whitelisted, transcribe the words with a small on-device
   speech-to-text model (faster-whisper "tiny", CPU, int8 -- the fastest
   accurate option that needs no GPU, no internet, no API key).
3. Check the transcribed words against blacklist.txt (one word or phrase
   per line, editable by the user). Matching is case-insensitive and
   word-boundary aware for single words, so "class" never matches "ass".
4. If a blacklisted word is found, the result is "flagged" -- the player
   shows "This is haram" and lets the user play it anyway if they choose.
   Flagged songs are NEVER added to the whitelist.
   If no blacklisted word is found, the song is added to the whitelist
   (keyed by the hash of the audio) so it is never scanned again.

This is the "easy" half of the Halal Audio filter. The other half is
VoiceOnly (voiceonly.py), which removes the instruments and keeps the
voice. Together: vocals only + clean words.

Run it with the faster-whisper venv:
    ~/workspace/tools/fwhisper-venv/bin/python wordscan.py <audio-file>

CLI output is one JSON object on stdout, e.g.:
    {"verdict": "clean", "whitelisted": true, "scanned": false, ...}
    {"verdict": "flagged", "words": ["shit"], "whitelisted": false, ...}

The halal rule this enforces is: warn, do not block. The user decides.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def _sanitize_proxy_env() -> None:
    """Some sandboxes set no_proxy with bracketed IPv6 entries ([::1])
    that httpx (used by huggingface_hub inside faster-whisper) cannot
    parse, failing with 'Invalid port'. Replace them with plain entries.
    Harmless on a normal machine -- it only touches malformed values."""
    for key in ("no_proxy", "NO_PROXY"):
        value = os.environ.get(key, "")
        if "[" in value:
            parts = []
            for entry in value.split(","):
                entry = entry.strip()
                if not entry:
                    continue
                if entry.startswith("[") and entry.endswith("]"):
                    entry = entry[1:-1]
                parts.append(entry)
            os.environ[key] = ",".join(parts)


_sanitize_proxy_env()

HERE = Path(__file__).resolve().parent
DEFAULT_BLACKLIST = HERE / "blacklist.txt"
DEFAULT_WHITELIST = HERE / "whitelist.json"
DEFAULT_MODEL = "tiny"


def audio_hash(path: Path) -> str:
    """SHA-256 of the audio file bytes. Same song, same hash, even if renamed."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_blacklist(path: Path) -> list[str]:
    """One word or phrase per line. Lines starting with # are comments."""
    words: list[str] = []
    if not path.is_file():
        return words
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip().lower()
        if not line or line.startswith("#"):
            continue
        words.append(line)
    return words


def load_whitelist(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_whitelist(path: Path, data: dict) -> None:
    # The whitelist dir (~/.local/share/veltrix/halal-audio/) is created
    # by nothing else: on a fresh install the first CLEAN scan crashed
    # here (FileNotFoundError) instead of recording the song, so the
    # scan that should have whitelisted it reported a failure instead.
    # Create the parents first; a missing dir is normal, not an error.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def find_blacklisted(text: str, blacklist: list[str]) -> list[str]:
    """Return the blacklisted words/phrases found in the text.

    Single words match on word boundaries (so 'class' never matches 'ass').
    Multi-word phrases match as a substring. Case-insensitive.
    """
    found: list[str] = []
    lowered = text.lower()
    for word in blacklist:
        if " " in word:
            if word in lowered:
                found.append(word)
        else:
            if re.search(r"\b" + re.escape(word) + r"\b", lowered):
                found.append(word)
    return found


def transcribe(path: Path, model_name: str) -> str:
    """Transcribe with faster-whisper. Loaded lazily, only when a scan runs."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError(
            "faster-whisper is not installed in this Python. "
            "Run with the venv: ~/workspace/tools/fwhisper-venv/bin/python wordscan.py <file>"
        )
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(str(path), beam_size=1, vad_filter=True)
    parts = [seg.text for seg in segments]
    return " ".join(parts).strip()


def scan(
    path: Path,
    blacklist_path: Path = DEFAULT_BLACKLIST,
    whitelist_path: Path = DEFAULT_WHITELIST,
    model_name: str = DEFAULT_MODEL,
    force: bool = False,
    no_whitelist: bool = False,
) -> dict:
    """Scan one audio file. Returns a JSON-able result dict."""
    if not path.is_file():
        return {"verdict": "error", "error": f"File not found: {path}"}

    file_hash = audio_hash(path)
    whitelist = load_whitelist(whitelist_path)

    if not force and file_hash in whitelist:
        entry = whitelist[file_hash]
        return {
            "verdict": "clean",
            "whitelisted": True,
            "scanned": False,
            "reason": "Already on the whitelist -- scan skipped.",
            "hash": file_hash,
            "filename": path.name,
            "whitelisted_as": entry.get("filename", path.name),
            "words": [],
        }

    blacklist = load_blacklist(blacklist_path)
    try:
        text = transcribe(path, model_name)
    except Exception as exc:  # noqa: BLE001 - surface a useful local-app error
        return {"verdict": "error", "error": str(exc), "hash": file_hash, "filename": path.name}

    found = find_blacklisted(text, blacklist)

    if found:
        return {
            "verdict": "flagged",
            "whitelisted": False,
            "scanned": True,
            "reason": "Blacklisted word(s) found. This is haram -- the user may still play it if they choose.",
            "hash": file_hash,
            "filename": path.name,
            "words": found,
            "text": text,
        }

    if not no_whitelist:
        whitelist[file_hash] = {
            "filename": path.name,
            "added": datetime.now(timezone.utc).isoformat(),
        }
        save_whitelist(whitelist_path, whitelist)

    return {
        "verdict": "clean",
        "whitelisted": True,
        "scanned": True,
        "reason": "No blacklisted words found. Added to the whitelist.",
        "hash": file_hash,
        "filename": path.name,
        "words": [],
        "text": text,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Halal Audio word scan: fast blacklist check + whitelist.")
    parser.add_argument("audio", type=Path, help="Audio (or video) file to scan.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Whisper model size (default: tiny, fastest).")
    parser.add_argument("--blacklist", type=Path, default=DEFAULT_BLACKLIST, help="Blacklist file (default: blacklist.txt).")
    parser.add_argument("--whitelist", type=Path, default=DEFAULT_WHITELIST, help="Whitelist JSON (default: whitelist.json).")
    parser.add_argument("--force", action="store_true", help="Re-scan even if the song is already whitelisted.")
    parser.add_argument("--no-whitelist", action="store_true", help="Do not add a clean song to the whitelist.")
    args = parser.parse_args()

    result = scan(
        args.audio,
        blacklist_path=args.blacklist,
        whitelist_path=args.whitelist,
        model_name=args.model,
        force=args.force,
        no_whitelist=args.no_whitelist,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("verdict") in ("clean", "flagged") else 1)


if __name__ == "__main__":
    main()
