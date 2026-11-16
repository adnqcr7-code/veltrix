# App icons for iPad Mode (and Launchpad)

The twelve tiles of the iPad home screen draw from the files in this
directory — real icon files, never emoji tiles.

## The four drawn SVGs (Islamic apps)

`quran.svg`, `prayer.svg`, `dhikr.svg`, `dua.svg` — hand-drawn SVG
icons from the concept set (`~/workspace/veltrix/concept/icons/`),
the FIRST version of the icons. The four Islamic apps (Quran, Prayer,
Dhikr, Dua) do not exist as programs yet — their tiles carry these
icons and launch by desktop id the moment the apps land (see
`ui/shell/surfaces/ipad-mode/IPadApps.ts`). Their shipped default
icons are seeded into the user's icon-overlay store by
`AppService.seedShippedIconDefaults()` under the `veltrix-*` names,
so Launchpad shows the same SVGs when the apps exist.

## The eight Papirus-style icons (SVG)

`files.svg`, `settings.svg`,
`calendar.svg`, `clock.svg`, `org.gnome.Notes.svg`,
`org.gnome.Photos.svg` — copied from the concept set, which took
them from the **Papirus icon theme (GPL-3.0)**. They ship here under
the same GPL-3.0-or-later terms as this fork. Notes/Photos are seeded the same way as
the Islamic apps (under their upstream icon names), so whichever
notes/photos program is installed shows the Papirus icon in
Launchpad.

## Terminal + Browser — drawn here, not Papirus (fix pass #1, Nov 13 2026)

`terminal.svg` — Veltrix-drawn, a plain terminal window with a `>_` prompt.
It REPLACES the Papirus terminal icon, which was a cartoon orange cat
holding a terminal (an animal in an icon — banned, halal review BLOCKER).
The new icon depicts no animate being. It is also seeded as the `kitty`
icon override by `AppService.seedShippedIconDefaults()` (Nov 14 2026):
kitty's own `.desktop` entry declares `Icon=kitty`, and without the
seed that name resolves through the icon theme to the cat the kitty
package (and WhiteSur) ships — so the dock, app grid, overview and
Settings show this same `>_` glyph instead of the cat. Kitty the
terminal is untouched; only its picture changes.

`browser.svg` — Veltrix-drawn, a plain browser window with a globe.
It REPLACES the Papirus Firefox mark (a stylised fox around a globe —
an animal in an icon). **TEMPORARY, by Adnan's decision (Nov 12, 20:51
EST):** Adnan is building his own browser with other agents, and this
neutral glyph stands in until his browser lands and replaces it with
its own mark. Do not treat this glyph as the final browser icon, and
do not silently restore the fox.

## Black tiles (v5, 2026-11-12 19:28 EST)

Every icon sits on a black/dark tile (`background: #000` on
`.ipad-tile-icon` in `_ipad-mode.scss`, on `.app-grid-plate` in
`_app-grid.scss`) — eye protection, so bright icons like Clock sit
on black instead of glaring. The tile is CSS, not part of the icon
files: the SVGs keep their own colours inside it. The dock does NOT
get black tiles — the concept dock shows the plain icons, and the
dock is unchanged.

## Icon history — do not redo the superseded sets

- v1 (first version): drawn SVGs + Papirus — **current, final**.
- v2: dark AI icons (`*-ai.webp`, dark obsidian + cyan glow) —
  superseded 2026-11-12 19:28. Shipped PNGs removed from this
  directory; sources remain in `concept/icons/` for reference only.
- v3: colourful AI icons (`*-color.webp`, one vibrant palette per
  app) — tried 2026-11-12, rejected by Adnan the same night
  ("really bad", put it back how it was). Superseded; do not redo
  unless he asks.
- v4: dark AI restored — superseded by v5 the same night.
