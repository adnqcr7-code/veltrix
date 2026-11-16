#!/usr/bin/env python3
"""Unit tests for bin/veltrix-anonymity.

Runs the real CLI as a subprocess against a scratch tree, with stub
binaries (nft / systemctl / nmcli / tor / curl / dig) standing in for
the system. No Tor, no nftables, no NetworkManager, no network needed.
Nothing leaves the machine; nothing touches the real /etc.

Run:  python3 scripts/dev/anonymity-test.py
   or scripts/dev/anonymity-probe.sh (also runs the no-telemetry audit)

The stubs live in a temp dir per test case and record every call they
receive, so the tests assert on what the CLI actually asked the system
to do — not on what it claims in its own state file.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CLI = os.path.join(REPO, "bin", "veltrix-anonymity")
TOR_UID = 975

SYSTEMCTL_STUB = """#!/bin/bash
# Fake systemctl: tracks tor.service active/inactive in a state file.
STATE="$FAKE_STATE/tor-active"
case "$1" in
  is-active) [ -f "$STATE" ] && echo active || { echo inactive; exit 3; } ;;
  start) echo "$2" >> "$FAKE_STATE/systemctl.log"; touch "$STATE" ;;
  stop) echo "$2" >> "$FAKE_STATE/systemctl.log"; rm -f "$STATE" ;;
  reload) echo "$2" >> "$FAKE_STATE/systemctl.log" ;;
  *) echo "$@" >> "$FAKE_STATE/systemctl.log" ;;
esac
exit 0
"""

NFT_STUB = """#!/bin/bash
# Fake nft: records invocations; -f reads the ruleset from stdin or a
# file and saves it; list prints the saved ruleset back; -c checks that
# the file exists and is non-empty. Set FAKE_NFT_FAIL=1 to fail applies.
echo "nft $@" >> "$FAKE_STATE/nft.log"
if [ "$1" = "-c" ]; then
  [ -n "$FAKE_NFT_FAIL" ] && exit 1
  exit 0
fi
if [ "$1" = "-f" ]; then
  [ -n "$FAKE_NFT_FAIL" ] && exit 1
  if [ "$2" = "-" ]; then cat > "$FAKE_STATE/nft.rules"; else cat "$2" > "$FAKE_STATE/nft.rules"; fi
  exit 0
fi
if [ "$1" = "list" ]; then
  [ -f "$FAKE_STATE/nft.rules" ] && cat "$FAKE_STATE/nft.rules" || exit 1
  exit 0
fi
exit 0
"""

NMCLI_STUB = """#!/bin/bash
# Fake nmcli: a fixed connection list; modify/reload/down/up are logged.
echo "nmcli $@" >> "$FAKE_STATE/nmcli.log"
if [ "$1" = "-t" ]; then
  if [ "${@: -1}" = "--active" ]; then
    printf 'HomeWifi\\n'
    exit 0
  fi
  case "$3" in
    NAME,TYPE) printf 'HomeWifi:802-11-wireless\\nOfficeEth:802-3-ethernet\\nProtonVPN:vpn\\n'; exit 0 ;;
    NAME) printf 'HomeWifi\\nOfficeEth\\nProtonVPN\\n'; exit 0 ;;
    wifi.cloned-mac-address) printf 'wifi.cloned-mac-address:permanent\\n'; exit 0 ;;
    ethernet.cloned-mac-address) printf 'ethernet.cloned-mac-address:\\n'; exit 0 ;;
  esac
fi
exit 0
"""

CURL_STUB = """#!/bin/bash
# Fake curl: prints the canned check.torproject.org answer.
printf '%s\\n' "$FAKE_CURL_JSON"
"""

DIG_STUB = """#!/bin/bash
# Fake dig: prints one answer line, like a successful Tor DNS lookup.
printf '93.184.216.34\\n'
"""


class AnonymityTest(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix="veltrix-anon-test.")
        self.addCleanup(shutil.rmtree, self.t, True)
        self.state = os.path.join(self.t, "state")
        os.makedirs(self.state)
        self.etc = os.path.join(self.t, "etc")
        os.makedirs(os.path.join(self.etc, "tor", "torrc.d"), exist_ok=True)
        os.makedirs(os.path.join(self.etc, "NetworkManager", "conf.d"),
                    exist_ok=True)
        # resolv.conf as a symlink, like a stock Arch box with resolved.
        os.symlink("/run/systemd/resolve/stub-resolv.conf",
                   os.path.join(self.etc, "resolv.conf"))
        self.bindir = os.path.join(self.t, "bin")
        os.makedirs(self.bindir)
        for name, body in (("systemctl", SYSTEMCTL_STUB),
                           ("nft", NFT_STUB),
                           ("nmcli", NMCLI_STUB),
                           ("curl", CURL_STUB),
                           ("dig", DIG_STUB)):
            path = os.path.join(self.bindir, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
            os.chmod(path, 0o755)
        # A fake `tor` binary so shutil.which finds it.
        tor = os.path.join(self.bindir, "tor")
        with open(tor, "w", encoding="utf-8") as f:
            f.write("#!/bin/bash\nexit 0\n")
        os.chmod(tor, 0o755)
        self.env = dict(os.environ)
        self.env.update({
            "VELTRIX_ANON_TEST_MODE": "1",
            "VELTRIX_ANON_TOR_UID": str(TOR_UID),
            "VELTRIX_ANON_STATE_DIR": os.path.join(self.etc, "veltrix",
                                                   "anonymity"),
            "VELTRIX_ANON_RESOLV_CONF": os.path.join(self.etc, "resolv.conf"),
            "VELTRIX_ANON_RESOLV_BACKUP": os.path.join(
                self.etc, "resolv.conf.veltrix-anonymity-backup"),
            "VELTRIX_ANON_TORRC_DIR": os.path.join(self.etc, "tor", "torrc.d"),
            "VELTRIX_ANON_NM_CONF_DIR": os.path.join(
                self.etc, "NetworkManager", "conf.d"),
            "VELTRIX_ANON_NFT": os.path.join(self.bindir, "nft"),
            "VELTRIX_ANON_SYSTEMCTL": os.path.join(self.bindir, "systemctl"),
            "VELTRIX_ANON_NMCLI": os.path.join(self.bindir, "nmcli"),
            "VELTRIX_ANON_TOR_BIN": os.path.join(self.bindir, "tor"),
            "VELTRIX_ANON_CURL": os.path.join(self.bindir, "curl"),
            "VELTRIX_ANON_DIG": os.path.join(self.bindir, "dig"),
            "VELTRIX_ANON_PACMAN": os.path.join(self.bindir, "pacman"),
            "FAKE_STATE": self.state,
            "FAKE_CURL_JSON": '{"IsTor": true, "IP": "1.2.3.4"}',
        })

    def run_cli(self, *args, env_extra=None):
        env = dict(self.env)
        if env_extra:
            env.update(env_extra)
        proc = subprocess.run([sys.executable, CLI] + list(args),
                              capture_output=True, text=True, env=env,
                              timeout=60)
        return proc

    def state_file(self):
        path = os.path.join(self.etc, "veltrix", "anonymity", "state.json")
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def log(self, name):
        path = os.path.join(self.state, name)
        if not os.path.isfile(path):
            return ""
        with open(path, encoding="utf-8") as f:
            return f.read()

    # ── Ruleset generation ──────────────────────────────────────────

    def test_ruleset_has_kill_switch(self):
        proc = self.run_cli("rules")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = proc.stdout
        self.assertIn("table inet veltrix-anon", text)
        self.assertIn("policy drop;", text)
        self.assertIn("redirect to :9040", text)
        self.assertIn("redirect to :5353", text)
        self.assertIn("meta skuid %d" % TOR_UID, text)
        self.assertIn("meta nfproto ipv6 drop", text)
        self.assertIn("udp dport 67 ip daddr 255.255.255.255 accept", text)
        # No clearnet allow anywhere.
        for line in text.splitlines():
            line = line.strip()
            if line.endswith("accept"):
                self.assertRegex(
                    line,
                    r"(oifname \"lo\"|iifname \"lo\"|ct state established,related"
                    r"|meta skuid \d+|tcp dport 9040"
                    r"|udp dport 5353 ip daddr 127\.0\.0\.1"
                    r"|udp dport 67 ip daddr 255\.255\.255\.255"
                    r"|udp sport 67 udp dport 68)\s+accept",
                    "unexpected accept: %s" % line)

    def test_ruleset_validation_catches_tampering(self):
        import importlib.util
        import importlib.machinery
        loader = importlib.machinery.SourceFileLoader("anonymity", CLI)
        spec = importlib.util.spec_from_loader("anonymity", loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        good = mod.generate_ruleset(TOR_UID)
        self.assertEqual(mod.validate_ruleset(good), [])
        # Missing the drop: the kill-switch is gone.
        broken = good.replace("policy drop;", "policy accept;", 1)
        self.assertTrue(mod.validate_ruleset(broken))
        # Missing the TCP redirect: traffic bypasses Tor.
        broken = good.replace("tcp dport != 9040 redirect to :9040\n", "")
        self.assertTrue(mod.validate_ruleset(broken))
        # A clearnet allow smuggled in.
        broken = good.replace(
            'meta skuid %d accept' % TOR_UID,
            'meta skuid %d accept\n        ip daddr 0.0.0.0/0 accept' % TOR_UID)
        problems = mod.validate_ruleset(broken)
        self.assertTrue(any("clearnet" in p for p in problems), problems)
        # Unbalanced braces.
        self.assertTrue(mod.validate_ruleset(good + "{"))

    # ── Mode switching ──────────────────────────────────────────────

    def test_on_then_off_round_trip(self):
        proc = self.run_cli("on")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        st = self.state_file()
        self.assertEqual(st["mode"], "tor")
        self.assertTrue(st["rules_applied"])
        self.assertEqual(st["tor_was_active"], False)
        self.assertEqual(st["resolv"], {"kind": "symlink",
                                        "target": "/run/systemd/resolve/stub-resolv.conf"})
        self.assertEqual(st["mac"]["HomeWifi"]["prev"], "permanent")
        self.assertEqual(st["mac"]["OfficeEth"]["prev"], "")
        # nft got the ruleset with the kill-switch in it.
        rules = self.log("nft.rules")
        self.assertIn("policy drop;", rules)
        self.assertIn("redirect to :9040", rules)
        # Tor was started, torrc drop-in written.
        self.assertIn("tor.service", self.log("systemctl.log"))
        self.assertTrue(os.path.isfile(os.path.join(
            self.etc, "tor", "torrc.d", "veltrix-anonymity.conf")))
        # resolv.conf now points at Tor; the old symlink is not clobbered
        # by a backup (there is no file to back up — the record is the
        # symlink target in the state file).
        with open(os.path.join(self.etc, "resolv.conf"),
                  encoding="utf-8") as f:
            self.assertIn("nameserver 127.0.0.1", f.read())
        self.assertFalse(os.path.islink(os.path.join(self.etc, "resolv.conf")))
        # MAC: conf.d written, both connections set to random.
        self.assertTrue(os.path.isfile(os.path.join(
            self.etc, "NetworkManager", "conf.d",
            "90-veltrix-anonymity.conf")))
        nm = self.log("nmcli.log")
        self.assertIn("connection modify HomeWifi wifi.cloned-mac-address random", nm)
        self.assertIn("connection modify OfficeEth ethernet.cloned-mac-address random", nm)

        proc = self.run_cli("off")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(os.path.exists(os.path.join(
            self.etc, "veltrix", "anonymity", "state.json")))
        # resolv.conf is the stub symlink again, byte-identical to before.
        self.assertTrue(os.path.islink(os.path.join(self.etc, "resolv.conf")))
        self.assertEqual(os.readlink(os.path.join(self.etc, "resolv.conf")),
                         "/run/systemd/resolve/stub-resolv.conf")
        # MAC values restored, conf.d gone, tor stopped.
        nm = self.log("nmcli.log")
        self.assertIn("connection modify HomeWifi wifi.cloned-mac-address permanent", nm)
        self.assertIn("connection modify OfficeEth ethernet.cloned-mac-address ", nm)
        self.assertFalse(os.path.exists(os.path.join(
            self.etc, "NetworkManager", "conf.d",
            "90-veltrix-anonymity.conf")))
        self.assertFalse(os.path.exists(os.path.join(
            self.etc, "tor", "torrc.d", "veltrix-anonymity.conf")))
        self.assertFalse(os.path.exists(os.path.join(self.state, "tor-active")))

    def test_on_is_idempotent_and_off_is_a_noop(self):
        self.assertEqual(self.run_cli("on").returncode, 0)
        proc = self.run_cli("on")
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(self.run_cli("off").returncode, 0)
        proc = self.run_cli("off")
        self.assertEqual(proc.returncode, 3)

    def test_on_without_tor_is_exit_2(self):
        proc = self.run_cli("on", env_extra={
            "VELTRIX_ANON_TOR_BIN": os.path.join(self.bindir, "no-such-tor")})
        self.assertEqual(proc.returncode, 2)
        self.assertIn("not installed", proc.stderr)

    def test_on_rolls_back_when_nft_fails(self):
        proc = self.run_cli("on", env_extra={"FAKE_NFT_FAIL": "1"})
        self.assertEqual(proc.returncode, 1)
        # resolv.conf untouched (still the symlink), torrc gone, tor stopped.
        self.assertTrue(os.path.islink(os.path.join(self.etc, "resolv.conf")))
        self.assertFalse(os.path.exists(os.path.join(
            self.etc, "tor", "torrc.d", "veltrix-anonymity.conf")))
        self.assertFalse(os.path.exists(os.path.join(self.state, "tor-active")))
        self.assertFalse(os.path.exists(os.path.join(
            self.etc, "NetworkManager", "conf.d",
            "90-veltrix-anonymity.conf")))

    def test_apply_restores_at_boot_and_is_a_noop_when_off(self):
        proc = self.run_cli("apply")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(self.run_cli("on").returncode, 0)
        # Simulate a reboot: nft table gone, tor stopped, state kept.
        os.unlink(os.path.join(self.state, "nft.rules"))
        os.unlink(os.path.join(self.state, "tor-active"))
        proc = self.run_cli("apply")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("policy drop;", self.log("nft.rules"))
        self.assertTrue(os.path.exists(os.path.join(self.state, "tor-active")))

    def test_verify_passes_on_applied_rules(self):
        self.assertEqual(self.run_cli("on").returncode, 0)
        proc = self.run_cli("verify")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("OK:", proc.stdout)

    # ── Status + leak-check ─────────────────────────────────────────

    def test_status_json_shape(self):
        proc = self.run_cli("status")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["mode"], "off")
        self.assertTrue(data["tor_installed"])
        self.assertEqual(data["kill_switch"], "off")
        self.assertEqual(data["vpn_active"], None)
        self.assertEqual(self.run_cli("on").returncode, 0)
        data = json.loads(self.run_cli("status").stdout)
        self.assertEqual(data["mode"], "tor")
        self.assertTrue(data["tor_active"])
        # No SOCKS listener exists in the fixture, so this is honestly
        # False here — on the Dell, Tor listening makes it True.
        self.assertFalse(data["socks_reachable"])
        self.assertEqual(data["kill_switch"], "armed")
        self.assertTrue(data["resolv_points_at_tor"])
        self.assertTrue(data["mac_randomized"])

    def test_leak_check_with_fake_endpoints(self):
        proc = self.run_cli("leak-check")
        data = json.loads(proc.stdout)
        self.assertFalse(data["checked"])
        self.assertEqual(self.run_cli("on").returncode, 0)
        proc = self.run_cli("leak-check")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertTrue(data["checked"])
        self.assertTrue(data["tor"])
        self.assertEqual(data["exit_ip"], "1.2.3.4")
        self.assertTrue(data["dns_via_tor"])
        # A non-Tor answer is reported honestly, not hidden.
        proc = self.run_cli(
            "leak-check",
            env_extra={"FAKE_CURL_JSON": '{"IsTor": false, "IP": "9.9.9.9"}'})
        data = json.loads(proc.stdout)
        self.assertFalse(data["tor"])
        self.assertEqual(data["exit_ip"], "9.9.9.9")


if __name__ == "__main__":
    unittest.main(verbosity=2)
