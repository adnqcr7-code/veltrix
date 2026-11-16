#!/usr/bin/env python3
"""prayer-lock-test.py — verification harness for the prayer lock.

Run:  python3 scripts/dev/prayer-lock-test.py [--fast]

What it proves (docs/prayer-lock-fix-report-1.md carries the numbers):
  T1  al-falak times (mosque-calibrated: Dhuhr -1, Asr +2) vs THREE sources
      — ICSWO (local mosque), searchtruth, timesprayer — Nov 12–18 2026,
      all five prayers, ±2 min bar.
  T2  The --due/--next selector across all five prayers and boundaries:
      1 s before, at the instant, +60 s, +299 s / +301 s vs the 300 s grace,
      midnight, just before Fajr, after Isha (→ tomorrow's Fajr).
  T3  Lock timing (shortened 5 s timer): exits on time, state file removed,
      no leftover processes.
  T4  Lock timing (real 60 s run, once): exits at 60 s ±2 s.
  T5  Crash recovery: the lock survives its spawning parent dying (the
      shell-crash simulation), and SIGKILLing the lock mid-lock frees the
      desktop, leaves no stale state, and a fresh lock can start.
  T6  No dismiss path except the deliberate hold-Esc-3s override: the lock
      source contains no button, no click handler, no IPC — the only exits
      are the deadline, the watchdog, the Esc hold, or a signal (fail-open).
  T7  The lock's embedded string tables match the TS locales (generator
      --check): no drift between the two copies.
  T8  Esc-hold tracker (unit): a tap does nothing, a 1 s hold does nothing,
      a 3 s hold exits, releasing cancels.
  T9  Hard cap: --duration > 300 and --ends-at > now+300 are refused
      (exit 2); --duration 300 is accepted.
  T10 Monotonic deadline (unit, fake clock): a backward wall-clock jump
      cannot stretch the lock — remaining() follows the monotonic leg.
  T11 State-file validation: a corrupt file, a dead pid, a live non-lock
      pid, and an `exec -a` spoof with a stale start time are all treated
      as stale, not fatal; a genuinely live lock still refuses (exit 2).
  T12 Config override: method/madhab/offsets from prayer.json change the
      times; an unknown method is refused (exit 2).
  T13 Plural countdown: "Unlocks in 1 second" (not "1 seconds"); Arabic
      one/two/few/many forms.
  T14 N1 as-nobody (fix pass #2, security N1): a planted state file naming
      pid 1 + its true start time + ends_at +3600 must NOT block a lock
      run as the unprivileged user `nobody` (exit 0, stale) — the old
      PermissionError → True shortcut returned exit 2. Skipped, not
      passed, when the harness is not root or setpriv/nobody is missing.
  T15 Config bounds (fix pass #2, security N2 + code #2): offsets are
      bounded to ±120 min (+100000 / +121 / −121 → exit 2, +120 accepted)
      and unknown top-level keys in prayer.json are refused (exit 2).
  T16 Method-aware Dhuhr (fix pass #2, halal #1): Dhuhr 2026-11-12 is
      12:09 under ALL 8 methods (true transit 12:09:08); Asr stays 14:43
      under all of them.

Needs: al-falak importable (the test venv, or ~/.local/share/veltrix/venv).
The lock runs --headless here: this VM has no display and no
Gtk4SessionLock/Gtk4LayerShell typelibs, so the GUI ladder (session-lock →
layer-shell → fullscreen) is Dell-gated and NOT claimed by this harness —
except the Xvfb fullscreen render + XTest Esc-hold run, which are recorded
in docs/prayer-lock-fix-report-1.md, not in this harness.
With --fast, T4 (the real 60 s run) is skipped — say so in the report when
you do.
Exit 0 = every test passed; 1 = at least one failed.
"""
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import date, timedelta
from unittest import mock

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TIMES = os.path.join(REPO, "bin", "veltrix-prayer-times")
LOCK = os.path.join(REPO, "bin", "veltrix-prayer-lock")
GEN = os.path.join(REPO, "scripts", "dev", "gen-prayer-lock-strings.py")
FAST = "--fast" in sys.argv

# ICSWO (Islamic Centre of Southwest Ontario, islamiccentre.ca) — the local
# mosque's published November 2026 timetable, ISNA method, athan times.
# Re-fetched 2026-11-12 (fix pass #1). (Fajr, Dhuhr, Asr, Maghrib, Isha).
ICSWO = {
    date(2026, 11, 12): ("05:52", "12:09", "14:43", "17:04", "18:25"),
    date(2026, 11, 13): ("05:53", "12:09", "14:42", "17:03", "18:25"),
    date(2026, 11, 14): ("05:55", "12:09", "14:41", "17:02", "18:24"),
    date(2026, 11, 15): ("05:56", "12:10", "14:41", "17:01", "18:23"),
    date(2026, 11, 16): ("05:57", "12:10", "14:40", "17:00", "18:22"),
    date(2026, 11, 17): ("05:58", "12:10", "14:39", "17:00", "18:22"),
    date(2026, 11, 18): ("05:59", "12:10", "14:39", "16:59", "18:21"),
    date(2026, 11, 19): ("06:00", "12:10", "14:38", "16:58", "18:20"),
}
# searchtruth.com, Nov 12–18 2026 (North America method, Shafi Asr).
# Re-fetched 2026-11-12 (fix pass #1, prayerst.php?id=244082).
SEARCHTRUTH = {
    date(2026, 11, 12): ("05:53", "12:09", "14:42", "17:04", "18:25"),
    date(2026, 11, 13): ("05:54", "12:09", "14:41", "17:03", "18:24"),
    date(2026, 11, 14): ("05:56", "12:10", "14:41", "17:02", "18:24"),
    date(2026, 11, 15): ("05:57", "12:10", "14:40", "17:01", "18:23"),
    date(2026, 11, 16): ("05:58", "12:10", "14:39", "17:00", "18:22"),
    date(2026, 11, 17): ("05:59", "12:10", "14:39", "17:00", "18:21"),
    date(2026, 11, 18): ("06:00", "12:10", "14:38", "16:59", "18:21"),
}
# timesprayer.org/en-ca/08/london, Nov 12–18 2026 (ISNA). Dated table rows
# re-fetched 2026-11-12 (fix pass #1; page crawled Nov 10, table is dated).
TIMESPRAYER = {
    date(2026, 11, 12): ("05:52", "12:09", "14:44", "17:04", "18:25"),
    date(2026, 11, 13): ("05:53", "12:09", "14:43", "17:03", "18:25"),
    date(2026, 11, 14): ("05:54", "12:09", "14:42", "17:02", "18:24"),
    date(2026, 11, 15): ("05:56", "12:10", "14:42", "17:01", "18:23"),
    date(2026, 11, 16): ("05:57", "12:10", "14:41", "17:00", "18:22"),
    date(2026, 11, 17): ("05:58", "12:10", "14:40", "16:59", "18:22"),
    date(2026, 11, 18): ("05:59", "12:10", "14:39", "16:59", "18:21"),
}
PRAYER_NAMES = ("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha")

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def run(cmd, timeout=30, env=None):
    merged = dict(os.environ)
    if env:
        merged.update(env)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                          env=merged)


def minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def lock_processes():
    out = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True,
                         text=True).stdout
    return [ln.split(None, 1) for ln in out.splitlines()
            if "veltrix-prayer-lock" in ln and "prayer-lock-test" not in ln]


def load_lock_module():
    spec = importlib.util.spec_from_loader(
        "prayer_lock_under_test",
        loader=importlib.machinery.SourceFileLoader(
            "prayer_lock_under_test", LOCK))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def t1_times():
    sources = [("ICSWO", ICSWO), ("searchtruth", SEARCHTRUTH),
               ("timesprayer", TIMESPRAYER)]
    worst = 0
    worst_at = ""
    for sname, table in sources:
        for day, expected in table.items():
            r = run([sys.executable, TIMES, "--date", day.isoformat()])
            if r.returncode != 0:
                check(f"T1 times {day}", False, f"helper failed: {r.stderr.strip()}")
                return
            got = {}
            for line in r.stdout.strip().splitlines():
                name, hhmm = line.split()
                got[name] = hhmm
            for name, exp in zip(PRAYER_NAMES, expected):
                dev = minutes(got[name]) - minutes(exp)
                if abs(dev) > abs(worst):
                    worst, worst_at = dev, f"{sname} {day} {name}"
                if abs(dev) > 2:
                    check(f"T1 times vs {sname} {day} {name}", False,
                          f"helper {got[name]} vs {sname} {exp} = {dev:+d} min")
                    return
    check("T1 times vs ICSWO+searchtruth+timesprayer Nov 12–18 (105 prayers)",
          True, f"max |dev| {abs(worst)} min ({worst:+d} at {worst_at})")


def due(now_iso):
    r = run([sys.executable, TIMES, "--due", "--now", now_iso])
    return (r.returncode, r.stdout.strip())


def nxt(now_iso):
    r = run([sys.executable, TIMES, "--next", "--now", now_iso])
    return (r.returncode, r.stdout.strip())


def t2_selector():
    # Nov 12 times (calibrated): Fajr 05:52 Dhuhr 12:09 Asr 14:43 Maghrib 17:04 Isha 18:25
    cases = [
        ("05:51:59", None, "Fajr"),   # 1 s before Fajr: nothing due, next Fajr
        ("05:52:00", "Fajr", None),   # at Fajr
        ("05:53:00", "Fajr", None),   # +60 s: still due
        ("05:56:59", "Fajr", None),   # +299 s: still due (grace 300)
        ("05:57:01", None, "Dhuhr"),  # +301 s: no longer due
        ("12:08:59", None, "Dhuhr"),  # 1 s before Dhuhr
        ("12:09:00", "Dhuhr", None),
        ("14:43:00", "Asr", None),
        ("17:04:00", "Maghrib", None),
        ("18:25:00", "Isha", None),
        ("18:30:00", "Isha", None),   # +300 s: still due (grace is inclusive)
        ("18:30:01", None, "Fajr"),   # +301 s: no longer due; next tomorrow's Fajr
        ("00:00:00", None, "Fajr"),   # midnight: next Fajr
        ("03:00:00", None, "Fajr"),   # deep night: next Fajr
    ]
    ok = True
    for hhmmss, want_due, want_next in cases:
        iso = f"2026-11-12T{hhmmss}-05:00"
        rc, got = due(iso)
        due_ok = (got == want_due) if want_due else (rc == 1 and got == "")
        rc2, got2 = nxt(iso)
        next_name = got2.split()[0] if got2 else ""
        next_ok = (next_name == want_next) if want_next else True
        if not (due_ok and next_ok):
            ok = False
            print(f"  case {hhmmss}: due={got!r} (want {want_due!r}) "
                  f"next={next_name!r} (want {want_next!r})")
    check("T2 selector: 14 boundary cases, all 5 prayers", ok)


def t3_short_lock(tmpdir):
    before = lock_processes()
    t0 = time.time()
    r = run([sys.executable, LOCK, "--prayer", "Fajr", "--duration", "5",
             "--headless", "--state-dir", tmpdir], timeout=30)
    dt = time.time() - t0
    state = os.path.join(tmpdir, "veltrix-prayer-lock.json")
    after = lock_processes()
    check("T3 5 s lock exits on time", r.returncode == 0 and 4.5 <= dt <= 6.5,
          f"exit {r.returncode}, {dt:.2f}s")
    check("T3 state file removed after unlock", not os.path.exists(state))
    check("T3 no leaked lock processes", before == after,
          f"before={len(before)} after={len(after)}")


def t4_real_lock(tmpdir):
    if FAST:
        print("[SKIP] T4 real 60 s run (--fast)")
        return
    t0 = time.time()
    r = run([sys.executable, LOCK, "--prayer", "Maghrib", "--duration", "60",
             "--headless", "--state-dir", tmpdir], timeout=90)
    dt = time.time() - t0
    check("T4 real 60 s lock exits on time", r.returncode == 0 and 58 <= dt <= 62,
          f"exit {r.returncode}, {dt:.2f}s")


def t5_crash_recovery(tmpdir):
    # A short-lived parent spawns the lock (the shell's role) and dies at
    # once — the lock must survive it. Then the lock itself is SIGKILLed
    # mid-lock: the desktop must be free, no stale state, a fresh lock works.
    parent = subprocess.Popen(
        [sys.executable, "-c",
         "import subprocess, sys, time; "
         "p = subprocess.Popen([sys.executable, %r, '--prayer', 'Isha', "
         "'--duration', '60', '--headless', '--state-dir', %r], "
         "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
         "print(p.pid, flush=True); time.sleep(0.2)" % (LOCK, tmpdir)],
        stdout=subprocess.PIPE, text=True)
    lock_pid = int(parent.communicate()[0].strip())
    time.sleep(1.0)
    alive_after_parent_death = True
    try:
        os.kill(lock_pid, 0)
    except ProcessLookupError:
        alive_after_parent_death = False
    check("T5 lock survives its parent (shell) dying", alive_after_parent_death,
          f"lock pid {lock_pid}")
    os.kill(lock_pid, signal.SIGKILL)
    time.sleep(2.5)  # watchdog's 2 s grace is not needed (parent is dead) —
    # the state file must be gone: the watchdog removes it, or it never
    # outlives the lock process in the first place.
    state = os.path.join(tmpdir, "veltrix-prayer-lock.json")
    gone = not os.path.exists(state)
    # A fresh lock must be able to start afterwards (no stale claim).
    r = run([sys.executable, LOCK, "--prayer", "Isha", "--duration", "2",
             "--headless", "--state-dir", tmpdir], timeout=30)
    check("T5 SIGKILL mid-lock frees the desktop (fail-open)", gone,
          "state file removed" if gone else "STALE state file remains")
    check("T5 fresh lock starts after a kill", r.returncode == 0,
          f"exit {r.returncode}")
    check("T5 no leaked lock processes after kill",
          len(lock_processes()) == 0,
          f"{len(lock_processes())} still running")


def t6_no_dismiss():
    src = open(LOCK, encoding="utf-8").read()
    # Strip full-line comments: the header documents the no-dismiss rule in
    # prose ("no button, no key-press, no delete-event…"), which would match
    # the code patterns below. What is checked here is the CODE.
    code = "\n".join(ln for ln in src.splitlines()
                     if not ln.strip().startswith("#"))
    banned = [r"Gtk\.Button\s*\(", r"connect\(['\"]clicked['\"]",
              r"['\"]delete-event['\"]",
              r"\bDBus\b", r"veltrix-ipc"]
    found = [pat for pat in banned if re.search(pat, code)]
    # close-request IS present — and returns True (ignored). That is the
    # anti-dismiss, not a dismiss path; verify the handler ignores it.
    close_ignored = 'win.connect("close-request", lambda *_a: True)' in code
    # The ONE allowed key path is the deliberate hold-Esc-3s override: it
    # must reference Escape and the 3 s hold, and nothing else key-shaped.
    esc_hold = ("KEY_Escape" in code and "ESC_HOLD_SECONDS" in code
                and "EscHoldTracker" in code)
    key_handlers = re.findall(r"connect\(['\"]key-\w+['\"]", code)
    check("T6 no dismiss path except hold-Esc-3s in lock source",
          not found and close_ignored and esc_hold
          and all("key-pressed" in h or "key-released" in h
                  for h in key_handlers),
          f"found={found} close-ignored={close_ignored} "
          f"esc-hold={esc_hold} key-handlers={key_handlers}")


def t7_strings_match():
    r = run([sys.executable, GEN, "--check"], timeout=30)
    check("T7 lock string tables match TS locales (generator --check)",
          r.returncode == 0, r.stdout.strip() or r.stderr.strip())


def t8_esc_tracker():
    mod = load_lock_module()
    clock = [1000.0]

    def fake_clock():
        return clock[0]

    tr = mod.EscHoldTracker(clock=fake_clock)
    ok = (not tr.should_exit() and tr.held_seconds() == 0.0)
    tr.press()
    clock[0] += 1.0
    ok = ok and not tr.should_exit()  # 1 s hold: nothing
    clock[0] += 1.9
    ok = ok and not tr.should_exit()  # 2.9 s: still nothing
    clock[0] += 0.1
    ok = ok and tr.should_exit()  # 3.0 s: exits
    tr.release()
    ok = ok and not tr.should_exit() and not tr.is_holding
    tr.press()
    clock[0] += 5.0
    ok = ok and tr.should_exit()  # a fresh 5 s hold also exits
    check("T8 Esc hold: tap/1s no-op, 3s exits, release cancels", ok)


def t9_cap():
    r1 = run([sys.executable, LOCK, "--prayer", "Fajr", "--duration", "301",
              "--headless", "--state-dir", "/tmp"], timeout=30)
    r2 = run([sys.executable, LOCK, "--prayer", "Fajr",
              "--ends-at", str(time.time() + 3600),
              "--headless", "--state-dir", "/tmp"], timeout=30)
    # --duration 300 is accepted: prove it by pairing it with a past
    # --ends-at (which overrides duration) — validation passes, then the
    # lock exits 0 at once for the past deadline.
    r3 = run([sys.executable, LOCK, "--prayer", "Fajr", "--duration", "300",
              "--ends-at", str(time.time() - 10),
              "--headless", "--state-dir", "/tmp"], timeout=30)
    check("T9 cap: duration 301 / ends-at +3600 refused, 300 accepted",
          r1.returncode == 2 and r2.returncode == 2
          and r3.returncode == 0,
          f"exits {r1.returncode}/{r2.returncode}/{r3.returncode}")


def t10_monotonic():
    mod = load_lock_module()
    # A lock whose wall deadline is T+60 and monotonic deadline M+60.
    args = mod.parse_args(["--prayer", "Fajr", "--duration", "60",
                           "--headless", "--state-dir", "/tmp"])
    lock = mod.PrayerLock(args)
    t0, m0 = 1_800_000_000.0, 5000.0
    lock.ends_at = t0 + 60.0
    lock.ends_at_mono = m0 + 60.0
    with mock.patch.object(mod.time, "time", return_value=t0 + 30.0), \
            mock.patch.object(mod.time, "monotonic", return_value=m0 + 30.0):
        normal = lock.remaining()
    # Now jump the wall clock BACKWARD by an hour, 30 s into the lock:
    # the wall leg alone would say 3630 s remain; the monotonic leg says
    # 30 s — remaining() must follow the monotonic leg.
    with mock.patch.object(mod.time, "time",
                           return_value=t0 - 3600.0 + 30.0), \
            mock.patch.object(mod.time, "monotonic", return_value=m0 + 30.0):
        jumped = lock.remaining()
    check("T10 monotonic deadline: backward clock jump cannot stretch lock",
          abs(normal - 30.0) < 0.01 and abs(jumped - 30.0) < 0.01,
          f"normal={normal:.1f}s jumped={jumped:.1f}s (wall alone: 3630s)")


def _plant_state(tmpdir, payload):
    with open(os.path.join(tmpdir, "veltrix-prayer-lock.json"), "w",
              encoding="utf-8") as fh:
        json.dump(payload, fh)


def t11_state_validation(tmpdir):
    state = os.path.join(tmpdir, "veltrix-prayer-lock.json")

    def fresh_lock():
        return run([sys.executable, LOCK, "--prayer", "Fajr", "--duration", "2",
                    "--headless", "--state-dir", tmpdir], timeout=30)

    # Corrupt / unparseable state file → stale, not fatal.
    with open(state, "w", encoding="utf-8") as fh:
        fh.write("{not json!!!")
    r_corrupt = fresh_lock()
    # A dead pid → stale.
    _plant_state(tmpdir, {"prayer": "Fajr", "ends_at": time.time() + 3600,
                          "pid": 999999, "pid_start_time": 1})
    r_dead = fresh_lock()
    # A live NON-lock pid (sleep) with a far-future ends_at → stale.
    sleeper = subprocess.Popen(["sleep", "30"])
    try:
        _plant_state(tmpdir, {"prayer": "Fajr",
                              "ends_at": time.time() + 3600,
                              "pid": sleeper.pid, "pid_start_time": 1})
        r_nonlock = fresh_lock()
    finally:
        sleeper.kill()
        sleeper.wait()
    # An `exec -a` argv spoof with a STALE start time → stale (the start
    # time is what tells generations apart; a spoof that also recorded the
    # true start time would pass, which is why the watchdog re-checks the
    # start time it recorded at fork — see the fix report).
    spoof = subprocess.Popen(["bash", "-c",
                              "exec -a veltrix-prayer-lock sleep 30"])
    try:
        time.sleep(0.3)
        _plant_state(tmpdir, {"prayer": "Fajr",
                              "ends_at": time.time() + 3600,
                              "pid": spoof.pid, "pid_start_time": 1})
        r_spoof = fresh_lock()
    finally:
        spoof.kill()
        spoof.wait()
    # A genuinely live lock still refuses (exit 2) — validation must not
    # open a hole where a second lock can extend the first.
    live = subprocess.Popen(
        [sys.executable, LOCK, "--prayer", "Fajr", "--duration", "20",
         "--headless", "--state-dir", tmpdir],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        r_live = fresh_lock()
    finally:
        live.kill()
        live.wait()
    check("T11 state validation: corrupt/dead/non-lock/spoof stale, live refuses",
          r_corrupt.returncode == 0 and r_dead.returncode == 0
          and r_nonlock.returncode == 0 and r_spoof.returncode == 0
          and r_live.returncode == 2,
          f"exits corrupt={r_corrupt.returncode} dead={r_dead.returncode} "
          f"nonlock={r_nonlock.returncode} spoof={r_spoof.returncode} "
          f"live={r_live.returncode}")


def t12_config(tmpdir):
    cfg_path = os.path.join(tmpdir, "prayer.json")
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump({"method": "Egypt", "madhab": "Hanafi",
                   "offsets": {"Dhuhr": 0, "Asr": 0}}, fh)
    env = {"VELTRIX_PRAYER_CONFIG": cfg_path}
    r = run([sys.executable, TIMES, "--date", "2026-11-12"], env=env)
    lines = dict(ln.split() for ln in r.stdout.strip().splitlines())
    # Egypt/Hanafi, zero offsets: Fajr 05:27, Asr 15:21 (vs ISNA/Shafi
    # calibrated 05:52 / 14:43) — the config actually changes the output.
    ok_cfg = (r.returncode == 0 and lines.get("Fajr") == "05:27"
              and lines.get("Asr") == "15:21")
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump({"method": "Bogus"}, fh)
    r_bad = run([sys.executable, TIMES, "--date", "2026-11-12"], env=env)
    check("T12 config: Egypt/Hanafi changes times, unknown method refused",
          ok_cfg and r_bad.returncode == 2,
          f"Egypt/Hanafi Fajr={lines.get('Fajr')} Asr={lines.get('Asr')} "
          f"bad-method exit={r_bad.returncode}")


def t13_plural():
    mod = load_lock_module()
    en1 = mod.format_unlocks("en", 1)
    en2 = mod.format_unlocks("en", 2)
    en60 = mod.format_unlocks("en", 60)
    es1 = mod.format_unlocks("es", 1)
    ar1 = mod.format_unlocks("ar", 1)
    ar2 = mod.format_unlocks("ar", 2)
    ar5 = mod.format_unlocks("ar", 5)
    ar11 = mod.format_unlocks("ar", 11)
    ok = (en1 == "Unlocks in 1 second"
          and en2 == "Unlocks in 2 seconds"
          and en60 == "Unlocks in 60 seconds"
          and es1 == "Se desbloquea en 1 segundo"
          and ar1 == "يُفتح القفل خلال ثانية واحدة"
          and ar2 == "يُفتح القفل خلال ثانيتين"
          and ar5 == "يُفتح القفل خلال 5 ثوانٍ"
          and ar11 == "يُفتح القفل خلال 11 ثانية")
    check("T13 plural countdown: en/es singular, ar one/two/few/many", ok,
          f"en1={en1!r} ar2={ar2!r} ar5={ar5!r} ar11={ar11!r}")


def t14_nobody_pid1_plant(tmpdir):
    """N1 (security v2, fix pass #2): a planted state file naming pid 1
    + its TRUE /proc start time + ends_at +3600 must NOT block a lock run
    as the unprivileged user `nobody` (exit 0, stale). As root
    os.kill(1, 0) succeeds and the cmdline check runs, so the old code
    passed this case when run as root — the hole only fired for a caller
    who cannot signal pid 1 (PermissionError → True, no checks at all).

    Runs only as root with setpriv + user `nobody` present; otherwise
    SKIPPED (recorded as a skip, not a pass). The repo tree is not
    traversable by `nobody` in this VM, so the lock runs from a copy in
    the test dir — the copy is verified byte-identical (sha256) to the
    repo file first, and the lock is stdlib-only, so the copy is
    behaviour-identical for the claim path.
    """
    import hashlib
    import pwd
    import shutil
    if os.geteuid() != 0 or shutil.which("setpriv") is None:
        print("[SKIP] T14 N1 as-nobody plant (needs root + setpriv)")
        return
    try:
        pwd.getpwnam("nobody")
    except KeyError:
        print("[SKIP] T14 N1 as-nobody plant (no user 'nobody')")
        return
    ndir = os.path.join(tmpdir, "nobody")
    os.mkdir(ndir)
    # mkdtemp's tmpdir is 0700 root — `nobody` could not even traverse to
    # the copy or the state dir. Relax the (test-only) tmpdir to 0711;
    # the nobody dir itself is 0777 so the lock can claim its state file.
    os.chmod(tmpdir, 0o711)
    os.chmod(ndir, 0o777)
    copy = os.path.join(ndir, "veltrix-prayer-lock")
    shutil.copyfile(LOCK, copy)
    # copyfile honours this shell's umask (007 here → 0660 root:root),
    # which `nobody` cannot read. The repo file is 0755; match that.
    os.chmod(copy, 0o755)
    digest = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
    if digest(copy) != digest(LOCK):
        check("T14 N1 as-nobody plant: pid 1 + true start time → exit 0",
              False, "lock copy differs from repo file — refusing to test it")
        return
    mod = load_lock_module()
    start1 = mod.proc_start_time(1)
    if start1 is None:
        check("T14 N1 as-nobody plant: pid 1 + true start time → exit 0",
              False, "cannot read /proc/1/stat start time — cannot build plant")
        return
    _plant_state(ndir, {"prayer": "Fajr", "ends_at": time.time() + 3600,
                        "pid": 1, "pid_start_time": start1})
    # The plant MUST be world-readable: _plant_state writes it 0660
    # root:root under this shell's umask, and a file `nobody` cannot
    # read is treated as absent (read_state → None) — the test would
    # then pass against the OLD code too. An attacker's plant is
    # readable by its victim by construction; make this one so too.
    os.chmod(os.path.join(ndir, "veltrix-prayer-lock.json"), 0o644)
    py = shutil.which("python3")
    r = run(["setpriv", "--reuid=nobody", "--regid=nogroup",
             "--clear-groups", py, copy, "--prayer", "Fajr",
             "--duration", "2", "--headless", "--state-dir", ndir],
            timeout=30)
    check("T14 N1 as-nobody plant: pid 1 + true start time → exit 0",
          r.returncode == 0,
          f"pid 1 start={start1}, exit {r.returncode} "
          f"(stderr: {r.stderr.strip()[:160]})")


def t15_config_bounds(tmpdir):
    cfg_path = os.path.join(tmpdir, "prayer-bounds.json")
    env = {"VELTRIX_PRAYER_CONFIG": cfg_path}

    def run_cfg(cfg):
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh)
        return run([sys.executable, TIMES, "--date", "2026-11-12"], env=env)

    def fajr_of(r):
        if r.returncode != 0:
            return None
        return dict(ln.split() for ln in
                    r.stdout.strip().splitlines()).get("Fajr")

    # A 100000-min offset (≈69 days) is a typo, not a calibration.
    r_huge = run_cfg({"offsets": {"Fajr": 100000}})
    # +120 is the bound: accepted — Fajr 05:52 → 07:52.
    r_120 = run_cfg({"offsets": {"Fajr": 120}})
    # One minute past the bound, either way: refused.
    r_121 = run_cfg({"offsets": {"Fajr": 121}})
    r_neg121 = run_cfg({"offsets": {"Fajr": -121}})
    # A typo'd top-level key must not silently leave ISNA in place.
    r_key = run_cfg({"methd": "Egypt", "offsets": {"Fajr": 5}})
    check("T15 offset bound ±120 (+120 ok) / unknown key → exit 2",
          r_huge.returncode == 2 and r_120.returncode == 0
          and fajr_of(r_120) == "07:52" and r_121.returncode == 2
          and r_neg121.returncode == 2 and r_key.returncode == 2,
          f"exits +100000={r_huge.returncode} +120={r_120.returncode} "
          f"(Fajr={fajr_of(r_120)}) +121={r_121.returncode} "
          f"−121={r_neg121.returncode} methd-key={r_key.returncode}")


def t16_dhuhr_all_methods():
    """Halal #1 (fix pass #2): Dhuhr −1 applies only under methods whose
    al-falak preset carries dhuhr=+1. Dhuhr 2026-11-12 must be 12:09
    under ALL 8 methods (true transit 12:09:08); Asr stays 14:43 under
    all of them (the Asr model error is method-independent). The config
    is pointed at a nonexistent path so a machine-level prayer.json
    cannot mask the compiled-in defaults under test."""
    methods = ["ISNA", "MWL", "Egypt", "Umm al-Qura", "Kuwait", "Qatar",
               "Singapore", "Turkey"]
    env = {"VELTRIX_PRAYER_CONFIG": "/nonexistent-prayer-lock-test.json"}
    bad = []
    for method in methods:
        r = run([sys.executable, TIMES, "--date", "2026-11-12",
                 "--method", method], env=env)
        lines = (dict(ln.split() for ln in r.stdout.strip().splitlines())
                 if r.returncode == 0 else {})
        if lines.get("Dhuhr") != "12:09" or lines.get("Asr") != "14:43":
            bad.append(f"{method}: Dhuhr={lines.get('Dhuhr')} "
                       f"Asr={lines.get('Asr')} rc={r.returncode}")
    check("T16 Dhuhr 12:09 under all 8 methods (2026-11-12)",
          not bad,
          "all 8: Dhuhr 12:09, Asr 14:43" if not bad else "; ".join(bad))


def main():
    import tempfile
    tmpdir = tempfile.mkdtemp(prefix="prayer-lock-test-")
    print(f"repo: {REPO}\ntmp state dir: {tmpdir}\n")
    t1_times()
    t2_selector()
    t3_short_lock(tmpdir)
    t4_real_lock(tmpdir)
    t5_crash_recovery(tmpdir)
    t6_no_dismiss()
    t7_strings_match()
    t8_esc_tracker()
    t9_cap()
    t10_monotonic()
    t11_state_validation(tmpdir)
    t12_config(tmpdir)
    t13_plural()
    t14_nobody_pid1_plant(tmpdir)
    t15_config_bounds(tmpdir)
    t16_dhuhr_all_methods()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed"
          + (" (--fast: T4 skipped)" if FAST else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
