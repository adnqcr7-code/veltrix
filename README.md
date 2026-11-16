# VELTRIX

> **Fork notice — read first.** VELTRIX is a fork of
> [Nidara](https://github.com/nidara-project/nidara-desktop) v0.13.0 (commit
> `62455a71`), rebranded because the Nidara name and logo are trademarks of the
> Nidara Project and forks must adopt a different name. The whole fork stays
> **GPL-3.0-or-later**; the platform library (`ui/lib/veltrix-kit/`) stays
> **LGPL-3.0-or-later**. Upstream credit and the full third-party list are in
> `NOTICE` and `ATTRIBUTION.md`.
>
> **What the fork changes (Phase 0):** name and IDs to VELTRIX / `org.veltrix.*`;
> dark mode by default, cyan `#00E5FF` accent, WhiteSur icons; the built-in
> Assistant keeps **local Ollama only** — the API-key path (Anthropic / OpenAI /
> Google / SpaceXAI, keyring storage, custom endpoints) is deleted, and the
> Assistant is off by default behind an explicit opt-in; **Game Mode is deleted** —
> shell, Settings and the Hyalo compositor alike (no game rules, no gamespace,
> no game-driven VRR; a fullscreen window still gets fullscreen VRR).
> The Islamic layer (prayer times, Hijri calendar, Qibla, Quran) lands in later
> phases — this fork is the foundation, not the finished product.
>
> **Status: not installable yet.** The `[veltrix]` pacman repository and its
> GPG signing key do **not exist yet** — the install commands below are the
> intended shape, with the key fingerprint marked TBD. Do not run them until a
> release publishes the repo and the key. The only install proven today is the
> upstream one this fork came from (see `docs/dell-validation-phase0.md`).
>
> **Honest limits (Phase 0):** no music player ships by default, and nothing is
> filtered yet — no browser ships either, so there is no content filtering to
> claim. The Islamic layer above is still to come; until it lands, this fork is
> a rebranded, de-commercialised Nidara, not yet a Muslim desktop.

VELTRIX is a full **Wayland desktop environment** built on **GTK4** and **GJS**, running
today on the **Hyprland** compositor and moving to **Hyalo**, a compositor of its own (see
[Where it is going](#where-it-is-going-hyalo)). It is designed to be fast, visually premium, and
tightly optimized for **Arch Linux**.

> **VELTRIX** is the desktop environment — this repository, and what you install on an
> Arch system you already have. **Veltrix** is the operating system built around it: a live image
> that installs a complete system. Upstream Nidara has one, built in
> [nidara-iso](https://github.com/nidara-project/nidara-iso); **VELTRIX has no live image
> yet** — that is a later phase, not this repository.
>
> The two are versioned separately and neither number derives from the other. You do not need
> Veltrix to run VELTRIX — installing it here leaves the rest of your machine alone: it does
> not rename your operating system, touch your bootloader, or choose your applications.

It is also **AI-native** — not as a bolt-on, but in how it is built and maintained. VELTRIX
is developed with AI coding agents, ships a first-class interface for an agent to *see and operate*
the running desktop, and is designed to keep improving through AI-authored contributions: point a
coding agent at your own install, have it fix or extend something, and send that improvement back
upstream as a pull request. The agent knowledge and the contribution rules live **inside the repo**,
so every clone is ready to be worked on by an agent out of the box.

*Screenshots are not published yet. The upstream screenshots this table showed came from
a repository that does not exist for this fork; real screenshots land with Dell validation
(Phase 0, `docs/dell-validation-phase0.md`) and are not faked in the meantime.*

---

## Where it is going: Hyalo

Veltrix is building its own Wayland compositor, **Hyalo** (from the Greek *hyalos*, "glass"), on
[Smithay](https://github.com/Smithay/smithay), and will leave Hyprland for it.

Hyprland has carried Veltrix a long way, but it is a compositor made for everybody, and the desktop
kept running into what it allows: one blur for every surface, decided by alpha thresholds; no way
for a surface to see what lies behind it; window animations that cannot start from a point we
choose. A compositor of our own lets the glass **modify the backdrop** instead of painting over it —
refraction at the edge, a tint that adapts pixel by pixel so text stays legible, a light on the rim
— and lets every surface have its own material, cut to its exact shape.

A prototype has already run the real shell, unmodified. Its blur per surface cost less than
Hyprland's on the same scene, measured on real hardware, and a first refractive glass followed. The
study is [#679](https://github.com/nidara-project/nidara-desktop/issues/679); the plan, with
everything Hyprland does for us today and where each piece goes, is
[#680](https://github.com/nidara-project/nidara-desktop/issues/680).

**Until Hyalo replaces it, Hyprland is the compositor** — everything below describes the desktop
as it runs today. While Hyalo is built, a preview session will sit next to the regular one at
login; the switch happens in a single release, when nothing is missing.

---

## Features

- **Compositor**: Hyprland (Wayland) — smooth animations, tiling + floating window management. Moving to Hyalo, Veltrix's own ([see above](#where-it-is-going-hyalo)).
- **Shell**: TypeScript on GTK4, bundled with esbuild — modular UI, custom-painted with Cairo.
- **Bar**: Live clock, workspaces, system tray, resource indicators, system menu with inline power actions.
- **Activity Island**: A capsule at the center of the bar that morphs into whatever is happening — workspace dots at rest, then media playback, screen recording, a low-battery warning, or the built-in Assistant — and expands into a panel for it.
- **Assistant**: A built-in AI assistant that lives in the Activity Island (`Super + A`). It runs **locally against Ollama only** (`http://localhost:11434/v1`, not editable), with no API key anywhere — the hosted-provider and keyring path was deleted in the fork. It is **off by default** and only runs after an explicit opt-in in **Settings → AI**. It can read and change Veltrix's own settings for you once you switch those permissions on; everything it is allowed to touch is a switch in **Settings → AI**.
- **Dock**: Hover magnification with spring physics. Supports bottom, left, and right positions.
- **App Launcher**: App grid with instant fuzzy search.
- **Search**: Type-to-find overlay for apps and recent files (`Super + Space`).
- **Control Center**: Volume (WirePlumber), brightness, Wi-Fi, Bluetooth, battery, MPRIS media.
- **Notification Center**: Grouped notifications with inline actions.
- **Clipboard history**: Recent copies — text *and* images — kept in a browsable panel, with per-entry delete.
- **Screen recording**: Full screen or a region, MP4/MKV/WebM, with optional audio from desktop output or any microphone; a live indicator in the Activity Island while it runs.
- **Settings**: Independent application — a Settings crash leaves the bar and dock running. Multi-page panel — Network, Bluetooth, Appearance, Display, Audio, Top Bar, Dock, Control Center, Notifications, Accessibility, Apps, Devices, Power, Language & Region, Autostart, Users, AI, and About.
- **Veltrix Design System**: Ten preset accents plus any hex (picked in Studio), cyan `#00E5FF` the default — glassmorphism tokens, dark/light mode.
- **AI-native**: A built-in Assistant ships with the desktop, and an MCP server (`veltrix-mcp`) lets any external coding agent perceive and drive the live desktop through the same official interface; an in-repo agent skill and a PR-based contribution model are built for AI-authored improvements. Built with AI, operable by AI, improved by AI — see [Using an AI agent](#using-an-ai-agent-with-your-desktop) and [Contributing](#contributing).
- **Login & Lock**: Custom GTK4 apps — a greetd-based greeter (`veltrix-greeter`) and a lock screen (`veltrix-lock`) built on `ext-session-lock-v1`, both sharing the Veltrix look. The greeter is launched directly by greetd (no regreet); the lock screen uses no hyprlock.
- **Prayer lock**: at each prayer time (calculated offline, ISNA default — see `bin/veltrix-prayer-times --help` and `~/.config/veltrix/prayer.json` for method/madhab/offsets) the shell spawns `veltrix-prayer-lock`, a 60-second fullscreen overlay naming the prayer; hold Esc for 3 seconds to exit early in an emergency. If the overlay ever strands you: Ctrl+Alt+F2, log in, `killall veltrix-prayer-lock`, Ctrl+Alt+F1 back to the desktop.
- **Idle management**: hypridle — configurable screen-off, lock, and suspend timers.
- **Internationalization**: The shell ships in 13 languages — English, Spanish, French, German, Italian, Brazilian Portuguese, European Portuguese, Polish, Dutch, Russian, Simplified Chinese, Japanese, and Arabic (Settings → Language & Region). Arabic is first-class: full RTL layout and Noto Naskh Arabic / Noto Sans Arabic fonts. Clocks and dates follow the system regional format (`LC_TIME`), including on the login and lock screens.

---

## Hardware & platform support

Veltrix is young. This is what it has actually been tested on — not what we hope works.

> **Fork status:** the list below is what **upstream Nidara** tested, carried over with
> the fork. The fork itself has not been validated on any hardware yet — that is Phase 0
> (`docs/dell-validation-phase0.md`, Dell Latitude 7400). Treat every line below as
> "upstream-tested, fork-unverified" until the Dell run lands.

**✅ Supported** — tested by the maintainer; bugs here are treated as priority.

- Vanilla **Arch Linux** (x86_64), from a minimal base install
- **EndeavourOS** — the maintainer's daily driver (it uses Arch's own repos unmodified)
- **AMD and Intel GPUs** (Mesa)
- Single-monitor desktops
- **QEMU/KVM** VMs with `virtio-gpu-gl` (for trying it out)

**🧪 Experimental** — wired up and expected to work, but not validated on real hardware
yet. Reports (and fixes) are the most valuable contribution you can make right now.

- **NVIDIA GPUs** (proprietary driver or open kernel modules): the installer auto-detects
  your card and driver and configures the environment for you, but upstream NVIDIA support
  is newer and less battle-tested than AMD/Intel, and we haven't verified it on real NVIDIA
  hardware. Nouveau is untested.
- **Multi-monitor**: the bar and dock spawn on every display and per-monitor
  scale/mode/VRR live in Settings → Display, but hotplugging a display currently needs a
  UI reload (`Super + Shift + R`).
- **Laptops**: battery, brightness keys and idle/suspend timers work; lid-switch
  behaviour and suspend/resume cycles are untested.
- Other Arch derivatives that track Arch's repos closely.

**❌ Not supported**

- Derivatives with delayed or held-back packages (e.g. **Manjaro**) — Veltrix pins
  Hyprland ≥ 0.56 and builds its UI stack against current Arch libraries
- **VirtualBox** (no usable 3D acceleration for Wayland compositors)
- X11 (Wayland-only by design), ARM

Hardware-compatibility fixes are explicitly a "global" contribution — see
[Contributing](#contributing).

---

## Installation

> This installs **the desktop environment** onto an Arch system you already have. If what you
> want is the whole operating system on a blank disk, that is **Veltrix**, and it comes as a live
> image — upstream Nidara ships one from
> [nidara-iso](https://github.com/nidara-project/nidara-iso); **VELTRIX has no live image
> yet**. The upstream link above is for reference only: the medium is unsigned, so Secure Boot
> has to be off to boot it.

VELTRIX targets **Arch Linux** (see [Hardware & platform support](#hardware--platform-support)
for what's tested, including which Arch derivatives qualify). The intended starting point is a
**minimal Arch base with no desktop environment** — log in at the TTY and install the package; it
pulls everything else in. It also works on top of an existing Arch desktop: if a display manager
is already enabled it is left untouched and VELTRIX is just added as another session to
pick at login.

**There is one way in: the package.** The script further down is not a second one — it installs a
development copy for working on the desktop itself, and run without arguments it now just points
back here.

**It treats the machine as yours.** It does not rename your operating system — on a system
converted this way, Settings → About correctly reads *Arch Linux* for the OS and *VELTRIX*
for the environment. It does not touch your bootloader, and it does not choose your applications.

### The package

VELTRIX ships as a **signed pacman package** in the project's own repository. Adding that
repository and installing from it is the whole install: no clone, no script, and pacman owns every
file from the first second — clean upgrades with the rest of your system, clean removal with
`pacman -R veltrix`, no untracked drift. There is no AUR helper anywhere in this.

**1. Trust the signing key.**

> ⚠️ **The `[veltrix]` repository and its signing key do not exist yet.** The
> commands below are the intended shape only — the key file and fingerprint are
> placeholders. Do not run them until a release publishes the repo and the real
> key; running them today fails at the first `curl` (there is nothing to download).

```bash
# TODO — commented out on purpose: the repo and key do not exist yet.
# Uncomment only when a release publishes them, and verify the key against the
# fingerprint in the release notes (independent channel) before --lsign-key.
# curl --proto=https -O https://adnqcr7-code.github.io/veltrix-repo/veltrix.gpg
# sudo pacman-key --add veltrix.gpg
# sudo pacman-key --lsign-key <FINGERPRINT — published with the first release>
```

Every package and the repository database are GPG-signed by CI with that key. `--lsign-key` is not
optional — without local trust, pacman ignores signatures from it entirely.

**2. Add the repository** — append this to `/etc/pacman.conf`:

```ini
[veltrix]
SigLevel = Required DatabaseOptional
Server = https://adnqcr7-code.github.io/veltrix-repo/$arch
```

Leave `$arch` exactly as written; pacman expands it.

**3. Install it, and run the one-time setup.**

```bash
sudo pacman -Syu veltrix
veltrix-setup
```

> **Note:** one dependency, `awww` (the animated-wallpaper daemon), comes
> from the **AUR, not Arch extra** — see the note in
> `packaging/veltrix/PKGBUILD`. A bare `pacman -Syu veltrix` cannot resolve
> it from the official repos; the `[veltrix]` repo must ship it (or you build
> it from the AUR) or the install fails on that dependency.

Syncing, upgrading and installing in **one** transaction is deliberate: Arch does not support
partial upgrades, so a package installed against a freshly synced database on a system that has
not been upgraded is how a new library ends up beside its old dependants. It is also your
decision to read and approve, which is the other reason it is written this way here.

`veltrix-setup` is the part packaging cannot do: it creates `~/.config/veltrix/` with default
configs (never overwritten afterwards), seeds your keyboard layout and timezone from the Arch
setup you already have, generates the system locales for every language the UI ships, and enables
`pipewire`, `wireplumber`, `power-profiles-daemon`, `bluetooth` and — only if no display manager
is already enabled — `greetd` with the Veltrix greeter. It never prompts, and it is idempotent:
running it again repairs rather than duplicates.

**To start:** reboot and select _VELTRIX_ from the login screen.

### The script is for working ON the desktop

```bash
sudo pacman -S --needed git
git clone https://github.com/adnqcr7-code/veltrix.git ~/Dev/veltrix
cd ~/Dev/veltrix
./install.sh --dev
```

`install.sh` installs a **development copy**: the shell runs from your working tree instead of
from an installed bundle, so editing a `.tsx` and pressing `Super+Shift+R` shows the change. That
is the path for contributing, and the [Developer Guide](#developer-guide) picks up from here.

⚠️ **It is not another way to install the desktop.** It used to be — a bare `./install.sh` did a
system install — and it no longer is: run without arguments it prints the package commands above
and stops. One way in, and pacman owns the files.

⚠️ **It will run `sudo pacman -Syu` and show you the transaction.** Arch does not support partial
upgrades, so the dependencies cannot go on until the system is current. Nothing is installed until
you accept, and declining stops the install rather than continuing against out-of-date libraries.
It used to pass `--noconfirm` and upgrade machines unattended; that was wrong on a machine the
project does not own.

### The extra-apps question (`./install.sh --dev` only)

After everything is ready and before first login, the install terminal asks which extra apps
you want — FreeTube, WhatsApp, Telegram, Spotify, VLC, LibreOffice, VS Code, Discord,
GIMP, Vile — by number, or `all`, or nothing (empty = none). Nothing is installed unless you pick it.
Two things about that step are worth knowing before you run it:

- **Pre-download (~700 MB, before you are asked).** Step 1 pre-downloads the six repo
  packages into the pacman cache (LibreOffice alone is ~400 MB) so the ones you pick install
  in seconds. The download happens before the question is asked, even if you end up picking
  none; the step-1 output says so before it runs. Unpicked packages stay in the pacman cache
  (cleanable with `sudo pacman -Sc`). If step 1 was skipped (package list unchanged), the
  cache may be cold and the prompt says so honestly instead.
- **Spotify and FreeTube add Flathub, system-wide, permanently.** Picking Spotify
  installs `com.spotify.Client` from Flathub, and picking FreeTube installs
  `io.freetubeapp.FreeTube` from Flathub; either one adds Flathub as a persistent
  system-wide Flatpak remote — any user of the machine can then install apps from
  Flathub. The prompt says so before you choose. Neither is ever pre-downloaded
  (Flatpak has no download-only step); each downloads when picked. FreeTube is the
  privacy-focused YouTube client (no ads, no tracking, no account, no recommendation
  feed) and replaces the old YouTube web app in v1.2 — it still plays YouTube videos,
  without the parts that push content at you.
- **Vile builds from source, when picked.** Picking Vile (Adnan's own privacy
  browser) installs its build tools on demand (`cmake`, `sqlite`, `qt6-base`,
  `qt6-webengine` — Qt WebEngine is the big download, ~100 MB+) and compiles it
  from the source vendored in `vile/` (see `vile/VENDORED.md`); the build takes a
  few minutes. The prompt says so before you choose. Nothing Vile is downloaded
  or installed unless you pick it — there is no package, no Flatpak and no
  download URL.

Your choice is recorded in `/etc/veltrix/apps.json` (`{"apps": [...], "failed": [...]}`) and
installed versions in `/etc/veltrix/apps-versions.log`. A failed app never blocks the install;
failures are listed in the final banner. The question is never asked twice — delete
`/etc/veltrix/apps.json` to be asked again.

#### Removing the extra apps

```bash
# Repo packages (only the ones you picked):
sudo pacman -Rns telegram-desktop vlc libreoffice-fresh code discord gimp
# Web app (WhatsApp) is just a .desktop file:
sudo rm /usr/share/applications/veltrix-whatsapp.desktop
# Spotify + FreeTube + the Flathub remote they added:
flatpak uninstall com.spotify.Client io.freetubeapp.FreeTube
sudo flatpak remote-delete flathub   # only if no Flatpak app is left using it
# Vile is a local build, not a package — binary, desktop file and icon:
sudo rm /usr/local/bin/vile /usr/share/applications/vile.desktop /usr/share/icons/hicolor/256x256/apps/vile.png
sudo gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
# (Vile's build tools — cmake, sqlite, qt6-base, qt6-webengine — stay installed;
# remove them with pacman if nothing else uses them.)
# The record of the choice (optional):
sudo rm /etc/veltrix/apps.json /etc/veltrix/apps-versions.log
```

A failed app can be retried by hand with the same commands the installer would have run
(`sudo pacman -S <package>`, or the Flatpak commands above for Spotify/FreeTube); for Vile,
delete `/etc/veltrix/apps.json` and re-run the installer, or build it by hand from `vile/`
(see `vile/VENDORED.md`). There is no automatic
first-boot retry — the `failed` list in `apps.json` is the record, not a queue.

### What is guaranteed, and where

These are two different promises, and it is worth knowing which one you are taking.

**On the live image**, the whole system is ours: the package set, the kernel, the boot path and
the hardware handling are chosen together, tested together and shipped as one artifact. That is
where a problem is ours to fix.

**On your own Arch**, we support the package. We do not promise anything about your kernel, your
graphics stack, your bootloader or the rest of your system, because we did not choose them — and
because treating your machine as ours is exactly what the rule above forbids. In practice this
path is stable and it is what most contributors run; the difference is what happens when it is
not, and who is expected to sort it out.

### Updating

```bash
veltrix-update
```

That's it — no git knowledge needed. New releases arrive through the signed pacman repo like
any other package: `veltrix-update` runs a full system upgrade (`pacman -Syu`), re-applies the
idempotent setup, and reloads the running session — the last two only when the version actually
changed. A plain `pacman -Syu` delivers the same release (it's just a package); `veltrix-update`
is the wrapper that also handles setup and the live reload. Updates take a minute, not an hour:
prebuilt packages, no local builds.

An install that predates the package model has no package for `veltrix-update` to upgrade, so it
prints the three commands above and stops. Installing the package once is the migration: pacman
takes ownership of the files the old install wrote, and every later update takes the package path.
The folder you originally cloned stays disposable, and your configuration in `~/.config/veltrix/`
is never touched either way. **Settings → About** also tells you when a new release is available.

> **Status:** this page is the *existing Arch* path. The other path — a live
> image that installs a complete system on a blank disk — exists upstream as **Veltrix** in
> [nidara-iso](https://github.com/nidara-project/nidara-iso); **VELTRIX has no live image
> yet**, so the upstream note below is reference, not a fork promise. (An earlier upstream
> note promised a Calamares installer. That was reconsidered and dropped — the reasoning is
> in that repo's `INSTALLER.md`.)

---

## User Configuration

User config lives in `~/.config/veltrix/` and is **never overwritten** by updates.

The Hyprland config is written in **Lua** (requires Hyprland ≥ 0.56). To customize
Hyprland (monitors, keyboard layout, startup apps, extra keybinds), edit:

**`~/.config/veltrix/hyprland-user.lua`**

```lua
-- Keyboard layout
hl.config({ input = { kb_layout = "es" } })

-- Monitors
hl.monitor({ output = "HDMI-A-1", mode = "1920x1080@60", position = "0x0", scale = 1 })

-- Custom keybinds
hl.bind("SUPER + F1", hl.dsp.exec_cmd("firefox"))

-- Autostart (runs once on Hyprland start)
hl.on("hyprland.start", function()
    hl.exec_cmd("uwsm app -- my-app")
end)

-- Override any Hyprland setting
hl.config({ general = { gaps_out = 16 } })
```

> **NVIDIA users** — set NVIDIA / Wayland environment variables in
> `~/.config/uwsm/env` and `~/.config/uwsm/env-hyprland` (both created on first
> install), not in the Hyprland config.

### Using an AI agent with your desktop

There are two ways in, and they share the same permission switches in **Settings → AI**.

#### The built-in Assistant

Press `Super + A` and the Activity Island turns into an assistant that already knows the
desktop it lives in — ask it to change a setting, explain what something does, or find where an
option lives, in plain language.

It is **local-only**. In **Settings → AI**, the only provider is **Ollama**, at the fixed
endpoint `http://localhost:11434/v1` — there is no key to paste, no hosted provider to
pick, and no custom endpoint to point at. The Assistant is **off by default** and only
runs after an explicit opt-in. If Ollama is not running on your machine, the Assistant
has nothing to talk to and says so.

What it is allowed to do is yours to set. By default it can do nothing beyond answering — the Assistant itself is off until you opt in, and changing settings, screenshots, file access, computer control and the MCP server are each a separate opt-in in **Settings → AI**, all off until you switch them on. While it is granted control of your apps the bar shows a live indicator, and `Super + Shift + Escape` revokes it instantly.

#### Bringing your own agent

Veltrix ships an **MCP server** (`veltrix-mcp`, installed system-wide) that lets
an AI agent see and control your running desktop through the official interface: discover and
change settings, run shell actions, read state, take screenshots to verify its work. First
enable the MCP server in **Settings → AI** (it is off by default), then tell it:

> *Register the MCP server described in `~/.config/veltrix/.mcp.json`*

That manifest is installed for you (and kept up to date — it's the one file in the config dir
the installer manages). Claude Code users who open a session inside `~/.config/veltrix/`
get it auto-discovered. Everything an agent can do is governed by the consent toggles in
**Settings → AI** — config writes, screenshots and the MCP server itself are off by default
and can each be switched on or off at any time, taking effect immediately.

---

## Keybindings

### Window Management

| Shortcut | Action |
| :--- | :--- |
| `Super + Q` | Close active window |
| `Super + F` | Toggle floating |
| `Super + M` | Toggle maximize (keeps the bar visible) |
| `Super + Shift + F` | Toggle fullscreen |
| `Super + P` | Toggle pseudo-tiling (dwindle) |
| `Super + H` | Hide active window (app keeps running; dock icon brings it back) |
| `Super + Alt + Left / Right / Up / Down` | Snap window to half of the screen (Hyprland only) |
| `Super + Alt + C` | Centre window at its current size |
| `Super + Left / Right / Up / Down` | Move focus |
| `Alt + Tab` / `Alt + Shift + Tab` | Cycle windows on the workspace |
| `Super + Tab` / `Super + Shift + Tab` | Cycle windows on the workspace |
| `Super + Shift + Arrow` | Resize active window |
| `Super + Mouse drag (left button)` | Move window |
| `Super + Mouse drag (right button)` | Resize window |

### Workspaces

| Shortcut | Action |
| :--- | :--- |
| `Super + 1–5` | Switch to workspace |
| `Super + Shift + 1–5` | Move window to workspace |
| `Super + W` | Workspace overview (`← / →` to navigate, `Enter` to switch) |
| `Super + Scroll` | Cycle workspaces |
| `Super + Ctrl + ← / →` | Previous / next workspace |
| `Super + Ctrl + Shift + ← / →` | Move window to previous / next workspace |

### Apps & Shell

| Shortcut | Action |
| :--- | :--- |
| `Super + A` | Assistant (Activity Island) |
| `Super + S` | Open Settings |
| `Super + ,` | Open Settings |
| `Super + Space` | Search (apps & recent files) |
| `Super + T` | Terminal (Kitty) |
| `Super + E` | Files (Nautilus) |
| `Super + L` | Lock screen |
| `Super + B` | Bar overlay (bar above fullscreen windows) |
| `Super + Shift + Escape` | Revoke AI computer-control instantly (kill switch) |
| `Super + Shift + R` | Reload Veltrix UI |
| `Super` (tap) | Toggle App Launcher |

### Screenshots

| Shortcut | Action |
| :--- | :--- |
| `Print` | Region screenshot → clipboard |
| `Shift + Print` | Region screenshot → `~/Pictures/` |
| `Super + Print` | Full-screen screenshot → clipboard |
| `Super + Shift + Print` | Full-screen screenshot → `~/Pictures/` |

### Media & hardware keys

Volume, microphone mute, brightness and media-transport keys (`XF86*`) work out of
the box — including on the lock screen. Brightness never steps down to fully black.

---

## Developer Guide

### Setup

```bash
git clone https://github.com/adnqcr7-code/veltrix.git ~/Dev/veltrix
cd ~/Dev/veltrix
./install.sh --dev
```

`--dev` installs system binaries normally but writes `~/.config/veltrix/.dev` pointing to your repo. The `veltrix-ui` launcher detects this file and runs `scripts/run.sh app.ts` from source — no full rebuild needed to see changes.

```bash
cd ui/shell
npm install   # IDE support (TypeScript autocomplete)
```

### Project Structure

Veltrix is **three independent bundles** (shell, greeter, lock screen), plus the
provisioning and Hyprland config:

```
veltrix/
├── config/
│   ├── hypr/                  # Hyprland Lua config + hypridle (→ /usr/share/veltrix/)
│   ├── greetd/                # greetd config + greeter Hyprland session
│   └── applications/          # .desktop entries
├── defaults/                  # Seed user configs (copied once on first install; never overwritten)
│   ├── uwsm/                  # env / env-hyprland templates (toolkit & NVIDIA vars)
│   └── wallpaper/             # Default wallpaper (shipped asset)
├── bin/                       # Installed binaries/launchers (→ /usr/bin, /usr/lib/systemd)
│   ├── veltrix                 # Wayland session entry → /usr/bin/veltrix
│   ├── veltrix-ui              # UI launcher (dev/system) → /usr/bin/veltrix-ui
│   ├── veltrix-greeter         # Greeter launcher
│   ├── veltrix-lock            # Lock screen launcher (Super+L)
│   ├── veltrix-setup           # Idempotent first-time setup
│   ├── veltrix-update          # Update wrapper (pacman -Syu + setup + reload)
│   ├── veltrix-agent           # The built-in Assistant's daemon (Super+A)
│   ├── veltrix-mcp             # MCP server for external agents
│   ├── veltrix-a11y/-act       # AT-SPI perceive / act (computer use, opt-in)
│   ├── veltrix-hijri-date       # Hijri date helper for the menu bar
│   ├── veltrix-weather          # Weather helper for the menu bar
│   └── …                      # + portal, doctor, input, sleep hooks
├── scripts/                   # Repo tooling (not installed): i18n extract/apply, dev helpers
├── VERSION                    # Current version (semver)
├── install.sh                 # Provisioning script (system / --dev)
└── ui/
    ├── shell/                 # Main shell (TypeScript → GJS on GTK4)
    │   ├── app.ts             # Entry point + IPC request handler
    │   ├── core/              # State (Status), theme engine (VeltrixTheme), services
    │   ├── surfaces/          # Shell surfaces + shared Settings page sources
    │   ├── widgets/           # Auto-registered atomic widgets (battery, wifi, media…)
    │   ├── common/            # Shared UI pieces (Slider, SquircleContainer, fade…)
    │   ├── styles/            # Modular SCSS (tokens, glass mixin, per-component)
    │   ├── style.css          # Compiled CSS — generated from styles/ (gitignored)
    │   └── build/veltrix    # Bundle output from scripts/bundle.sh (gitignored)
    ├── settings/              # Independent Settings entry point, styles and build
    ├── greeter/               # Login screen (greetd + AstalGreet)
    ├── lockscreen/            # Lock screen (ext-session-lock-v1, shares greeter CSS)
    └── lib/veltrix-kit/        # GTK4 primitive widgets (no Adwaita): SplitView, Scrolled, Button…
```

The runtime architecture, IPC contract, persistence layout and design-system rules are documented in
the in-repo agent skill at `.claude/skills/veltrix/` (`SKILL.md` + `references/`). It ships
with the code on purpose — see [Contributing](#contributing).

### Development Workflow

- **Reload UI:** `Super + Shift + R`
- **Logs:** `tail -f "$XDG_RUNTIME_DIR/veltrix-ui.log"`
- **Kill stale GJS process:** `killall gjs`
- **Compile SCSS:** `cd ui/shell && sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css`
- **Type-check:** `cd ui/shell && npm run typecheck` (catches type errors before they reach the running shell)

Optionally, you can drive the running shell from the CLI to test a specific surface — e.g.
`veltrix-ipc toggleAppGrid` (the full command list lives in the `requestHandler` in `ui/shell/app.ts`).

Before opening a PR, make sure the SCSS build passes (`cd ui/shell && npm run build`) and, if you
have the git-ignored `@girs/` typings, the typecheck too. See [Contributing](#contributing) for the
personal-vs-global heuristic and the full PR flow.

---

## Contributing

Veltrix is **AI-native by design**: it ships an agent skill inside the repo
(`.claude/skills/veltrix/`, also reachable as `.agents/skills/veltrix/`) so that anyone running a
coding agent — [Claude Code](https://claude.com/claude-code), Codex, Gemini, Cursor or another —
can extend, customize, and fix their own desktop, and propose globally-useful improvements back
upstream. Every agent starts from the same [`AGENTS.md`](AGENTS.md). You can also contribute the traditional way.

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). The key idea: classify each change as **personal**
(stays in your config), **a setting** (add the knob, not a hardcode), or **global** (worth a PR —
correctness, hardware compatibility, performance, accessibility).

All participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Credits

VELTRIX stands on the work of some excellent open-source projects:

- **[Aylur](https://github.com/Aylur)** — [AGS](https://github.com/Aylur/ags) and the
  [Astal](https://github.com/Aylur/astal) libraries: the framework VELTRIX was built on,
  and the reason it got off the ground. None of it is loaded any more — the application host, the
  bundler, every service and the PAM authentication are the project's own since 0.8.0 — and the
  credit stands anyway: from the first commit to that release, this was built on their work.
- **[Hyprland](https://hyprland.org)** — the Wayland compositor at Veltrix's core, along with
  hypridle, hyprsunset, and xdg-desktop-portal-hyprland from the same ecosystem.
- **[GNOME](https://www.gnome.org)** — GTK4 and GJS, the toolkit and runtime under every Veltrix surface.
- **[Arch Linux](https://archlinux.org)** — the distribution VELTRIX is built for, and
  the base the Veltrix operating system is built on.
- **[Lucide](https://lucide.dev)** — the icon set used throughout the shell
  (ISC license; see [`NOTICE`](NOTICE)).

…and the wider stack Veltrix relies on every day: [greetd](https://git.sr.ht/~kennylevinsen/greetd),
[PipeWire](https://pipewire.org) & WirePlumber, [uwsm](https://github.com/Vladimir-csp/uwsm),
and many more. Thank you.

---

## License

Veltrix is released under the **GNU General Public License, version 3 or later**
(GPL-3.0-or-later). See [`LICENSE`](LICENSE) for the full text.

**The kit is the exception:** `ui/lib/veltrix-kit/`, the platform library every Veltrix
application loads, is under the **GNU Lesser General Public License, version 3 or later**
(LGPL-3.0-or-later; [`COPYING.LESSER`](ui/lib/veltrix-kit/COPYING.LESSER)). An app built on
the kit can carry any licence it likes; changes to the kit itself stay open. Same split as
GTK and libadwaita under GNOME, or KDE Frameworks under Plasma.

Copyright (C) 2026 The Veltrix Authors.

This is the same license used by AGS, the project Veltrix grew out of, and is compatible with the
LGPL-2.1 libraries it builds on (GTK4, Astal). You're free to use, study, modify, and
redistribute it — derivative works must remain open under the same terms.

## Trademarks

The GPL covers this project's **source code**. It does **not** grant rights to the
**"Veltrix" and "VELTRIX" names or the logo**, which are trademarks of the Veltrix
project.

You are welcome to fork and redistribute the code under the GPL — but a fork or
redistribution that is not the official project **must use a different name and
logo**, and must not present itself in a way that implies endorsement by, or
affiliation with, the Veltrix project. (Same model as Firefox, GNOME and many
other open-source projects: the code is free, the brand identifies the project.)

See [`NOTICE`](NOTICE) for attribution details.
