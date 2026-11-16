# VoiceOnly — Linux / Arch

A small local browser tool that reduces drums, instruments, and accompaniment while keeping the singing voice as much as possible.

## What it does

The default **Fast / low RAM** mode uses FFmpeg to extract the stereo center channel and applies a light vocal-focused filter. It needs no AI model, no GPU, no database, and no internet connection after the files are installed.

This is intentionally an approximation. It works best when the lead vocal is mixed in the center of a stereo song. Centered instruments, backing vocals, or reverb may remain.

An optional **Enhanced — Demucs AI** mode appears if Demucs is installed. It usually separates sources better but is slower and uses substantially more RAM/disk, so it is not the default.

## Install on Arch Linux

```bash
sudo pacman -S --needed python ffmpeg
```

Then run the tool:

```bash
chmod +x run.sh voiceonly.py
./run.sh
```

Open **http://127.0.0.1:8765** in your browser.

Stop it with `Ctrl+C`.

## Options

```bash
# Choose another port
./run.sh --port 9000

# Allow another device on your local network to connect (use only on a trusted network)
./run.sh --host 0.0.0.0 --port 8765
```

The default upload limit is 512 MB. Change it with:

```bash
VOICEONLY_MAX_MB=1024 ./run.sh
```

## Optional stronger separation

Only install this if you want the enhanced mode and accept higher RAM use:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install demucs
./run.sh
```

Demucs downloads a model the first time it runs. The fast mode remains available and does not load that model.

## Supported input types

MP3, WAV, FLAC, M4A, OGG, OPUS, AAC, MP4, WEBM, MOV, and MKV. The result is an MP3 named `voiceonly.mp3`.

## Privacy

The server binds to `127.0.0.1` by default. Files are processed locally and temporary job folders are automatically removed after 24 hours. Use `--host 0.0.0.0` only when you intentionally want LAN access.
