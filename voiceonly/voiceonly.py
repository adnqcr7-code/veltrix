#!/usr/bin/env python3
"""VoiceOnly: a small local web tool for extracting vocals from songs.

Default mode is intentionally lightweight: FFmpeg center-channel extraction.
Optional Demucs mode is available when the user installs Demucs separately.
"""

from __future__ import annotations

import argparse
import html
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
WORK = ROOT / "work"
MAX_BYTES = int(os.environ.get("VOICEONLY_MAX_MB", "512")) * 1024 * 1024
ALLOWED_EXTENSIONS = {
    ".mp3",
    ".wav",
    ".flac",
    ".m4a",
    ".ogg",
    ".opus",
    ".aac",
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
}


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def safe_filename(value: str) -> str:
    value = Path(value).name
    value = "".join(ch for ch in value if ch.isalnum() or ch in " ._-()[]")
    return value[:120] or "uploaded-audio"


def send_json(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def run_fast_filter(input_path: Path, output_path: Path) -> None:
    """Extract the stereo center with a small FFmpeg filter graph.

    Many commercial mixes put lead vocals in the stereo center. This is much
    faster and lighter than an AI separator, but it is intentionally described
    as approximate because centered instruments may remain too.
    """
    filter_graph = (
        "aformat=channel_layouts=stereo,"
        "pan=mono|c0=0.5*c0+0.5*c1,"
        "highpass=f=80,lowpass=f=12000,"
        "acompressor=threshold=-18dB:ratio=2:attack=20:release=200,"
        "volume=1.35"
    )
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-filter_complex",
        f"[0:a]{filter_graph}[vocals]",
        "-map",
        "[vocals]",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        str(output_path),
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)


def run_demucs(input_path: Path, job_dir: Path, output_path: Path) -> None:
    """Use an optional local Demucs installation for stronger separation."""
    demucs = shutil.which("demucs")
    if demucs:
        command = [demucs]
    else:
        command = [sys.executable, "-m", "demucs"]
    command += ["--two-stems=vocals", "-n", "htdemucs", "--out", str(job_dir), str(input_path)]
    subprocess.run(command, check=True, capture_output=True, text=True)

    candidates = list(job_dir.rglob("vocals.wav")) + list(job_dir.rglob("vocals.mp3"))
    if not candidates:
        raise RuntimeError("Demucs finished but no vocals stem was found.")

    source = candidates[0]
    convert = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        str(output_path),
    ]
    subprocess.run(convert, check=True, capture_output=True, text=True)


def cleanup_old_jobs() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - 24 * 60 * 60
    for path in WORK.iterdir():
        if path.is_dir() and path.stat().st_mtime < cutoff:
            shutil.rmtree(path, ignore_errors=True)


class VoiceOnlyHandler(BaseHTTPRequestHandler):
    server_version = "VoiceOnly/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[VoiceOnly] {fmt % args}")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Mode")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/capabilities":
            send_json(
                self,
                200,
                {
                    "ok": True,
                    "ffmpeg": command_exists("ffmpeg"),
                    "demucs": command_exists("demucs") or self._demucs_module_available(),
                    "max_mb": MAX_BYTES // (1024 * 1024),
                },
            )
            return

        if path.startswith("/api/download/"):
            job_id = path.rsplit("/", 1)[-1]
            if not job_id.isalnum():
                send_json(self, 400, {"ok": False, "error": "Invalid download id."})
                return
            output = WORK / job_id / "voiceonly.mp3"
            if not output.is_file():
                send_json(self, 404, {"ok": False, "error": "That result is no longer available."})
                return
            data_length = output.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(data_length))
            self.send_header("Content-Disposition", 'attachment; filename="voiceonly.mp3"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with output.open("rb") as stream:
                shutil.copyfileobj(stream, self.wfile, length=1024 * 1024)
            return

        if path in ("/", "/index.html"):
            self._serve_static("index.html", "text/html; charset=utf-8")
            return

        send_json(self, 404, {"ok": False, "error": "Not found."})

    def do_POST(self) -> None:
        if urllib.parse.urlparse(self.path).path != "/api/isolate":
            send_json(self, 404, {"ok": False, "error": "Not found."})
            return

        if not command_exists("ffmpeg"):
            send_json(self, 500, {"ok": False, "error": "FFmpeg is not installed. On Arch, run: sudo pacman -S ffmpeg"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0:
            send_json(self, 400, {"ok": False, "error": "No audio file was uploaded."})
            return
        if content_length > MAX_BYTES:
            send_json(self, 413, {"ok": False, "error": f"File is too large. The limit is {MAX_BYTES // (1024 * 1024)} MB."})
            return

        raw_name = urllib.parse.unquote(self.headers.get("X-Filename", "uploaded-audio"))
        filename = safe_filename(raw_name)
        extension = Path(filename).suffix.lower()
        if extension not in ALLOWED_EXTENSIONS:
            send_json(self, 415, {"ok": False, "error": "Unsupported file type. Use MP3, WAV, FLAC, M4A, OGG, OPUS, AAC, MP4, WEBM, MOV, or MKV."})
            return

        mode = self.headers.get("X-Mode", "fast").lower()
        if mode not in {"fast", "demucs"}:
            send_json(self, 400, {"ok": False, "error": "Unknown processing mode."})
            return
        if mode == "demucs" and not (command_exists("demucs") or self._demucs_module_available()):
            send_json(self, 400, {"ok": False, "error": "Demucs is not installed. Use Fast mode or install Demucs from the README."})
            return

        job_id = uuid.uuid4().hex
        job_dir = WORK / job_id
        job_dir.mkdir(parents=True, exist_ok=False)
        input_path = job_dir / f"input{extension}"
        output_path = job_dir / "voiceonly.mp3"

        try:
            remaining = content_length
            with input_path.open("wb") as output:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise RuntimeError("The upload ended before the full file arrived.")
                    output.write(chunk)
                    remaining -= len(chunk)

            if mode == "fast":
                run_fast_filter(input_path, output_path)
            else:
                run_demucs(input_path, job_dir, output_path)

            input_path.unlink(missing_ok=True)
            send_json(
                self,
                200,
                {
                    "ok": True,
                    "id": job_id,
                    "mode": mode,
                    "filename": filename,
                    "download_url": f"/api/download/{job_id}",
                    "size_bytes": output_path.stat().st_size,
                },
            )
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or "").strip().splitlines()[-1:] or ["FFmpeg could not process this file."]
            shutil.rmtree(job_dir, ignore_errors=True)
            send_json(self, 422, {"ok": False, "error": detail[0]})
        except Exception as error:  # noqa: BLE001 - return a useful local-app error
            shutil.rmtree(job_dir, ignore_errors=True)
            send_json(self, 500, {"ok": False, "error": str(error) or "Processing failed."})

    def _demucs_module_available(self) -> bool:
        result = subprocess.run(
            [sys.executable, "-c", "import demucs"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0

    def _serve_static(self, filename: str, content_type: str) -> None:
        file_path = STATIC / filename
        if not file_path.is_file():
            send_json(self, 500, {"ok": False, "error": "The web interface is missing."})
            return
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fast, local vocals-focused audio filter")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; default is local-only")
    parser.add_argument("--port", type=int, default=8765, help="Web port; default is 8765")
    args = parser.parse_args()

    if not command_exists("ffmpeg"):
        print("Warning: FFmpeg is missing. Install it with: sudo pacman -S ffmpeg", file=sys.stderr)
    cleanup_old_jobs()
    server = ThreadingHTTPServer((args.host, args.port), VoiceOnlyHandler)
    print(f"VoiceOnly is running at http://{args.host}:{args.port}")
    print("Default mode: Fast / low RAM (FFmpeg center-vocal filter)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping VoiceOnly.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
