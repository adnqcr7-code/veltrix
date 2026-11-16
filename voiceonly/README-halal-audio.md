# Halal Audio filter — how it works

Two halves. Both run on the device, no internet, no API key, no GPU.

## Half 1 — VoiceOnly (`voiceonly.py`): the music part

Removes the instruments and keeps the voice. Fast mode (default) uses
FFmpeg to keep only the stereo center channel (where the voice lives) and
a light vocal filter. No AI model, no waiting. Optional Demucs AI mode
exists for better separation but is slower and heavier, so it is not the
default. Run it: `./run.sh`, then open http://127.0.0.1:8765.

Honest limit: drums and bass are also in the center, so some remain.
It is "mostly voice", not "only voice".

## Half 2 — WordScan (`wordscan.py`): the words part

Scans the song's words as fast as possible and checks them against a
blacklist. Built and tested Nov 12, 2026.

```
~/workspace/tools/fwhisper-venv/bin/python wordscan.py <audio-file>
```

- **Whitelist first.** The file is hashed (SHA-256). If that hash is
  already in `whitelist.json`, the scan is skipped and the song plays
  instantly (0.075s in testing -- no model load, no cost).
- **Scan.** If it is not whitelisted, the words are transcribed with
  faster-whisper "tiny" (CPU, int8, on-device, ~4.6s for a short clip
  including model load) and checked against `blacklist.txt`.
- **Clean:** no blacklisted word found. The song is added to the
  whitelist (keyed by audio hash, so a rename does not re-trigger a
  scan) and plays.
- **Flagged:** a blacklisted word was found. The result says "This is
  haram" and lists the words -- but the song is NEVER added to the
  whitelist and it is NOT blocked. The user may still play it if they
  choose. Warn, do not block.

## Files

- `voiceonly.py` / `run.sh` / `static/` -- VoiceOnly vocal-only tool.
- `wordscan.py` -- the word-scan module (this file's companion).
- `blacklist.txt` -- editable blacklist, one word or phrase per line.
  Single words match on word boundaries ("class" never matches "ass").
- `whitelist.json` -- created automatically; clean songs, keyed by hash.
- `work/` -- VoiceOnly job folders (auto-cleaned after 24h).

## Tested Nov 12, 2026

- Clean speech ("I believe in the light...") -> clean, whitelisted.
  Second run on the same file -> whitelist hit, 0.075s, no scan.
- Speech with "shit" and "hell" -> flagged, words ["shit", "hell"],
  NOT whitelisted. Transcription matched what was spoken.
- The exact VoiceOnly FFmpeg filter was run on a stereo test file:
  exit 0, valid 3.0s mono MP3 out.

## Still to do (integration)

Wire both halves into the system's music playback: on play, check the
whitelist, run the word scan if needed, warn if flagged, and play the
VoiceOnly vocal-only version. The halal critic must verify the
"still halal" claim in writing before this ships.
