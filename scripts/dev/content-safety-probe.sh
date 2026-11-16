#!/usr/bin/env bash
# content-safety-probe — harness test for bin/veltrix-content-safety.
#
# Runs the helper's on/status/off cycle against a scratch tree (no systemd,
# no real /etc/hosts, no root-owned system files touched — every path is
# overridden with VELTRIX_CS_*). Asserts the hosts block is written and removed
# cleanly, the DNS artifacts appear and disappear, prior state is restored,
# and a second `on` does not duplicate the block. Exit 0 = all pass.
#
# Usage: ./scripts/dev/content-safety-probe.sh
#   (also: VELTRIX_CS_REAL_HOSTS=1 runs the extra mount-namespace check, which
#   bind-mounts the scratch hosts file over /etc/hosts and asks getent to
#   resolve an adult domain — needs unprivileged user namespaces.)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO/bin/veltrix-content-safety"
T="$(mktemp -d /tmp/veltrix-cs-probe.XXXXXX)"
trap 'rm -rf "$T"' EXIT

export VELTRIX_CS_NO_SYSTEMD=1
export VELTRIX_CS_HOSTS="$T/hosts"
export VELTRIX_CS_HOSTS_BACKUP="$T/hosts.veltrix-backup"
export VELTRIX_CS_RESOLVED_DIR="$T/resolved.conf.d"
export VELTRIX_CS_DISPATCHER="$T/dispatcher.d/20-veltrix-content-safety"
export VELTRIX_CS_RESOLV_CONF="$T/resolv.conf"
export VELTRIX_CS_RESOLV_BACKUP="$T/resolv.conf.veltrix-backup"
export VELTRIX_CS_STATE_DIR="$T/state"
export VELTRIX_CS_BLOCKLIST="$REPO/defaults/content-safety/blocklist.txt"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# A realistic pre-existing hosts file + resolv.conf (NetworkManager style).
printf '127.0.0.1 localhost\n::1 localhost\n192.168.1.5 myserver.local\n' > "$T/hosts"
printf 'nameserver 192.168.1.1\n' > "$T/resolv.conf"
cp "$T/hosts" "$T/hosts.orig"

"$HELPER" on > "$T/on.log" 2>&1 || fail "on exited $?: $(cat "$T/on.log")"
pass "on exits 0"
grep -q "# BEGIN VELTRIX CONTENT SAFETY" "$T/hosts" || fail "no BEGIN marker"
grep -q "# END VELTRIX CONTENT SAFETY" "$T/hosts" || fail "no END marker"
N="$(grep -c '^0.0.0.0 ' "$T/hosts")"
[ "$N" = 76 ] || fail "expected 76 blocked domains, got $N"
grep -q '^0.0.0.0 pornhub.com$' "$T/hosts" || fail "pornhub.com not blocked"
grep -q '^0.0.0.0 www.xvideos.com$' "$T/hosts" || fail "www.xvideos.com not blocked"
grep -q '^192.168.1.5 myserver.local$' "$T/hosts" || fail "unrelated hosts line lost"
[ -f "$T/hosts.veltrix-backup" ] || fail "no hosts backup"
cmp -s "$T/hosts.veltrix-backup" "$T/hosts.orig" || fail "hosts backup differs from original"
[ -f "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "no resolved drop-in"
grep -q '^DNS=185.228.168.168#family-filter-dns.cleanbrowsing.org 185.228.169.168#family-filter-dns.cleanbrowsing.org$' "$T/resolved.conf.d/20-veltrix-content-safety.conf" || fail "drop-in DNS wrong (want both servers with the DoT hostname)"
grep -q '^DNSOverTLS=yes$' "$T/resolved.conf.d/20-veltrix-content-safety.conf" || fail "drop-in DNSOverTLS is not yes"
grep -q '^Domains=~.$' "$T/resolved.conf.d/20-veltrix-content-safety.conf" || fail "drop-in Domains wrong"
[ -x "$T/dispatcher.d/20-veltrix-content-safety" ] || fail "no dispatcher script"
grep -q 'resolvectl dns' "$T/dispatcher.d/20-veltrix-content-safety" || fail "dispatcher does not set link DNS"
grep -q 'family-filter-dns.cleanbrowsing.org' "$T/dispatcher.d/20-veltrix-content-safety" || fail "dispatcher does not carry the DoT hostname"
grep -q 'resolvectl dnsovertls.* yes' "$T/dispatcher.d/20-veltrix-content-safety" || fail "dispatcher does not set per-link DNSOverTLS"
[ -L "$T/resolv.conf" ] || fail "resolv.conf is not a stub symlink after on"
[ "$(readlink "$T/resolv.conf")" = "/run/systemd/resolve/stub-resolv.conf" ] || fail "resolv.conf points elsewhere"
[ -f "$T/state/state.json" ] || fail "no state file"
pass "on: hosts block (76), drop-in, dispatcher, resolv.conf stub, state"

ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "on"' || fail "status is not on: $ST"
echo "$ST" | grep -q '"blocked": 76' || fail "status blocked != 76: $ST"
pass "status reports on / 76 blocked"

"$HELPER" on > /dev/null 2>&1 || fail "second on failed"
[ "$(grep -c '^0.0.0.0 ' "$T/hosts")" = 76 ] || fail "second on duplicated the block"
[ "$(grep -c 'BEGIN VELTRIX CONTENT SAFETY' "$T/hosts")" = 1 ] || fail "second on duplicated markers"
pass "on is idempotent"

"$HELPER" off > "$T/off.log" 2>&1 || fail "off exited $?: $(cat "$T/off.log")"
grep -q "VELTRIX CONTENT SAFETY" "$T/hosts" && fail "hosts block still present after off"
cmp -s "$T/hosts" "$T/hosts.orig" || fail "hosts file not restored byte-for-byte after off"
[ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in still present after off"
[ ! -e "$T/dispatcher.d/20-veltrix-content-safety" ] || fail "dispatcher still present after off"
[ ! -L "$T/resolv.conf" ] || fail "resolv.conf still a symlink after off"
cmp -s "$T/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf not restored after off"
[ ! -e "$T/state/state.json" ] || fail "state file still present after off"
pass "off: block gone, hosts byte-identical, DNS artifacts removed, resolv.conf restored"

ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "status is not off after off: $ST"
"$HELPER" off > /dev/null 2>&1 || fail "second off failed"
pass "off is idempotent; status reports off"

# ── Damaged-artifact scenarios (security review, 2026-11-12) ────────────────
# 1. The drop-in replaced by a directory — the kind of damage a hand-edit or
#    a failed run leaves behind. `off` must NOT abort on the first unlink
#    error: the dispatcher, the hosts block, the resolv.conf restore and the
#    state file are all still removed, and only the damaged drop-in remains.
#    Exit code is non-zero and the message names what is left; status says
#    "partial", never a clean "off" over a stranded layer.
"$HELPER" on > /dev/null 2>&1 || fail "re-on for scenario 1 failed"
rm "$T/resolved.conf.d/20-veltrix-content-safety.conf"
mkdir "$T/resolved.conf.d/20-veltrix-content-safety.conf"
if "$HELPER" off > "$T/off-dmg.log" 2>&1; then
    fail "off over a damaged drop-in exited 0 (must fail honestly)"
fi
grep -q "drop-in still present" "$T/off-dmg.log" || fail "off did not name the stranded drop-in: $(cat "$T/off-dmg.log")"
grep -q "VELTRIX CONTENT SAFETY" "$T/hosts" && fail "hosts block still present after damaged off"
[ ! -e "$T/dispatcher.d/20-veltrix-content-safety" ] || fail "dispatcher still present after damaged off"
[ ! -L "$T/resolv.conf" ] || fail "resolv.conf still a symlink after damaged off"
cmp -s "$T/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf not restored after damaged off"
[ ! -e "$T/state/state.json" ] || fail "state file still present after damaged off"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "partial"' || fail "status is not partial over the damaged drop-in: $ST"
pass "damaged drop-in: off removes everything else, fails honestly, status partial"
# And the damage is recoverable: remove the directory, `off` goes green.
rmdir "$T/resolved.conf.d/20-veltrix-content-safety.conf"
"$HELPER" off > /dev/null 2>&1 || fail "off after clearing the damaged drop-in failed"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "status is not off after recovery: $ST"
pass "damaged drop-in: recoverable by removing the directory, off then clean"

# 2. The state write fails — the state directory replaced by a regular file,
#    so the state file cannot be created. `on` must fail BEFORE mutating
#    anything: no hosts block, no drop-in, no dispatcher, resolv.conf
#    untouched. (Before the state-first fix this repointed resolv.conf and
#    then failed, leaving the stub with no record of what it was.)
rm -rf "$T/state"
printf 'not a directory\n' > "$T/state"
cp "$T/hosts" "$T/hosts.before-state-fail"
cp "$T/resolv.conf" "$T/resolv.before-state-fail"
if "$HELPER" on > "$T/on-state-fail.log" 2>&1; then
    fail "on with an unwritable state dir exited 0 (must fail before mutating)"
fi
grep -q "cannot write state" "$T/on-state-fail.log" || fail "on did not report the state failure: $(cat "$T/on-state-fail.log")"
cmp -s "$T/hosts" "$T/hosts.before-state-fail" || fail "hosts mutated by a failed on"
cmp -s "$T/resolv.conf" "$T/resolv.before-state-fail" || fail "resolv.conf mutated by a failed on"
[ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in written by a failed on"
[ ! -e "$T/dispatcher.d/20-veltrix-content-safety" ] || fail "dispatcher written by a failed on"
pass "state-write failure: on aborts before mutating anything"
rm -f "$T/state"
mkdir -p "$T/state"

# 3. A mid-apply failure rolls back — the dispatcher path replaced by a
#    directory, so `on` writes the drop-in and then fails. The drop-in and
#    the hosts block must both be gone again, the state file this run wrote
#    removed, and resolv.conf untouched.
"$HELPER" off > /dev/null 2>&1
mkdir -p "$T/dispatcher.d/20-veltrix-content-safety"
if "$HELPER" on > "$T/on-rollback.log" 2>&1; then
    fail "on with a blocked dispatcher exited 0 (must fail and roll back)"
fi
[ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in not rolled back after failed on"
grep -q "VELTRIX CONTENT SAFETY" "$T/hosts" && fail "hosts block not rolled back after failed on"
[ ! -e "$T/state/state.json" ] || fail "state file not rolled back after failed on"
cmp -s "$T/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf mutated by a rolled-back on"
ST="$("$HELPER" status)"
# Partial, not off: the planted dispatcher DIRECTORY is still sitting at the
# dispatcher's path, and status (lexists) honestly reports it as present —
# the rollback only removes what this run created, never foreign damage.
# Removing the directory is the recovery, covered by the re-on/off below.
echo "$ST" | grep -q '"on": "partial"' || fail "status is not partial over the planted dispatcher directory: $ST"
echo "$ST" | grep -q '"dispatcher": true' || fail "status does not report the planted dispatcher directory: $ST"
pass "mid-apply failure: drop-in, hosts block and state rolled back, status partial over the planted directory"
rmdir "$T/dispatcher.d/20-veltrix-content-safety"
"$HELPER" on > /dev/null 2>&1 || fail "re-on after rollback scenario failed"
"$HELPER" off > /dev/null 2>&1 || fail "final off after rollback scenario failed"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "status is not off after rollback recovery: $ST"
pass "mid-apply failure: recoverable, re-on/off clean"

# 4. A dangling stub reads "partial", not "off" — resolv.conf left pointing
#    at the stub with a backup proving we put it there (the shape a failed
#    `on` from before the state-first fix left behind). `off` must restore
#    from the backup instead of claiming success over the stub.
"$HELPER" on > /dev/null 2>&1 || fail "re-on for scenario 4 failed"
rm -f "$T/state/state.json"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "on"' || fail "status is not on with state removed but layers present: $ST"
"$HELPER" off > "$T/off-dangling.log" 2>&1 || fail "off with no state file failed: $(cat "$T/off-dangling.log")"
[ ! -L "$T/resolv.conf" ] || fail "resolv.conf still a stub after backup-restore off"
cmp -s "$T/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf not restored from backup after off with no state"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "status is not off after backup-restore off: $ST"
pass "no state file + backup: off restores resolv.conf from the backup"

# ── New scenarios (fix pass #2) ─────────────────────────────────────────────
# 5. dns_on step 4 fails honestly (R3) — fake systemctl/resolvectl on PATH,
#    VELTRIX_CS_NO_SYSTEMD unset so the real step-4 code runs. The fakes'
#    behaviour is chosen by $FAKE_SYSTEMCTL_MODE / $FAKE_RESOLVECTL_STATUS.
#    Runs in a user+mount namespace with a fabricated /run/systemd/system,
#    so the S1 refusal never triggers and the scenarios run on any host.
mkdir -p "$T/fakebin"
cat > "$T/fakebin/systemctl" <<'EOF'
#!/bin/sh
# Fake systemctl for the step-4 scenarios.
#   FAKE_SYSTEMCTL_MODE=ok            — everything succeeds
#   FAKE_SYSTEMCTL_MODE=restart-fails — `restart` exits 1
# A marker file records enablement, so the probe can assert a failed `on`
# leaves no enablement side effect (fix pass #3, §3.1): `enable` creates
# it, `disable` removes it, `is-enabled` tests it. Every invocation is
# logged, so the probe can assert `enable` ran WITHOUT --now.
MARKER="$(dirname "$0")/resolved-enabled"
LOG="$(dirname "$0")/calls.log"
echo "$*" >> "$LOG"
case "$1" in
  is-active) exit 0 ;;
  is-enabled) [ -f "$MARKER" ] ;;
  enable) touch "$MARKER"; exit 0 ;;
  restart)
    if [ "${FAKE_SYSTEMCTL_MODE:-ok}" = "restart-fails" ]; then exit 1; fi
    exit 0 ;;
  disable) rm -f "$MARKER"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat > "$T/fakebin/resolvectl" <<'EOF'
#!/bin/sh
# Fake resolvectl for the step-4 scenarios.
#   FAKE_RESOLVECTL_STATUS=loaded   — `status` lists both CleanBrowsing IPs
#   FAKE_RESOLVECTL_STATUS=unloaded — `status` lists only the router
# Every other verb succeeds. The `status` output carries a Link line so the
# per-link loop in dns_on step 4 runs.
if [ "$1" = "status" ]; then
  if [ "${FAKE_RESOLVECTL_STATUS:-loaded}" = "loaded" ]; then
    printf 'Global\n  DNS Servers: 185.228.168.168\n               185.228.169.168\nLink 2 (eth0)\n  Current Scopes: DNS\n'
  else
    printf 'Global\n  DNS Servers: 192.168.1.1\nLink 2 (eth0)\n  Current Scopes: DNS\n'
  fi
  exit 0
fi
exit 0
EOF
chmod +x "$T/fakebin/systemctl" "$T/fakebin/resolvectl"
# Run the helper with the fakes on PATH and systemd "running" (fabricated
# marker), in a namespace so the host is untouched. Caller sets
# FAKE_SYSTEMCTL_MODE / FAKE_RESOLVECTL_STATUS as env prefixes.
run_fake() {
    env -u VELTRIX_CS_NO_SYSTEMD PATH="$T/fakebin:$PATH" unshare -rm sh -c '
mount -t tmpfs tmpfs /run/systemd
mkdir -p /run/systemd/system
exec "$@"
' _ "$@"
}
if unshare -rm true 2>/dev/null; then
    # 5a. The resolved restart fails: `on` must exit non-zero naming the
    #     failed step, and roll back everything instead of exiting 0 over a
    #     resolver that never started.
    if FAKE_SYSTEMCTL_MODE=restart-fails FAKE_RESOLVECTL_STATUS=loaded \
        run_fake "$HELPER" on > "$T/on-step4-fail.log" 2>&1; then
        fail "on with a failing resolved restart exited 0 (must fail honestly)"
    fi
    grep -q "systemctl restart systemd-resolved failed" "$T/on-step4-fail.log" || fail "on did not name the failed restart: $(cat "$T/on-step4-fail.log")"
    [ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in not rolled back after failed restart"
    grep -q "VELTRIX CONTENT SAFETY" "$T/hosts" && fail "hosts block not rolled back after failed restart"
    [ ! -e "$T/state/state.json" ] || fail "state file not rolled back after failed restart"
    cmp -s "$T/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf mutated by a failed restart"
    ST="$(FAKE_SYSTEMCTL_MODE=restart-fails FAKE_RESOLVECTL_STATUS=loaded run_fake "$HELPER" status)"
    echo "$ST" | grep -q '"on": "off"' || fail "status is not off after failed restart: $ST"
    pass "step-4 failure (restart): on fails honestly, everything rolled back"
    # 5b. The restart "succeeds" but resolved never picks up the drop-in:
    #     `on` must still fail, naming the unverified load.
    if FAKE_SYSTEMCTL_MODE=ok FAKE_RESOLVECTL_STATUS=unloaded \
        run_fake "$HELPER" on > "$T/on-notloaded.log" 2>&1; then
        fail "on with resolved not picking up the drop-in exited 0 (must fail honestly)"
    fi
    grep -q "did not pick up the CleanBrowsing servers" "$T/on-notloaded.log" || fail "on did not name the unverified load: $(cat "$T/on-notloaded.log")"
    [ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in not rolled back after unverified load"
    grep -q "VELTRIX CONTENT SAFETY" "$T/hosts" && fail "hosts block not rolled back after unverified load"
    cmp -s "$T/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf mutated by an unverified load"
    pass "step-4 failure (drop-in not picked up): on fails honestly, everything rolled back"
    # 5c. The success path with fakes: `on` exits 0 and `status` reports
    #     resolved_loaded true — and when resolved later stops serving our
    #     servers, the same status call downgrades "on" to "partial".
    FAKE_SYSTEMCTL_MODE=ok FAKE_RESOLVECTL_STATUS=loaded \
        run_fake "$HELPER" on > "$T/on-fake-ok.log" 2>&1 || fail "on with working fakes failed: $(cat "$T/on-fake-ok.log")"
    ST="$(FAKE_SYSTEMCTL_MODE=ok FAKE_RESOLVECTL_STATUS=loaded run_fake "$HELPER" status)"
    echo "$ST" | grep -q '"on": "on"' || fail "status is not on with fakes: $ST"
    echo "$ST" | grep -q '"resolved_loaded": true' || fail "status does not report resolved_loaded true: $ST"
    ST="$(FAKE_SYSTEMCTL_MODE=ok FAKE_RESOLVECTL_STATUS=unloaded run_fake "$HELPER" status)"
    echo "$ST" | grep -q '"on": "partial"' || fail "status is not partial when resolved drops the servers: $ST"
    echo "$ST" | grep -q '"resolved_loaded": false' || fail "status does not report resolved_loaded false: $ST"
    pass "step-4 success path (fakes): on exits 0, status on with resolved_loaded true, partial when resolved drops the servers"
    # 9d. The arch-chroot shape (security §3.1, fix pass #3): the marker is
    #     present — the guard passes, as it does under arch-chroot, where
    #     the host's /run is bind-mounted in — and resolvectl reports the
    #     servers unloaded, so the R3 load check must fail `on` honestly
    #     AND leave no enablement side effect: the `enable` in step 4 runs
    #     without --now, and the rollback disables again when this run
    #     enabled it. (5b above is the same failure without the
    #     enablement assertions; this is the side-effect check.)
    "$HELPER" off > /dev/null 2>&1 || fail "off before scenario 9d failed"
    rm -f "$T/fakebin/resolved-enabled" "$T/fakebin/calls.log"
    if FAKE_SYSTEMCTL_MODE=ok FAKE_RESOLVECTL_STATUS=unloaded \
        run_fake "$HELPER" on > "$T/on-arch-chroot.log" 2>&1; then
        fail "on in the arch-chroot shape exited 0 (must fail honestly)"
    fi
    grep -q "did not pick up the CleanBrowsing servers" "$T/on-arch-chroot.log" || fail "on did not name the unverified load: $(cat "$T/on-arch-chroot.log")"
    [ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in not rolled back after arch-chroot on"
    grep -q "VELTRIX CONTENT SAFETY" "$T/hosts" && fail "hosts block not rolled back after arch-chroot on"
    [ ! -e "$T/state/state.json" ] || fail "state file not rolled back after arch-chroot on"
    cmp -s "$T/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf mutated by an arch-chroot on"
    [ ! -e "$T/fakebin/resolved-enabled" ] || fail "failed arch-chroot on left resolved enabled (enablement side effect not rolled back)"
    grep -q "^enable systemd-resolved$" "$T/fakebin/calls.log" || fail "step 4 did not run a bare enable: $(cat "$T/fakebin/calls.log")"
    grep -q "enable --now" "$T/fakebin/calls.log" && fail "step 4 still runs enable --now: $(cat "$T/fakebin/calls.log")"
    pass "arch-chroot shape (9d): on fails, full rollback, no enablement side effect"
    "$HELPER" off > /dev/null 2>&1 || fail "off after fake-mode scenarios failed"
else
    echo "note: step-4 scenarios skipped (user namespaces unavailable on this host)" >&2
fi

# 6. A failed re-`on` must not delete pre-existing artifacts (R4). After a
#    successful `on`, block the dispatcher with a directory and re-run `on`:
#    it rewrites the drop-in, fails on the dispatcher, and must leave the
#    pre-existing drop-in, hosts block, state file and stub exactly as they
#    were — only a run that CREATED a layer may remove it.
"$HELPER" on > /dev/null 2>&1 || fail "re-on setup failed"
rm "$T/dispatcher.d/20-veltrix-content-safety"
mkdir "$T/dispatcher.d/20-veltrix-content-safety"
if "$HELPER" on > "$T/on-reon-fail.log" 2>&1; then
    fail "re-on with a blocked dispatcher exited 0 (must fail)"
fi
[ -f "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "failed re-on deleted the pre-existing drop-in"
grep -q "# BEGIN VELTRIX CONTENT SAFETY" "$T/hosts" || fail "failed re-on deleted the pre-existing hosts block"
[ -f "$T/state/state.json" ] || fail "failed re-on deleted the pre-existing state file"
[ -L "$T/resolv.conf" ] || fail "failed re-on removed the pre-existing stub"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "partial"' || fail "status is not partial after failed re-on: $ST"
pass "failed re-on: pre-existing drop-in, hosts block, state and stub kept"
rmdir "$T/dispatcher.d/20-veltrix-content-safety"
"$HELPER" on > /dev/null 2>&1 || fail "re-on after clearing the blocked dispatcher failed"
"$HELPER" off > /dev/null 2>&1 || fail "off after re-on scenario failed"
pass "failed re-on: recoverable, re-on/off clean"

# 7. A corrupt/empty state + backup + stub is recoverable by re-running `off`
#    (S4). The state file exists but parses to {} (or garbage) — `off` used
#    to treat that as "had state" and refuse the backup fallback forever,
#    failing until someone hand-edited the state.
"$HELPER" on > /dev/null 2>&1 || fail "re-on for scenario 7 failed"
printf '{}' > "$T/state/state.json"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "on"' || fail "status is not on with an empty state but layers present: $ST"
"$HELPER" off > "$T/off-corrupt.log" 2>&1 || fail "off with an empty state file failed: $(cat "$T/off-corrupt.log")"
[ ! -L "$T/resolv.conf" ] || fail "resolv.conf still a stub after off with empty state"
cmp -s "$T/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf not restored from backup after off with empty state"
pass "corrupt state ({}): off restores from the backup"
"$HELPER" on > /dev/null 2>&1 || fail "re-on for scenario 7b failed"
printf 'not json at all' > "$T/state/state.json"
"$HELPER" off > /dev/null 2>&1 || fail "off with an unparseable state file failed"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "status is not off after off with unparseable state: $ST"
pass "corrupt state (unparseable): off restores from the backup"

# 8. A failed state-file unlink is visible to `off`'s verdict (R4). Replace
#    the state file with a directory, so the unlink fails: `off` must exit
#    non-zero naming the state file, even though every other layer is gone.
"$HELPER" on > /dev/null 2>&1 || fail "re-on for scenario 8 failed"
rm "$T/state/state.json"
mkdir "$T/state/state.json"
if "$HELPER" off > "$T/off-state-dir.log" 2>&1; then
    fail "off with an undeletable state file exited 0 (must fail honestly)"
fi
grep -q "state file still present" "$T/off-state-dir.log" || fail "off did not name the stranded state file: $(cat "$T/off-state-dir.log")"
[ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in still present after state-dir off"
grep -q "VELTRIX CONTENT SAFETY" "$T/hosts" && fail "hosts block still present after state-dir off"
[ ! -L "$T/resolv.conf" ] || fail "resolv.conf still a stub after state-dir off"
pass "off verdict covers a failed state unlink"
rmdir "$T/state/state.json"
"$HELPER" off > /dev/null 2>&1 || fail "off after clearing the state directory failed"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "status is not off after state-dir recovery: $ST"
pass "off verdict: recoverable by removing the state directory, off then clean"

# 9. post_install guard (S1/N5): the scriptlet must not run `on` where
#    systemd is not running (chroot/container) and must not re-apply on a
#    reinstall. Tested in a user+mount namespace: an overlay over /usr/bin
#    adds a fake helper that logs its invocations, a tmpfs over
#    /run/systemd hides the booted-system marker (chroot), a tmpfs over
#    /etc carries a fake state file (reinstall). Every mount is
#    namespace-private; the host filesystem is untouched.
if unshare -rm true 2>/dev/null; then
    PI="$T/postinstall"
    mkdir -p "$PI/upper" "$PI/work" "$PI/log"
    printf '#!/bin/sh\necho "on $@" >> %s/log/calls\n' "$PI" > "$PI/upper/veltrix-content-safety"
    chmod +x "$PI/upper/veltrix-content-safety"
    pi_run() { # $1 = setup commands (run inside the namespace), $2 = output file
        rm -f "$PI/log/calls"
        unshare -rm sh -c "
set -e
mount -t overlay overlay -o lowerdir=/usr/bin,upperdir=$PI/upper,workdir=$PI/work /usr/bin
$1
. $REPO/packaging/veltrix/veltrix.install
post_install
" > "$2" 2>&1 || fail "post_install namespace run failed: $(cat "$2")"
    }
    # 9a. Chroot: no /run/systemd/system — the helper is never invoked and
    #     the scriptlet says so.
    pi_run "mount -t tmpfs tmpfs /run/systemd" "$T/pi-chroot.log"
    [ ! -e "$PI/log/calls" ] || fail "post_install ran the helper in a chroot: $(cat "$PI/log/calls")"
    grep -q "systemd is not running here" "$T/pi-chroot.log" || fail "post_install did not name the chroot skip: $(cat "$T/pi-chroot.log")"
    pass "post_install in a chroot: helper never invoked, skip named"
    # 9b. Live fresh install: systemd running, no prior cycle — `on` runs
    #     and the success notice is printed.
    pi_run ":" "$T/pi-live.log"
    grep -q "^on on$" "$PI/log/calls" || fail "post_install did not invoke the helper on a live fresh install: $(cat "$PI/log/calls" 2>/dev/null)"
    grep -q "Content Safety is on by default" "$T/pi-live.log" || fail "post_install printed no success notice: $(cat "$T/pi-live.log")"
    pass "post_install live fresh: helper invoked with on, success notice printed"
    # 9c. Reinstall: a state file already exists — the helper is never
    #     invoked, silently (the user already made their choice).
    pi_run "mount -t tmpfs tmpfs /etc; mkdir -p /etc/veltrix/content-safety; touch /etc/veltrix/content-safety/state.json" "$T/pi-reinstall.log"
    [ ! -e "$PI/log/calls" ] || fail "post_install re-applied on a reinstall: $(cat "$PI/log/calls")"
    grep -q "Content Safety" "$T/pi-reinstall.log" && fail "post_install said something about Content Safety on a reinstall: $(cat "$T/pi-reinstall.log")"
    pass "post_install reinstall: helper never invoked, silent"
else
    echo "note: post_install scenarios skipped (user namespaces unavailable on this host)" >&2
fi

# 10. `off` fails honestly when resolved will not restart (M2, fix pass #3).
#     A working install first (fakes, loaded), then the restart fails: `off`
#     must exit non-zero naming it, even though every file is removed —
#     resolved keeps serving CleanBrowsing from memory until it restarts.
#     Recoverable: with the restart fixed, `off` goes green (the state file
#     was already removed by the first run, so the retry is a clean no-op).
if unshare -rm true 2>/dev/null; then
    FAKE_SYSTEMCTL_MODE=ok FAKE_RESOLVECTL_STATUS=loaded \
        run_fake "$HELPER" on > /dev/null 2>&1 || fail "on for scenario 10 failed"
    if FAKE_SYSTEMCTL_MODE=restart-fails FAKE_RESOLVECTL_STATUS=loaded \
        run_fake "$HELPER" off > "$T/off-restart-fail.log" 2>&1; then
        fail "off with a failing resolved restart exited 0 (must fail honestly)"
    fi
    grep -q "systemctl restart systemd-resolved failed" "$T/off-restart-fail.log" || fail "off did not name the failed restart: $(cat "$T/off-restart-fail.log")"
    [ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in still present after failed-restart off"
    grep -q "VELTRIX CONTENT SAFETY" "$T/hosts" && fail "hosts block still present after failed-restart off"
    FAKE_SYSTEMCTL_MODE=ok FAKE_RESOLVECTL_STATUS=loaded \
        run_fake "$HELPER" off > /dev/null 2>&1 || fail "off after fixing the restart failed"
    ST="$("$HELPER" status)"
    echo "$ST" | grep -q '"on": "off"' || fail "status is not off after scenario 10 recovery: $ST"
    pass "off restart failure: off fails honestly (exit 3), recoverable"
else
    echo "note: off-restart scenario skipped (user namespaces unavailable on this host)" >&2
fi

# 11. An orphaned hosts marker (BEGIN without END — the shape a hand-edit
#     or a truncated write leaves behind). `on` must refuse BEFORE mutating
#     anything (no second block, hosts byte-identical, no DNS artifacts);
#     `status` must say "partial", never a clean "off" over the stray
#     marker; `off` must fail honestly naming the hosts block instead of
#     exiting 0. Recoverable: remove the stray marker by hand, on/off clean.
"$HELPER" off > /dev/null 2>&1 || fail "off before scenario 11 failed"
printf '127.0.0.1 localhost\n::1 localhost\n192.168.1.5 myserver.local\n# BEGIN VELTRIX CONTENT SAFETY\n0.0.0.0 pornhub.com\n' > "$T/hosts"
cp "$T/hosts" "$T/hosts.orphan"
if "$HELPER" on > "$T/on-orphan.log" 2>&1; then
    fail "on over an orphaned BEGIN marker exited 0 (must refuse)"
fi
grep -q "orphaned content-safety marker" "$T/on-orphan.log" || fail "on did not name the orphaned marker: $(cat "$T/on-orphan.log")"
cmp -s "$T/hosts" "$T/hosts.orphan" || fail "hosts mutated by a refused on (orphan)"
[ ! -e "$T/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "drop-in written by a refused on (orphan)"
[ ! -e "$T/state/state.json" ] || fail "state file written by a refused on (orphan)"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "partial"' || fail "status is not partial over the orphaned marker: $ST"
if "$HELPER" off > "$T/off-orphan.log" 2>&1; then
    fail "off over an orphaned BEGIN marker exited 0 (must fail honestly)"
fi
grep -q "hosts block still present" "$T/off-orphan.log" || fail "off did not name the stranded hosts block: $(cat "$T/off-orphan.log")"
pass "orphaned BEGIN marker: on refuses without mutating, status partial, off fails honestly"
# Recovery: clear the stray marker by hand, on/off go clean again.
printf '127.0.0.1 localhost\n::1 localhost\n192.168.1.5 myserver.local\n' > "$T/hosts"
"$HELPER" on > /dev/null 2>&1 || fail "on after clearing the orphaned marker failed"
"$HELPER" off > /dev/null 2>&1 || fail "off after clearing the orphaned marker failed"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "status is not off after orphan recovery: $ST"
pass "orphaned BEGIN marker: recoverable by removing the stray marker, on/off clean"

# ── 12. Masjid OS → VELTRIX adoption (1.3) ─────────────────────────────────
# A machine upgraded from Masjid OS carries the OLD names: a MASJID block
# in /etc/hosts, /etc/masjid/content-safety/state.json,
# /etc/hosts.masjid-backup, /etc/resolv.conf.masjid-backup, the
# 20-masjid-content-safety drop-in/dispatcher, and a stub resolv.conf.
# `on` must adopt all of them: exactly one (VELTRIX) block afterwards,
# the three files MOVED to the new locations, the legacy DNS artifacts
# gone — and a later `off` must leave a hosts file with NO block and
# content equal to the old backup, with resolv.conf restored.
# Fixture trees (each with its own env, legacy paths via *_LEGACY):
#   $L  — legacy-only (case a) + backup-never-overwritten (case d)
#   $L3 — BOTH blocks, no legacy hosts backup (case c + cleaned backup)
#   $L2 — fresh tree, no legacy files at all (case b)
legacy_domains() {
    grep -v '^#' "$REPO/defaults/content-safety/blocklist.txt" | grep -v '^$' | sed 's/^/0.0.0.0 /'
}
adopt_env() { # $1 = tree dir
    export VELTRIX_CS_HOSTS="$1/hosts"
    export VELTRIX_CS_HOSTS_BACKUP="$1/hosts.veltrix-backup"
    export VELTRIX_CS_HOSTS_BACKUP_LEGACY="$1/hosts.masjid-backup"
    export VELTRIX_CS_RESOLVED_DIR="$1/resolved.conf.d"
    export VELTRIX_CS_DISPATCHER="$1/dispatcher.d/20-veltrix-content-safety"
    export VELTRIX_CS_RESOLV_CONF="$1/resolv.conf"
    export VELTRIX_CS_RESOLV_BACKUP="$1/resolv.conf.veltrix-backup"
    export VELTRIX_CS_RESOLV_BACKUP_LEGACY="$1/resolv.conf.masjid-backup"
    export VELTRIX_CS_STATE_DIR="$1/state"
    export VELTRIX_CS_STATE_DIR_LEGACY="$1/legacy-state"
    export VELTRIX_CS_NO_SYSTEMD=1
}
plant_legacy_dns() { # $1 = tree dir — legacy drop-in/dispatcher + stub resolv.conf
    mkdir -p "$1/resolved.conf.d" "$1/dispatcher.d"
    printf '# Managed by masjid-content-safety.\n[Resolve]\nDNS=185.228.168.168#family-filter-dns.cleanbrowsing.org 185.228.169.168#family-filter-dns.cleanbrowsing.org\nDNSOverTLS=yes\nDomains=~.\n' \
        > "$1/resolved.conf.d/20-masjid-content-safety.conf"
    printf '#!/bin/sh\n# legacy dispatcher\n' > "$1/dispatcher.d/20-masjid-content-safety"
    chmod +x "$1/dispatcher.d/20-masjid-content-safety"
    printf 'nameserver 192.168.1.1\n' > "$1/resolv.conf.masjid-backup"
    ln -s /run/systemd/resolve/stub-resolv.conf "$1/resolv.conf"
    mkdir -p "$1/legacy-state"
    printf '{"resolved_was_active": false, "resolv_conf_was": "regular"}' > "$1/legacy-state/state.json"
}
# (a) Legacy-only: old block + old state + old backup.
L="$(mktemp -d /tmp/veltrix-cs-legacy.XXXXXX)"
printf '127.0.0.1 localhost\n::1 localhost\n192.168.1.5 myserver.local\n' > "$L/hosts.orig"
{ cat "$L/hosts.orig"; echo "# BEGIN MASJID CONTENT SAFETY"; legacy_domains; echo "# END MASJID CONTENT SAFETY"; } > "$L/hosts"
cp "$L/hosts.orig" "$L/hosts.masjid-backup"
plant_legacy_dns "$L"
adopt_env "$L"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "partial"' || fail "status is not partial over the legacy block before adoption: $ST"
"$HELPER" on > "$L/on.log" 2>&1 || fail "adoption on exited $?: $(cat "$L/on.log")"
[ "$(grep -c 'BEGIN VELTRIX CONTENT SAFETY' "$L/hosts")" = 1 ] || fail "adoption on did not leave exactly one VELTRIX block"
grep -q "MASJID CONTENT SAFETY" "$L/hosts" && fail "adoption on left the legacy block behind"
[ "$(grep -c '^0.0.0.0 ' "$L/hosts")" = 76 ] || fail "adoption on blocked != 76 domains"
[ -f "$L/hosts.veltrix-backup" ] || fail "no hosts backup after adoption on"
cmp -s "$L/hosts.veltrix-backup" "$L/hosts.orig" || fail "adopted hosts backup differs from the clean original"
[ ! -e "$L/hosts.masjid-backup" ] || fail "legacy hosts backup was copied, not moved"
[ -f "$L/state/state.json" ] || fail "no state file after adoption on"
grep -q '"resolv_conf_was": "regular"' "$L/state/state.json" || fail "adopted state is not the legacy one (resolv_conf_was should be regular, not stub): $(cat "$L/state/state.json")"
[ ! -e "$L/legacy-state/state.json" ] || fail "legacy state file was copied, not moved"
[ -f "$L/resolv.conf.veltrix-backup" ] || fail "no resolv.conf backup after adoption on"
cmp -s "$L/resolv.conf.veltrix-backup" <(printf 'nameserver 192.168.1.1\n') || fail "adopted resolv.conf backup is not the original"
[ ! -e "$L/resolv.conf.masjid-backup" ] || fail "legacy resolv.conf backup was copied, not moved"
[ ! -e "$L/resolved.conf.d/20-masjid-content-safety.conf" ] || fail "legacy drop-in still present after adoption on"
[ ! -e "$L/dispatcher.d/20-masjid-content-safety" ] || fail "legacy dispatcher still present after adoption on"
[ -f "$L/resolved.conf.d/20-veltrix-content-safety.conf" ] || fail "no new drop-in after adoption on"
[ -x "$L/dispatcher.d/20-veltrix-content-safety" ] || fail "no new dispatcher after adoption on"
[ -L "$L/resolv.conf" ] || fail "resolv.conf is not a stub after adoption on"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "on"' || fail "status is not on after adoption: $ST"
echo "$ST" | grep -q '"blocked": 76' || fail "status blocked != 76 after adoption: $ST"
pass "adoption (a): legacy-only on → one VELTRIX block, state+backups moved, legacy DNS artifacts gone, status on"
"$HELPER" off > "$L/off.log" 2>&1 || fail "off after adoption exited $?: $(cat "$L/off.log")"
grep -q "CONTENT SAFETY" "$L/hosts" && fail "hosts block still present after adoption off"
cmp -s "$L/hosts" "$L/hosts.orig" || fail "hosts file after adoption off is not the clean original"
[ ! -L "$L/resolv.conf" ] || fail "resolv.conf still a stub after adoption off"
cmp -s "$L/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "resolv.conf not restored to the original after adoption off"
[ ! -e "$L/state/state.json" ] || fail "state file still present after adoption off"
[ -f "$L/hosts.veltrix-backup" ] || fail "adopted hosts backup was deleted by off"
cmp -s "$L/hosts.veltrix-backup" "$L/hosts.orig" || fail "adopted hosts backup changed by off"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "status is not off after adoption off: $ST"
pass "adoption (a): off after adoption → hosts byte-identical to the old backup, resolv.conf restored, status off"
# (d) The backup is never overwritten on a second `on` — tamper with the
#     hosts file after off, re-run `on`, and the backup must still be the
#     clean original, not the tampered file.
printf '1.2.3.4 tampered.example\n' >> "$L/hosts"
"$HELPER" on > /dev/null 2>&1 || fail "second on for scenario (d) failed"
cmp -s "$L/hosts.veltrix-backup" "$L/hosts.orig" || fail "second on overwrote the hosts backup with the tampered file"
[ "$(grep -c 'BEGIN VELTRIX CONTENT SAFETY' "$L/hosts")" = 1 ] || fail "second on did not restore exactly one block"
pass "adoption (d): backup never overwritten on a second on (tampered hosts, backup still the clean original)"
"$HELPER" off > /dev/null 2>&1 || fail "off after scenario (d) failed"
# (c) BOTH blocks, no legacy hosts backup: `on` must leave exactly one
#     block, and the backup it takes must be the CLEAN text — never a
#     hosts file that still contains a managed block.
L3="$(mktemp -d /tmp/veltrix-cs-both.XXXXXX)"
printf '127.0.0.1 localhost\n::1 localhost\n192.168.1.5 myserver.local\n' > "$L3/hosts.orig"
{ cat "$L3/hosts.orig"; echo "# BEGIN VELTRIX CONTENT SAFETY"; legacy_domains; echo "# END VELTRIX CONTENT SAFETY"; echo "# BEGIN MASJID CONTENT SAFETY"; legacy_domains; echo "# END MASJID CONTENT SAFETY"; } > "$L3/hosts"
plant_legacy_dns "$L3"  # state + resolv backup + legacy DNS artifacts, but NO legacy hosts backup
adopt_env "$L3"
"$HELPER" on > "$L3/on.log" 2>&1 || fail "both-blocks on exited $?: $(cat "$L3/on.log")"
[ "$(grep -c 'BEGIN VELTRIX CONTENT SAFETY' "$L3/hosts")" = 1 ] || fail "both-blocks on did not leave exactly one VELTRIX block"
grep -q "MASJID CONTENT SAFETY" "$L3/hosts" && fail "both-blocks on left the legacy block behind"
[ "$(grep -c '^0.0.0.0 ' "$L3/hosts")" = 76 ] || fail "both-blocks on blocked != 76 domains"
[ -f "$L3/hosts.veltrix-backup" ] || fail "no hosts backup after both-blocks on"
cmp -s "$L3/hosts.veltrix-backup" "$L3/hosts.orig" || fail "both-blocks backup contains a managed block (want the clean original)"
"$HELPER" off > /dev/null 2>&1 || fail "off after both-blocks on failed"
grep -q "CONTENT SAFETY" "$L3/hosts" && fail "hosts block still present after both-blocks off"
cmp -s "$L3/hosts" "$L3/hosts.orig" || fail "hosts file after both-blocks off is not the clean original"
pass "adoption (c): both blocks → on leaves exactly one, backup is the clean text, off restores byte-identical"
# (b) Fresh tree, no legacy files at all: the normal on/off round-trip
#     is unchanged by the adoption code (and the *_LEGACY overrides are
#     inert when nothing legacy exists).
L2="$(mktemp -d /tmp/veltrix-cs-fresh.XXXXXX)"
printf '127.0.0.1 localhost\n::1 localhost\n192.168.1.5 myserver.local\n' > "$L2/hosts"
printf 'nameserver 192.168.1.1\n' > "$L2/resolv.conf"
cp "$L2/hosts" "$L2/hosts.orig"
adopt_env "$L2"
"$HELPER" on > /dev/null 2>&1 || fail "fresh-tree on failed"
[ "$(grep -c '^0.0.0.0 ' "$L2/hosts")" = 76 ] || fail "fresh-tree on blocked != 76 domains"
cmp -s "$L2/hosts.veltrix-backup" "$L2/hosts.orig" || fail "fresh-tree backup differs from the original"
"$HELPER" off > /dev/null 2>&1 || fail "fresh-tree off failed"
cmp -s "$L2/hosts" "$L2/hosts.orig" || fail "fresh-tree hosts not restored byte-for-byte after off"
cmp -s "$L2/resolv.conf" <(printf 'nameserver 192.168.1.1\n') || fail "fresh-tree resolv.conf not restored after off"
ST="$("$HELPER" status)"
echo "$ST" | grep -q '"on": "off"' || fail "fresh-tree status is not off: $ST"
pass "adoption (b): fresh tree with no legacy files → on/off round-trip unchanged"
rm -rf "$L" "$L2" "$L3"
# Restore the main fixture's env for the rest of the probe (the
# unprivileged-status and mount-namespace checks below run against $T).
export VELTRIX_CS_HOSTS="$T/hosts"
export VELTRIX_CS_HOSTS_BACKUP="$T/hosts.veltrix-backup"
export VELTRIX_CS_RESOLVED_DIR="$T/resolved.conf.d"
export VELTRIX_CS_DISPATCHER="$T/dispatcher.d/20-veltrix-content-safety"
export VELTRIX_CS_RESOLV_CONF="$T/resolv.conf"
export VELTRIX_CS_RESOLV_BACKUP="$T/resolv.conf.veltrix-backup"
export VELTRIX_CS_STATE_DIR="$T/state"
unset VELTRIX_CS_HOSTS_BACKUP_LEGACY VELTRIX_CS_RESOLV_BACKUP_LEGACY VELTRIX_CS_STATE_DIR_LEGACY

# status must work unprivileged too (it only reads files). The helper lives
# under this repo, whose home directory uid 1000 cannot traverse — so the
# check copies it (and the blocklist) to a world-readable directory first
# and runs it there as uid 1000. `setpriv` itself exists here; the old note
# ("setpriv unavailable?") was wrong (N6, code review v2): the skip was a
# traversal failure, exit 126, not a missing tool.
mkdir -p "$T/unpriv"
cp "$HELPER" "$T/unpriv/veltrix-content-safety"
cp "$REPO/defaults/content-safety/blocklist.txt" "$T/unpriv/blocklist.txt"
chmod 755 "$T" "$T/unpriv" "$T/unpriv/veltrix-content-safety"
if command -v setpriv >/dev/null 2>&1; then
    ST="$(setpriv --reuid=1000 --regid=1000 --clear-groups \
        env VELTRIX_CS_BLOCKLIST="$T/unpriv/blocklist.txt" \
        "$T/unpriv/veltrix-content-safety" status 2>"$T/unpriv.err" || true)"
    if echo "$ST" | grep -q '"on": "off"'; then
        pass "unprivileged status works (uid 1000, world-readable copy)"
    else
        echo "note: unprivileged status did not report off: $ST $(cat "$T/unpriv.err")" >&2
    fi
else
    echo "note: unprivileged status skipped (setpriv is not installed on this host)" >&2
fi

if [ "${VELTRIX_CS_REAL_HOSTS:-0}" = 1 ]; then
    # Real resolution check in a mount namespace: the scratch hosts file (with
    # the block re-applied) becomes /etc/hosts; getent must answer 0.0.0.0 for
    # an adult domain and a real address for a normal one.
    "$HELPER" on > /dev/null 2>&1
    unshare -rm sh -c "mount --bind '$T/hosts' /etc/hosts && getent hosts pornhub.com && getent hosts example.com" > "$T/ns.log" 2>&1 \
        || fail "mount-namespace check failed: $(cat "$T/ns.log")"
    grep -q '^0.0.0.0 *pornhub.com' "$T/ns.log" || fail "getent did not return 0.0.0.0 for pornhub.com: $(cat "$T/ns.log")"
    grep -q 'example.com' "$T/ns.log" || fail "getent did not resolve example.com: $(cat "$T/ns.log")"
    grep -v '^0.0.0.0' "$T/ns.log" | grep -q 'example.com' || fail "example.com resolved to the block address: $(cat "$T/ns.log")"
    pass "mount-namespace: getent pornhub.com → 0.0.0.0, example.com → real address"
    "$HELPER" off > /dev/null 2>&1
fi

echo "content-safety-probe: ALL PASS"
