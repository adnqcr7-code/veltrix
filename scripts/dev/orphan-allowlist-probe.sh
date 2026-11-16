#!/usr/bin/env bash
# orphan-allowlist-probe — the /usr/bin orphan sweep must not delete the
# binaries that live in /usr/bin but are NOT in bin/ (Nov 14 sweep #1).
#
# install.sh's "No orphans" sweep removes /usr/bin/veltrix-* names that are
# neither in bin/ nor on a small exemption list. veltrix-hyalo and
# veltrix-hyalo-session are installed to /usr/bin by the PKGBUILD (cargo
# builds them; no bin/ copy exists), and the list did not name them — so
# the sweep deleted the compositor itself on every update.
#
# This probe reads the exemption pattern straight out of install.sh (no
# copy of it lives here) and replays the sweep's own decision for each
# name: exempt if the name matches the pattern OR a file bin/<name> exists
# in the tree. A regression that drops a name from the list fails here.
# The negative control — a genuinely orphaned name — must still be
# deleted, or the probe is not testing the sweep at all.
#
# Usage: ./scripts/dev/orphan-allowlist-probe.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d /tmp/veltrix-orphan-probe.XXXXXX)"
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# The exemption arm, straight from install.sh: the line after
# `case "$_name" in` inside the /usr/bin orphan loop (anchored on the
# loop's `for _bin in /usr/bin/veltrix-*` — the case precedes the echo).
CASE_LINE="$(awk '/for _bin in \/usr\/bin\/veltrix-\*/{found=1} found && /case "\$_name" in/{getline; print; exit}' "$REPO/install.sh")"
[ -n "$CASE_LINE" ] || fail "could not find the orphan-sweep case in install.sh"
# Just the alternation (`a|b|c`): strip leading space and the trailing `) ;;`.
PAT="$(printf '%s' "$CASE_LINE" | sed 's/^[[:space:]]*//; s/) *;;[[:space:]]*$//')"
[ -n "$PAT" ] || fail "could not parse the exemption pattern from: $CASE_LINE"
echo "sweep exempts: $PAT"

# The sweep's decision for one name (its two exemptions, in its order).
# NOTE: a case pattern is parsed BEFORE expansion, so the alternation
# cannot live in a variable — it has to reach `case` as source text.
# eval builds the statement from the extracted pattern ($PAT is
# install.sh's own text, matched above to `^[a-z0-9|-]+$` by construction:
# it came from the exemption arm, nothing else can be in it).
case "$PAT" in
    *[!a-z0-9\|-]*) fail "unexpected characters in exemption pattern: $PAT" ;;
esac
decide() { # $1 = name; prints "keep" or "delete"
    local name="$1"
    if [ -f "$REPO/bin/$name" ]; then echo keep; return; fi
    eval "case \"\$name\" in $PAT) echo keep ;; *) echo delete ;; esac"
}

for n in veltrix-hyalo veltrix-hyalo-session veltrix-input veltrix-sessiond veltrix-ipc veltrix-display-selector veltrix-shell; do
    [ "$(decide "$n")" = keep ] || fail "$n would be deleted by the orphan sweep"
    pass "$n is exempt from the orphan sweep"
done
# A bin/-shipped name is exempt through the file check, not the list.
[ "$(decide veltrix-doctor)" = keep ] || fail "veltrix-doctor (in bin/) would be deleted"
pass "veltrix-doctor exempt via bin/"
# Negative control: a genuinely orphaned name must still be deleted.
[ "$(decide veltrix-oldthing)" = delete ] || fail "control failed: orphan veltrix-oldthing would be kept"
pass "control: orphan veltrix-oldthing is still deleted"
# The PKGBUILD really does install both Hyalo binaries to /usr/bin
# (otherwise the exemption would be guarding nothing).
grep -q 'hyalo/target/release/veltrix-hyalo "\$pkgdir/usr/bin/veltrix-hyalo"' "$REPO/packaging/veltrix/PKGBUILD" \
    || fail "PKGBUILD does not install veltrix-hyalo to /usr/bin"
grep -q 'bin/veltrix-hyalo-session "\$pkgdir/usr/bin/veltrix-hyalo-session"' "$REPO/packaging/veltrix/PKGBUILD" \
    || fail "PKGBUILD does not install veltrix-hyalo-session to /usr/bin"
pass "PKGBUILD installs both Hyalo binaries to /usr/bin"
echo "orphan-allowlist-probe: ALL PASSED"
