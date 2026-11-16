#!/usr/bin/env bash
# bug-report-probe — harness test for bin/veltrix-bug-report (+ doctor --report).
#
# Runs the reporter against a scratch HOME (fake .dev/VERSION, fake shell log
# with CRITICAL lines, fake veltrix-doctor, fake xdg-open that logs its args).
# Nothing leaves the machine: no browser is opened for real, no issue filed.
# Exit 0 = all pass.
#
# Usage: ./scripts/dev/bug-report-probe.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REPORTER="$REPO/bin/veltrix-bug-report"
DOCTOR="$REPO/bin/veltrix-doctor"
T="$(mktemp -d /tmp/veltrix-br-probe.XXXXXX)"
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# ── Fixture HOME ─────────────────────────────────────────────────────────────
mkdir -p "$T/home/.config/veltrix" "$T/home/Downloads" "$T/run" "$T/bin" "$T/repo"
printf '1.0\n' > "$T/repo/VERSION"
printf '%s\n' "$T/repo" > "$T/home/.config/veltrix/.dev"
printf '1.0\n' > "$T/home/.config/veltrix/.release"
cat > "$T/run/veltrix-ui.log" <<'LOG'
2026-11-15 15:05:00.123 (veltrix-ui): Gjs-CRITICAL **: JS ERROR: Error: Invalid Linux process name: veltrix-settings
2026-11-15 15:05:01.456 (veltrix-ui): Gjs-CRITICAL **: JS ERROR: Error: something broke at 0x7f3a9c001234 in /home/fakeuser/.config/veltrix/foo
2026-11-15 15:05:02.789 (veltrix-ui): plain info line, nothing wrong
LOG
# Fake doctor: only --log matters here.
cat > "$T/bin/veltrix-doctor" <<'SH'
#!/bin/bash
if [ "$1" = "--log" ]; then
    printf 'since 2026-11-15 15:05:00 — 1 kind(s)\n     2  Gjs-CRITICAL **: JS ERROR: Error: Invalid Linux process name: veltrix-settings\n'
    exit 0
fi
echo "fake doctor: unexpected args: $*" >&2
exit 1
SH
chmod +x "$T/bin/veltrix-doctor"
# Fake opener: logs its args, opens nothing.
cat > "$T/bin/xdg-open" <<'SH'
#!/bin/bash
echo "$@" >> "$OPENER_LOG"
SH
chmod +x "$T/bin/xdg-open"

export HOME="$T/home" XDG_RUNTIME_DIR="$T/run" XDG_CURRENT_DESKTOP="Veltrix"
export PATH="$T/bin:$PATH" OPENER_LOG="$T/opened.log"

# ── 1. Default collection, no browser ────────────────────────────────────────
OUT="$("$REPORTER" --no-open)" || fail "reporter exited $?"
echo "$OUT" | grep -q "Report written to: $T/home/Downloads/veltrix-bug-report-" || fail "no report path printed: $OUT"
REPORT="$(echo "$OUT" | sed -n 's/^Report written to: //p')"
[ -f "$REPORT" ] || fail "report file missing: $REPORT"
grep -q "veltrix: 1.0 (dev checkout:" "$REPORT" || fail "report lacks the version"
grep -q "release: 1.0" "$REPORT" || fail "report lacks the release"
grep -q "session: Veltrix" "$REPORT" || fail "report lacks the session"
grep -q "Invalid Linux process name: veltrix-settings" "$REPORT" || fail "report lacks the CRITICAL line"
grep -q "0x…" "$REPORT" || fail "hex address not masked"
grep -q "/home/fakeuser" "$REPORT" && fail "home path leaked into the report"
grep -q "since 2026-11-15 15:05:00" "$REPORT" || fail "report lacks the doctor --log summary"
URL="$(echo "$OUT" | sed -n 's/^Issue URL: //p')"
[ -n "$URL" ] || fail "no issue URL printed"
case "$URL" in
  "https://github.com/adnqcr7-code/veltrix/issues/new?title="*) ;;
  *) fail "issue URL has the wrong shape: $URL" ;;
esac
[ "${#URL}" -lt 2000 ] || fail "issue URL too long: ${#URL} chars"
[ -f "$T/opened.log" ] && fail "opener ran despite --no-open"
pass "collect: report file, version/session/log, masking, short issue URL, no opener"

# ── 2. --open hands the URL to the opener ────────────────────────────────────
"$REPORTER" --open > "$T/open.log" 2>&1 || fail "reporter --open exited $?"
grep -q "issues/new?title=" "$T/opened.log" || fail "opener did not receive the issue URL"
grep -q "Opened in the browser via xdg-open" "$T/open.log" || fail "no opener confirmation printed"
pass "--open opens the pre-filled issue URL via xdg-open"

# ── 3. --title override lands in the URL ─────────────────────────────────────
OUT3="$("$REPORTER" --no-open --title "Settings will not open")" || fail "--title run failed"
echo "$OUT3" | grep -q "title=Settings+will+not+open" || fail "--title not in the URL: $OUT3"
pass "--title override appears URL-encoded in the issue URL"

# ── 4. No log, no doctor: still a report, marked n/a ────────────────────────
mkdir -p "$T/empty-home" "$T/empty-run"
OUT4="$(HOME="$T/empty-home" XDG_RUNTIME_DIR="$T/empty-run" PATH="/usr/bin:/bin" "$REPORTER" --no-open --out "$T/empty-out")" || fail "degraded run failed"
REPORT4="$(echo "$OUT4" | sed -n 's/^Report written to: //p')"
[ -f "$REPORT4" ] || fail "degraded run wrote no report"
grep -q "_none found_" "$REPORT4" || fail "degraded report does not say no CRITICALs found"
grep -q "n/a (veltrix-doctor not found)" "$REPORT4" || fail "degraded report does not mark the doctor n/a"
grep -q "veltrix: n/a" "$REPORT4" || fail "degraded report does not mark the version n/a"
pass "degraded run (no log, no doctor, no version) still writes a report marked n/a"

# ── 5. URL trimming: an absurd body still fits under 2000 chars ─────────────
python3 - "$REPORTER" <<'PY' || fail "URL trim check failed"
import importlib.util, importlib.machinery, sys
loader = importlib.machinery.SourceFileLoader("br", sys.argv[1])
spec = importlib.util.spec_from_loader("br", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
url = mod.build_issue_url("t" * 100, "b" * 5000)
assert len(url) < 2000, f"trimmed URL still {len(url)} chars"
assert url.startswith("https://github.com/adnqcr7-code/veltrix/issues/new?title=")
print(f"trimmed absurd body to {len(url)} chars")
PY
pass "build_issue_url trims an oversized body under 2000 chars (control)"

# ── 6. veltrix-doctor --report dispatches to the reporter ────────────────────
OUT6="$("$DOCTOR" --report --no-open --out "$T/doctor-out")" || fail "doctor --report failed"
echo "$OUT6" | grep -q "Report written to: $T/doctor-out/veltrix-bug-report-" || fail "doctor --report produced no report: $OUT6"
pass "veltrix-doctor --report dispatches to veltrix-bug-report"

echo "bug-report-probe: ALL PASS"
