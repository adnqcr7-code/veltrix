#!/usr/bin/env python3
"""no-telemetry-audit — fail if VELTRIX ships a new phone-home.

VELTRIX is a halal, privacy-first desktop: it must not send user data
to anyone without the user knowing and choosing it. This script is the
enforcement: it scans the fork's shipped source for (a) every http(s)
URL literal and (b) every network call site (urlopen / curl / fetch /
WebSocket / ...), and fails unless each one is in the allowlist below
with a human-written reason.

Rules for the allowlist — an entry is legitimate only if it is one of:
  * the update check (GitHub API, once a day, no user data),
  * a user-initiated action (bug report, leak-check),
  * a functional lookup the user asked for by using the feature
    (weather, album art, installer timezone suggestion),
  * install-time package fetching (pacman, repo signing key),
  * loopback only (Ollama on localhost), or
  * not fetched at all (doc comments, XML namespaces, test fixtures).

Adding a new outbound call means adding a line HERE first, with the
reason — and the reviewer who merges it is the one who decided the
user would accept it. Analytics, crash reporting, usage tracking and
advertising are never allowed: there is no entry for them to be added
under.

What is NOT scanned: .md docs (they are not executed), node_modules /
@girs / build / target / __pycache__ (vendored or generated), and
files under scripts/dev, scripts/ci, */tests*, */fixtures* and
*/examples* (test/dev tools — they do not ship in the OS tarball;
their fake endpoints are loopback or example.* anyway).

Usage:
    python3 scripts/dev/no-telemetry-audit.py [--root DIR] [--list]
Exit 0 = every finding is allowlisted. Exit 1 = a new phone-home
(or a removed allowlist entry that is still in the code) was found.
"""
import argparse
import os
import re
import sys

# ── Allowlist: URL hosts ─────────────────────────────────────────────
# Key: host (or exact URL prefix for the two GitHub paths). Value: why
# the user would accept this call. Keep the reason honest and specific.
ALLOWED_URL_HOSTS = {
    # Update check + bug report — the two documented outbound calls.
    "api.github.com": "Update check (GitHub releases API, once a day, "
                      "no user data) — bin/veltrix-update-download, "
                      "ui/shell/core/UpdateCheck.ts, About.tsx.",
    "github.com": "Update tarball download and the user-initiated bug "
                  "report (opens github.com/.../issues/new in the "
                  "browser, only when the user clicks Report bug).",
    "adnqcr7-code.github.io": "Planned veltrix pacman repo — commented "
                              "out in install.sh, not executed; when it "
                              "ships it is install-time package fetching.",
    # Functional lookups, only when the user uses the feature.
    "api.open-meteo.com": "Menu-bar weather (lat/lon, every 15 min "
                          "while the widget is shown). PAUSED in Tor "
                          "mode — see WeatherService.",
    "open-meteo.com": "Doc comment in bin/veltrix-weather (source "
                      "attribution, not fetched).",
    "check.torproject.org": "Leak-check (bin/veltrix-anonymity), "
                            "user-initiated, fetched THROUGH Tor.",
    "geoip.kde.org": "Installer timezone suggestion, once at install "
                     "start, fails silently, overrideable via "
                     "VELTRIX_GEOIP_URL (ui/installer/lib/geoip.ts, "
                     "issue #491). The service sees the install IP — "
                     "that is what a GeoIP lookup is — and returns "
                     "only a timezone.",
    "family-filter-dns.cleanbrowsing.org": "Content Safety DoT "
                                           "hostname (DNS destination, "
                                           "not an HTTP fetch).",
    "cleanbrowsing.org": "Doc comment in bin/veltrix-content-safety "
                         "(source attribution, not fetched).",
    "ping.archlinux.org": "NetworkManager connectivity check, installer "
                          "only, on demand (ui/installer/lib/network.ts).",
    # Install-time app sources — only when the user picks the app in
    # the installer apps step; nothing runs at desktop runtime.
    "flathub.org": "Flatpak remote, added at install time only when "
                   "the user picks a Flatpak app (Spotify, FreeTube) "
                   "in install.sh.",
    "web.whatsapp.com": "WhatsApp web-app launcher, created only when "
                        "the user picks WhatsApp in the installer apps "
                        "step (install.sh).",
    # Never fetched — doc comments, namespaces, source attribution.
    "www.freedesktop.org": "PolicyKit DTD in config/polkit/*.policy — "
                           "an XML doctype, never fetched.",
    "claude.ai": "Provenance link in toolkit/tokens/header.json "
                 "(design-token source), never fetched.",
    # Pacman mirrorlist data (defaults/) — fetched by pacman at install
    # time, never by VELTRIX code.
    "mirror.raiolanetworks.com": "Pacman mirrorlist entry (defaults/).",
    "ftp.rediris.es": "Pacman mirrorlist entry (defaults/).",
    "es.mirrors.cicku.me": "Pacman mirrorlist entry (defaults/).",
    "geo.mirror.pkgbuild.com": "Pacman mirrorlist entry (defaults/).",
    # Never fetched — doc comments, namespaces, source attribution.
    "www.w3.org": "SVG/XML namespace, never fetched.",
    "www.gtk.org": "GTK namespace (grappa) in icon code, never fetched.",
    "docs.gtk.org": "Doc comments in TS/RS source, never fetched.",
    "specifications.freedesktop.org": "Doc comment (sound theme), "
                                      "never fetched.",
    "wiki.hyprland.org": "Doc comment in defaults/uwsm/env, never fetched.",
    "wiki.hypr.land": "Doc comment in config/hypr/hypridle.conf, "
                      "never fetched.",
    "sw.kovidgoyal.net": "Doc comment in defaults/kitty/kitty.conf, "
                         "never fetched.",
    "archlinux.org": "Doc comment (mirror list reference), never fetched.",
    "veracrypt.fr": "Doc comment (LUKS reference), never fetched.",
    "raw.githubusercontent.com": "Blocklist source attribution "
                                 "(defaults/content-safety/blocklist.txt "
                                 "comments only — the blocklist ships as "
                                 "a file, it is never fetched at runtime).",
    "github.com/adnqcr7-code.png": "Test fixture (scripts/dev/fake-mpris.js).",
    "x.org": "Test fixture (toolkit/shell/src/drops.rs).",
}

# Hosts that are always fine, no entry needed: loopback, and the
# RFC 2606 example domains used by tests and fixtures.
AUTO_ALLOW_HOST_SUFFIXES = (".example", ".example.com", ".example.net",
                            ".example.org", ".invalid", ".test",
                            ".localhost")
AUTO_ALLOW_HOSTS = {"localhost", "127.0.0.1", "::1", "example.com",
                    "example.org", "example.net", "example.invalid",
                    "example", "w3.org"}

# ── Allowlist: network call sites, by shipped file ──────────────────
# Key: path relative to the repo root. Value: why this file may make a
# network call. A file NOT listed here that gains a call site fails.
ALLOWED_CALL_SITES = {
    "bin/veltrix-weather": "Open-Meteo fetch (urllib urlopen), every "
                           "15 min while the bar widget is shown; "
                           "paused in Tor mode.",
    "bin/veltrix-update-download": "GitHub releases API + tarball "
                                  "download (urllib), the documented "
                                  "update check.",
    "bin/veltrix-update-helper": "GitHub releases API for hash "
                                "verification before applying an update.",
    "bin/veltrix-anonymity": "Leak-check curl through the Tor SOCKS "
                             "proxy (user-initiated), plus a loopback "
                             "TCP probe of 127.0.0.1:9050 — no external "
                             "traffic.",
    "bin/veltrix-bug-report": "Opens the GitHub issue URL in the "
                             "browser — user-initiated only.",
    "bin/veltrix-agent": "curl to the local Ollama endpoint "
                         "(loopback only; non-loopback refused).",
    "ui/shell/core/UpdateCheck.ts": "GitHub releases API (update check).",
    "ui/shell/surfaces/settings/pages/About.tsx": "GitHub releases API "
                                                  "(update check).",
    "ui/shell/core/MediaService.ts": "Album-art curl of the MPRIS "
                                     "artUrl (bounded 10 MiB / 10 s, "
                                     "cached); only when a player "
                                     "publishes an http(s) art URL. "
                                     "Blocked, not leaked, in Tor mode.",
    "session/daemon/src/media/art.rs": "Album-art curl of the MPRIS "
                                       "artUrl (bounded 10 MiB / 10 s, "
                                       "cached); same as MediaService.ts.",
    "ui/shell/core/AgentCatalog.ts": "curl to the local Ollama endpoint "
                                     "only — non-loopback hosts are "
                                     "refused in code.",
    "ui/installer/lib/geoip.ts": "KDE GeoIP timezone suggestion, "
                                 "installer only, once, fails silently.",
    "ui/installer/lib/network.ts": "nmcli connectivity check, "
                                   "installer only, on demand.",
    "ui/shell/core/WeatherService.ts": "Runs bin/veltrix-weather "
                                       "(Open-Meteo); paused in Tor mode.",
}

SKIP_DIR_NAMES = {".git", "node_modules", "@girs", "build", "target",
                  "dist", "__pycache__", ".venv", ".mypy_cache"}
# Test/dev trees do not ship in the OS tarball.
TEST_PATH_MARKERS = ("/dev/", "/ci/", "/tests/", "/test/", "/fixtures/",
                     "/examples/", "/test-", "-test.", "_test.")
# Text files to scan (extensionless files in bin/ are included by the
# is-text check below; docs are not executed and are excluded).
SCAN_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".mjs", ".rs", ".sh",
                   ".c", ".h", ".lua", ".json", ".toml", ".conf",
                   ".desktop", ".policy", ".xml", ".txt", ".service",
                   ".gschema.xml"}
SCAN_DIRS = ("bin", "ui", "session", "toolkit", "hyalo", "crates",
             "config", "defaults", "packaging", "scripts", "docs",
             "install.sh")

URL_RE = re.compile(r"https?://[A-Za-z0-9._~:/?#@!$&'()*+,;=%\-\[\]]+")
# Network call sites: an actual invocation, not a comment mentioning
# the tool. `curl` in a comment (e.g. "curl'd async") is not a call —
# call-site matching runs on comment-stripped lines (see scan()).
# The fetch() pattern applies to TS/JS only: Rust and Python code in
# this tree has local functions named fetch (D-Bus icon cache, tree
# walks) that are not HTTP.
CALL_PATTERNS = [
    (re.compile(r"\burlopen\s*\("), "urlopen()"),
    (re.compile(r"\brequests\.(get|post|put|head|request)\s*\("),
     "requests.*()"),
    (re.compile(r"\bhttp\.client\b"), "http.client"),
    (re.compile(r"\bSoup\."), "libsoup"),
    (re.compile(r"\bXMLHttpRequest\b"), "XMLHttpRequest"),
    (re.compile(r"\bnew\s+WebSocket\s*\("), "WebSocket"),
    (re.compile(r"\breqwest\b"), "reqwest"),
    (re.compile(r"\bureq\b"), "ureq"),
    (re.compile(r"(?<![\w.])fetch\s*\("), "fetch()"),
    (re.compile(r'Command::new\(\s*"(curl|wget)"\s*\)'),
     "Command::new(curl|wget)"),
    (re.compile(r'execAsync\(\s*\[\s*"(curl|wget)"'), "execAsync(curl|wget)"),
    (re.compile(r'\["(curl|wget)"'), '["curl"/"wget"]'),
    (re.compile(r"\bcreate_connection\s*\("), "create_connection()"),
    (re.compile(r"networking.*connectivity.*check"), "nmcli connectivity"),
]
FETCH_EXTENSIONS = {".ts", ".tsx", ".js", ".mjs"}
# Generated dependency manifests: the URLs are where the package
# manager fetched build-time dependencies, not runtime phone-home.
SKIP_FILENAMES = {"package-lock.json", "Cargo.lock", "yarn.lock",
                  "pnpm-lock.yaml", "composer.lock", "Gemfile.lock"}


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", ".."))


def is_text_file(path):
    try:
        with open(path, "rb") as f:
            return b"\x00" not in f.read(8192)
    except OSError:
        return False


def is_test_path(rel):
    rel = "/" + rel.replace(os.sep, "/") + "/"
    return any(m in rel for m in TEST_PATH_MARKERS)


def host_of(url):
    m = re.match(r"https?://([^/:?#]+)", url)
    return m.group(1).lower() if m else ""


def url_allowed(url):
    host = host_of(url)
    if not host:
        return True  # not a real URL (e.g. "http://$VAR") — see below
    if host in AUTO_ALLOW_HOSTS:
        return True
    if host.endswith(AUTO_ALLOW_HOST_SUFFIXES):
        return True
    for allowed in ALLOWED_URL_HOSTS:
        if host == allowed or host.endswith("." + allowed):
            return True
        # Exact-path entries (e.g. github.com/adnqcr7-code.png).
        if url.startswith("https://" + allowed) or \
                url.startswith("http://" + allowed):
            return True
    return False


def scan(root):
    findings = []  # (relpath, line_no, kind, text)
    seen = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames
                             if d not in SKIP_DIR_NAMES
                             and not d.startswith("."))
        for name in sorted(filenames):
            if name in SKIP_FILENAMES:
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root)
            if rel.startswith(".."):
                continue
            top = rel.split(os.sep)[0]
            if top not in SCAN_DIRS and not rel.startswith("install.sh"):
                continue
            if name.endswith(".md"):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in SCAN_EXTENSIONS and top != "bin":
                continue
            if not is_text_file(path):
                continue
            if is_test_path(rel):
                continue
            with open(path, encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
            for i, line in enumerate(lines, 1):
                for m in URL_RE.finditer(line):
                    url = m.group(0).rstrip(".,);'\"")
                    if url in ("http://", "https://"):
                        continue
                    if url_allowed(url):
                        continue
                    key = (rel, i, "url", url)
                    if key not in seen:
                        seen.add(key)
                        findings.append(key)
                # Call sites: strip the comment tail first, so a word
                # like "fetch" in a comment is not a finding. URL
                # literals above are scanned on the raw line on
                # purpose — a doc-comment URL still needs an entry.
                code = line
                if ext in (".py", ".sh"):
                    code = line.split("#", 1)[0]
                else:
                    code = line.split("//", 1)[0]
                for pattern, label in CALL_PATTERNS:
                    if label == "fetch()" and ext not in FETCH_EXTENSIONS:
                        continue
                    if pattern.search(code):
                        # One finding per line: several patterns can
                        # match the same invocation (execAsync(["curl"
                        # matches both the execAsync and the ["curl"]
                        # patterns); it is one call site.
                        key = (rel, i, "call-site")
                        if key not in seen:
                            seen.add(key)
                            findings.append((rel, i, "call-site",
                                             "%s: %s" % (label,
                                                         code.strip()[:100])))
                        break
    return findings


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Fail if VELTRIX ships a new phone-home.")
    ap.add_argument("--root", default=None, help="repo root (default: auto)")
    ap.add_argument("--list", action="store_true",
                    help="list all findings (allowed or not) and exit 0")
    args = ap.parse_args(argv)
    root = args.root or repo_root()
    findings = scan(root)
    unallowed = []
    for rel, line_no, kind, text in findings:
        if kind == "call-site" and rel in ALLOWED_CALL_SITES:
            continue
        unallowed.append((rel, line_no, kind, text))
    if args.list:
        for rel, line_no, kind, text in findings:
            tag = "ALLOWED" if (rel, line_no, kind, text) not in unallowed \
                else "NOT ALLOWED"
            print("%s:%d [%s] %s  (%s)" % (rel, line_no, kind, text, tag))
        print("%d findings (%d not allowlisted)"
              % (len(findings), len(unallowed)))
        return 0
    if unallowed:
        print("no-telemetry-audit: FAIL — %d new phone-home finding(s):"
              % len(unallowed))
        for rel, line_no, kind, text in unallowed:
            print("  %s:%d [%s] %s" % (rel, line_no, kind, text))
        print("Add a human-written reason to ALLOWED_URL_HOSTS or "
              "ALLOWED_CALL_SITES in scripts/dev/no-telemetry-audit.py, "
              "or remove the call.")
        return 1
    print("no-telemetry-audit: PASS — %d findings, all allowlisted "
          "(%d URLs, %d call sites)"
          % (len(findings),
             sum(1 for f in findings if f[2] == "url"),
             sum(1 for f in findings if f[2] == "call-site")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
