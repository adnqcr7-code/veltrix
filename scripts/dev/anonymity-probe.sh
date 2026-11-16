#!/usr/bin/env bash
# anonymity-probe — harness test for bin/veltrix-anonymity (+ the
# no-telemetry audit).
#
# Runs the unit tests (real CLI as a subprocess against a scratch tree
# with stub nft / systemctl / nmcli / tor / curl / dig) and then the
# no-telemetry audit against the tree. No Tor, no nftables, no
# NetworkManager, no network needed. Nothing leaves the machine.
# Exit 0 = all pass.
#
# Usage: ./scripts/dev/anonymity-probe.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "── anonymity unit tests ──"
python3 "$REPO/scripts/dev/anonymity-test.py" || fail "anonymity unit tests"

echo "── no-telemetry audit ──"
python3 "$REPO/scripts/dev/no-telemetry-audit.py" --root "$REPO" \
    || fail "no-telemetry audit"

echo "anonymity-probe: ALL PASS"
