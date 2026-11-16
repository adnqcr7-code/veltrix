# VoiceOnly — vendored, verbatim (Adnan's tool)

The files in this directory (`voiceonly.py`, `run.sh`, `README.md`,
`static/`) are Adnan's own VoiceOnly vocal-only tool, copied verbatim
into the fork so the shipped tree carries it. **Do not edit them here.**
Upstream is `~/workspace/veltrix/voiceonly/` (original tarball
`~/workspace/user/files/VoiceOnly-Arch.tar.gz`); if Adnan changes the
tool, re-copy it and re-verify the checksums below.

Vendored 2026-11-13 (v2 integration). SHA-256 at vendoring time:

- `voiceonly.py` 4b9ce865d38753b05508c2e92adec3ed61a52efc781d9c81a0bd95f1e0812c32
- `run.sh` ea66350437694390cd8639a658d88f40128b2244c2a528067a35a0f219f39cb7
- `README.md` 37f8d257e679893e8b416a519f473e2877aa98e1818fbb1ecce784510049ba7d
- `static/index.html` b58b96c0be3ff1e40ad176e40ed56dcd60d4bfa6b22e99681768131b7881852b

What the fork uses from it (without modifying it):

- `run_fast_filter(input, output)` — imported by
  `bin/veltrix-halal-audio` (the Audio Filter orchestrator) for both
  playback rendering and the "Save filtered copy…" export. Fast mode
  (default): FFmpeg centre extraction `pan=mono|c0=0.5*c0+0.5*c1` +
  highpass 80 Hz + lowpass 12000 Hz + light compressor + volume 1.35
  → mono MP3 192k. No AI model, no GPU, no internet, low RAM.
- `run_demucs(input, job_dir, output)` — the optional best-quality
  mode, only via an explicit `--vocals demucs`, only when Demucs is
  installed and its weights are already cached (the orchestrator
  checks first; VoiceOnly itself would download on first run, and the
  fork does not let that happen silently).
- `run.sh` / the web UI on 127.0.0.1:8765 — shipped for users who want
  the standalone tool; the desktop integration does NOT need the
  server running (it imports the functions directly).

## The word-scan half — HANDED OVER 2026-11-12, 21:57 EST

The parent built and tested `wordscan.py` + `blacklist.txt` +
`README-halal-audio.md` and handed them over; they are vendored here
verbatim, same rule as above — **do not edit them here**. SHA-256 at
vendoring time:

- `wordscan.py` e580d858d5677c10855fd951d21ae6631f6af2082d8f28b4d8fb4fc62d7be39b
- `blacklist.txt` d2aa37137ab41cfe7eb23531d736d26af465b9fca47554f92b8eb5ea0c327be1
- `README-halal-audio.md` 2a27b6b044721e408e9fdde223bf037dab19662f9c991c18484a2a1df6deb3b9

What the fork uses from it:

- The CLI contract `wordscan.py <audio> [--model tiny] [--blacklist P]
  [--whitelist P]` → one JSON object on stdout (verdict clean/flagged,
  whitelist-first, faster-whisper tiny, blacklist word-boundary match).
  Invoked by `bin/veltrix-halal-audio` through its adapter; the
  orchestrator never re-implements scanning, hashing, or whitelisting.
- `blacklist.txt` — the shipped word list (35 words, English). The
  user-editable copy lives at
  `~/.local/share/veltrix/halal-audio/blacklist.txt` when present.

Deliberately NOT vendored here: `whitelist.json` / `work/` — the
whitelist is per-user runtime state (auto-created on the first clean
scan at `~/.local/share/veltrix/halal-audio/whitelist.json`); the
parent's test whitelist (one hash, the clean test file) is test data,
not shipped state. `work/` is the standalone web tool's job dir.
