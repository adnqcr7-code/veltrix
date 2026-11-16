#!/usr/bin/env python3
"""Seasonal Asr probe — the March 2027 re-verification probe (fix pass #2,
halal #2). Rewrite of the halal critic's /tmp/halal-v2-seasonal.py, which no
longer exists in /tmp; kept in the repo so the March run is one command.

Run:  python3 scripts/dev/prayer-seasonal-probe.py
Needs: astral==3.2 importable (pip install astral==3.2 into a SCRATCH venv —
never into the project venv) and the project venv python for the helper.

Method (same as the critic's v2 §5): for the 15th of each month, compare
the CALIBRATED helper's Asr (ISNA default, fixed code) against astral
3.2's event-time Asr. Astral Asr (Shafi'i, shadow factor 1) is the time
when the solar elevation equals atan(1 / (1 + tan(|lat - declination|))),
with the declination taken AT THE EVENT TIME — iterated 3x to
convergence, via astral's own time_at_elevation (which binary-searches
internally). This is the referee the halal critic used; it is a proxy,
not the mosque — ICSWO's March table is the real check, owed March 2027.

DST is handled by passing timezone-aware datetimes (zoneinfo
America/Toronto) — the critic's v2 script passed the wrong DST offset
for March, so that cell was their error, not data; this probe does not
repeat it.

The March 2027 run (halal must-do #2, fix pass #2) re-runs this probe
with the then-current code AND the 7-day x 3-source comparison against
ICSWO/searchtruth/timesprayer's March tables: if any prayer is outside
+-2 min vs the mosque in March, the Asr calibration must become seasonal
or be replaced by the computation fix (halal review v2 SS1).
"""
import math
import os
import subprocess
import sys
from datetime import date, datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

try:
    from astral import Observer
except ImportError:
    print("prayer-seasonal-probe: astral is not importable — install it "
          "into a scratch venv first: python3 -m venv /tmp/astral-venv && "
          "/tmp/astral-venv/bin/pip install 'astral==3.2', then run this "
          "script with that venv's python. Never install it into the "
          "project venv (hash-pinned).", file=sys.stderr)
    sys.exit(3)
from astral.sun import (SunDirection, julianday,
                        julianday_to_juliancentury, noon, sun_declination,
                        time_at_elevation)

LAT, LON = 42.9849, -81.2453
TZ = ZoneInfo("America/Toronto")
OBSERVER = Observer(LAT, LON, 0)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
HELPER = os.path.join(REPO, "bin", "veltrix-prayer-times")
_PROJECT_VENV = os.path.expanduser(
    "~/.local/share/veltrix/venv/bin/python")
HELPER_PY = (_PROJECT_VENV if os.path.isfile(_PROJECT_VENV)
             else sys.executable)


def astral_asr(day):
    """Event-time-declination Shafi Asr (datetime, Toronto), iterated."""
    # Seed: 2 h after astral noon.
    t = noon(OBSERVER, day, tzinfo=TZ) + timedelta(hours=2)
    for _ in range(4):
        jd = julianday(t.astimezone(ZoneInfo("UTC")).replace(tzinfo=None))
        # julianday() wants a naive UTC datetime; astral's own uses the
        # aware path internally, but for declination we pass UTC naive.
        decl = sun_declination(julianday_to_juliancentury(jd))
        target = math.degrees(math.atan(
            1.0 / (1.0 + math.tan(math.radians(abs(LAT - decl))))))
        t = time_at_elevation(OBSERVER, target, day,
                              direction=SunDirection.SETTING, tzinfo=TZ)
    return t


def round_minute(dt):
    """Round an aware datetime to the nearest minute (half-up)."""
    if dt.second >= 30:
        dt += timedelta(minutes=1)
    return dt.replace(second=0, microsecond=0)


def helper_asr(day):
    env = dict(os.environ, VELTRIX_PRAYER_CONFIG="/nonexistent-probe.json")
    r = subprocess.run([HELPER_PY, HELPER, "--date", day.isoformat()],
                       capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    for line in r.stdout.strip().splitlines():
        name, hhmm = line.split()
        if name == "Asr":
            h, m = map(int, hhmm.split(":"))
            return datetime.combine(day, dtime(h, m), TZ)
    raise AssertionError("no Asr line")


def helper_dhuhr(day):
    env = dict(os.environ, VELTRIX_PRAYER_CONFIG="/nonexistent-probe.json")
    r = subprocess.run([HELPER_PY, HELPER, "--date", day.isoformat()],
                       capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    for line in r.stdout.strip().splitlines():
        name, hhmm = line.split()
        if name == "Dhuhr":
            h, m = map(int, hhmm.split(":"))
            return datetime.combine(day, dtime(h, m), TZ)
    raise AssertionError("no Dhuhr line")


def main():
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
    print(f"{'date':<12} {'helper Asr':<10} {'astral Asr':<18} {'dev':>4}  "
          f"{'helper Dhuhr':<12} {'astral noon':<12} {'dev':>4}")
    for month in range(1, 13):
        day = date(year, month, 15)
        ha = helper_asr(day)
        aa_raw = astral_asr(day)
        aa = round_minute(aa_raw)
        dev = int((ha - aa).total_seconds() // 60)
        hd = helper_dhuhr(day)
        an_raw = noon(OBSERVER, day, tzinfo=TZ)
        an = round_minute(an_raw)
        dev_n = int((hd - an).total_seconds() // 60)
        print(f"{day.isoformat():<12} {ha.strftime('%H:%M'):<10} "
              f"{aa.strftime('%H:%M')} ({aa_raw.strftime('%H:%M:%S')}) "
              f"{dev:+d}   {hd.strftime('%H:%M'):<12} {an.strftime('%H:%M'):<12} "
              f"{dev_n:+d}")
    print("\ndev = helper − astral, minutes (rounded-to-minute astral). "
          "Positive = helper LATE (safe direction).")


if __name__ == "__main__":
    main()
