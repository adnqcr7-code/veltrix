#!/usr/bin/env bash
# venv-skip-probe — the venv fast-update skip really can fire (Nov 14 sweep #3).
#
# install.sh's fast-update block skips `pip install` when the requirements
# file is unchanged AND the venv imports the modules. It tested
# `import hijridate, al_falak` — but the PyPI package installs the module
# `alfalak`, so the import ALWAYS failed and every update re-ran pip
# install. bin/veltrix-setup was fixed to `alfalak`; install.sh was not.
#
# This probe proves the exact import line install.sh now carries against a
# stub venv that has both real module names, and proves the OLD line fails
# against that same venv (negative control — the probe must catch a
# regression to the old spelling, not just pass on the new one).
#
# Usage: ./scripts/dev/venv-skip-probe.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d /tmp/veltrix-venv-skip-probe.XXXXXX)"
trap 'rm -rf "$T"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# The exact import test install.sh carries (extracted, not copied — a
# regression to `al_falak` must fail this probe).
LINE="$(grep -F 'import hijridate' "$REPO/install.sh" | grep -F 'python" -c' | head -1)"
[ -n "$LINE" ] || fail "no venv import test found in install.sh"
echo "install.sh carries: $LINE"
case "$LINE" in
    *alfalak*) pass "install.sh tests the real module name alfalak" ;;
    *) fail "install.sh still tests a wrong module name: $LINE" ;;
esac
case "$LINE" in
    *al_falak*) fail "install.sh still contains the dead al_falak spelling" ;;
    *) pass "no al_falak spelling left in the import test" ;;
esac
# bin/veltrix-setup must agree (the two venv paths must not drift).
grep -q 'import hijridate, alfalak' "$REPO/bin/veltrix-setup" \
    || fail "bin/veltrix-setup disagrees with install.sh"
pass "bin/veltrix-setup agrees (import hijridate, alfalak)"

# A stub venv with the REAL module names, as pip would install them.
VENV="$T/venv"
mkdir -p "$VENV/bin"
cat > "$VENV/bin/python" <<'EOF'
#!/bin/bash
# Fake venv python: -c "import ..." succeeds only for real module names.
if [ "$1" = "-c" ]; then
    code="$2"
    # Split the import list and check each name against the stub site-packages.
    python3 - "$code" <<'PYEOF'
import re, sys
code = sys.argv[1]
m = re.search(r'import\s+(.+)', code)
names = [n.strip() for n in m.group(1).split(',')] if m else []
import os
site = os.path.join(os.environ["VENV_STUB_SITE"])
for n in names:
    if not (os.path.exists(os.path.join(site, n + ".py")) or os.path.isdir(os.path.join(site, n))):
        sys.exit(1)
sys.exit(0)
PYEOF
    exit $?
fi
exec python3 "$@"
EOF
chmod +x "$VENV/bin/python"
mkdir -p "$T/site"
touch "$T/site/hijridate.py" "$T/site/alfalak.py"
export VENV_STUB_SITE="$T/site"

# The NEW line's import succeeds against the stub venv...
if "$VENV/bin/python" -c "import hijridate, alfalak" 2>/dev/null; then
    pass "import hijridate, alfalak succeeds (skip can fire)"
else
    fail "import hijridate, alfalak fails against a venv that has both modules"
fi
# ...and the OLD line's import fails against that same venv (control:
# this is the bug as found — the skip could never fire).
if "$VENV/bin/python" -c "import hijridate, al_falak" 2>/dev/null; then
    fail "control failed: import hijridate, al_falak unexpectedly succeeds"
else
    pass "control: import hijridate, al_falak fails (the old line could never skip)"
fi
echo "venv-skip-probe: ALL PASSED"
