#!/usr/bin/env bash
# Run scripts/dev/auth-probe.js against the built lib — or against an older one,
# to prove the probe can actually fail.
#
#   ./scripts/dev/auth-probe.sh                 # current working tree
#   ./scripts/dev/auth-probe.sh --old f35b6a2   # the lib as of a git ref
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for svc in veltrix-auth-probe veltrix-auth-probe-acct veltrix-auth-probe-deny; do
    [ -f "/etc/pam.d/$svc" ] && continue
    echo "missing /etc/pam.d/$svc — install the three probe services first:" >&2
    echo "  sudo install -Dm644 $REPO/scripts/dev/pam-auth-probe      /etc/pam.d/veltrix-auth-probe \\" >&2
    echo "   && sudo install -Dm644 $REPO/scripts/dev/pam-auth-probe-acct /etc/pam.d/veltrix-auth-probe-acct \\" >&2
    echo "   && sudo install -Dm644 $REPO/scripts/dev/pam-auth-probe-deny /etc/pam.d/veltrix-auth-probe-deny" >&2
    exit 2
done

if [ "${1:-}" = "--old" ]; then
    REF="${2:?usage: auth-probe.sh --old <git-ref>}"
    WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
    echo "==> building lib/veltrix-auth as of $REF"
    git -C "$REPO" archive "$REF" lib/veltrix-auth | tar -x -C "$WORK"
    "$WORK/lib/veltrix-auth/build.sh" "$WORK/build" >/dev/null
    LIB="$WORK/build"
else
    echo "==> building lib/veltrix-auth from the working tree"
    "$REPO/lib/veltrix-auth/build.sh" >/dev/null
    LIB="$REPO/lib/veltrix-auth/build"
fi

echo "==> probing with $LIB"
GI_TYPELIB_PATH="$LIB${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}" \
LD_LIBRARY_PATH="$LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    gjs -m "$REPO/scripts/dev/auth-probe.js"
