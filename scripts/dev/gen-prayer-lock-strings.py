#!/usr/bin/env python3
"""gen-prayer-lock-strings.py — single source of truth for prayer-lock copy.

The lock (bin/veltrix-prayer-lock) is a standalone Python process that must
run with the shell dead, so it cannot read the shell's TS locales at
runtime. It used to carry hand-copied EN/AR/ES tables that could drift from
the locales with no check (UI review v1, V6). This script is the fix: the
TS locales (ui/shell/core/i18n/locales/{en,ar,es}.ts) are the source of
record, and the lock's embedded tables are GENERATED from them.

  python3 scripts/dev/gen-prayer-lock-strings.py          # regenerate in place
  python3 scripts/dev/gen-prayer-lock-strings.py --check  # exit 1 if drifted

The generated block in bin/veltrix-prayer-lock sits between the markers
  # BEGIN GENERATED PRAYER-LOCK STRINGS
  # END GENERATED PRAYER-LOCK STRINGS
and is replaced wholesale. Everything outside the markers is hand-written.
The harness (prayer-lock-test.py, T7) runs --check, so drift fails the
harness rather than shipping silently.
"""
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOCALES_DIR = os.path.join(REPO, "ui", "shell", "core", "i18n", "locales")
LOCK = os.path.join(REPO, "bin", "veltrix-prayer-lock")
LOCALES = ("en", "ar", "es")

# "key": "value" — values in the prayerlock keys contain no escapes today;
# the unescape below handles the standard JSON escapes if one ever appears.
ENTRY_RE = re.compile(r'"(prayerlock\.[^"]+)":\s*"((?:[^"\\]|\\.)*)"')
BEGIN = "# BEGIN GENERATED PRAYER-LOCK STRINGS"
END = "# END GENERATED PRAYER-LOCK STRINGS"


def read_locale(locale):
    path = os.path.join(LOCALES_DIR, locale + ".ts")
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    out = {}
    for match in ENTRY_RE.finditer(src):
        key = match.group(1)[len("prayerlock."):]
        out[key] = json.loads('"' + match.group(2) + '"')
    return out


def generate():
    by_locale = {loc: read_locale(loc) for loc in LOCALES}
    missing = {loc: sorted(set(by_locale["en"]) - set(by_locale[loc]))
               for loc in LOCALES}
    missing = {loc: keys for loc, keys in missing.items() if keys}
    if missing:
        raise SystemExit(f"prayerlock keys missing per locale: {missing} "
                         f"(add the key to every locale, then re-run)")
    # PRAYERS: English name -> Arabic name, from the ar locale's prayer.* keys.
    prayers = {name: by_locale["ar"][f"prayer.{name.lower()}"]
               for name in ("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha")}
    # PRAYER_NAMES: the name as shown in each locale (Latin in en/es,
    # Arabic in ar) — the overlay leads with the locale's own name.
    prayer_names = {loc: {name: by_locale[loc][f"prayer.{name.lower()}"]
                          for name in prayers} for loc in LOCALES}
    # STRINGS: every other prayerlock.* key, per locale.
    strings = {loc: {k: v for k, v in sorted(by_locale[loc].items())
                     if not k.startswith("prayer.")}
               for loc in LOCALES}
    lines = [
        "# Generated from ui/shell/core/i18n/locales/{en,ar,es}.ts by",
        "# scripts/dev/gen-prayer-lock-strings.py — DO NOT HAND-EDIT.",
        "# Run the script with --check to verify; the harness (T7) does.",
        "",
        "PRAYERS = " + repr(prayers).replace("'", '"'),
        "",
        "# Prayer name as shown in each locale (Latin in en/es, Arabic in ar).",
        "PRAYER_NAMES = " + json.dumps(prayer_names, ensure_ascii=False, indent=4),
        "",
        "STRINGS = " + json.dumps(strings, ensure_ascii=False, indent=4),
    ]
    return "\n".join(lines) + "\n"


def main():
    check = "--check" in sys.argv
    with open(LOCK, encoding="utf-8") as fh:
        src = fh.read()
    if BEGIN not in src or END not in src:
        raise SystemExit(f"{LOCK}: generated-block markers not found")
    before, rest = src.split(BEGIN, 1)
    _, after = rest.split(END, 1)
    generated = generate()
    if check:
        current = rest.split(END, 1)[0].strip("\n")
        if current.strip() != generated.strip():
            print("gen-prayer-lock-strings: lock tables DRIFTED from the "
                  "TS locales — run scripts/dev/gen-prayer-lock-strings.py "
                  "to regenerate", file=sys.stderr)
            return 1
        print("gen-prayer-lock-strings: lock tables match the TS locales")
        return 0
    with open(LOCK, "w", encoding="utf-8") as fh:
        fh.write(before + BEGIN + "\n" + generated + END + after)
    print(f"gen-prayer-lock-strings: regenerated tables in {LOCK}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
