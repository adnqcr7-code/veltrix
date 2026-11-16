# Packaging

## The `veltrix` package (`packaging/veltrix/`)

Veltrix itself ships as a **pacman package**. The PKGBUILD lives **in this repo**
— it travels inside every release tag — so the recipe can never drift from the
tree it packages, and each release is self-describing. Three consumers, one
recipe:

1. **`veltrix-repo` CI** builds the *published* package: it fetches the tag
   tarball pinned by `VELTRIX_REF` in `veltrix-repo/pins.env` and builds with the
   PKGBUILD found inside it, refusing to publish if the tag, the tree's
   `VERSION` and the PKGBUILD's `pkgver` disagree. Release runbook: tag first,
   then bump `VELTRIX_REF` (one line) — CI republishes.
2. **`install.sh --system`** installs the prebuilt package when the tree is
   exactly that release (clean `v$VERSION` checkout or git-less release
   tarball), with a version==VERSION lockstep guard.
3. **`install.sh`'s local fallback** builds the same PKGBUILD from the working
   tree (repo down / lagging / non-release tree): the tree is packed as the
   tarball makepkg expects, uncommitted changes included — the escape hatch
   installs what's here.

`pkgver` **must equal the repo's `VERSION`** — bump both in the release commit
(veltrix-repo's lockstep gate enforces it at publish time).

Packaging deliberately ships **files only**. Everything a first login needs —
per-user config seeding, uwsm env + NVIDIA autodetect, greetd/DM, service
enablement — lives in `bin/veltrix-setup` (idempotent, shared by every install
path): `sudo pacman -S veltrix && veltrix-setup` is a complete install.
`veltrix-update` on a package install is just `pacman -Syu` + `veltrix-setup`.
Dev installs (`install.sh --dev`) keep copying source files into /usr directly
and **remove the package first** so `pacman -Syu` can't clobber the copies.

## Native C libraries & dependencies

Veltrix has **zero external Astal dependencies**. Everything is either native TypeScript or native C with GObject Introspection typelibs compiled directly during build:

- **`lib/veltrix-wl/`** (`gi://VeltrixWl`): Wayland protocol wrappers (virtual pointer, layer shell visible region, window capture, focus grab).
- **`lib/veltrix-auth/`** (`gi://VeltrixAuth`): PAM authentication wrapper and async conversation broker for the lockscreen (`/etc/pam.d/veltrix-lock`).

All package dependencies are standard packages available in the official Arch Linux repositories (`extra`).

## Why packages instead of `meson install`

Earlier releases ran `sudo meson install` straight into `/usr`. Those files were
**untracked**: `pacman -Qo` reported "no package owns", so they were invisible,
un-upgradable and un-removable. That blind spot is exactly what let a stale, crashing
`appmenu-glib-translator` sit frozen for weeks with no way to see it. (That package is
gone as of 2026-08-18 — it was only ever `libastal-tray`'s dbusmenu translator, and both
left together — but the reason for packaging everything stands.)

`install.sh` now generates a tiny **PKGBUILD per component** and installs via
`makepkg` + `pacman -U`. The libraries become first-class pacman packages — `pacman -Qo
/usr/lib/libastal-gtk4.so` now names the package and version, upgrades replace cleanly,
and removal is clean.

## How the build works (`install.sh` §2 and §4)

- Astal has **no root `meson.build`**: each `lib/*` is built standalone and finds the
  others via `pkg-config`, so they are built **in dependency order** (`io` first) and
  each is installed before the next is built. One package per lib (mirrors the AUR
  `libastal-*` layout).
- The astal git source is cloned **once** into a shared `SRCDEST` and reused across the
  14 component builds.
- `makepkg` runs as the unprivileged user (it refuses root); `pacman -U` runs via sudo.
- Install used to pass `--overwrite '*'` for the one-time hand-off from the old untracked
  `meson install` files. That migration is spent (2026-08) and the flag was removed in the
  Phase 0 fix pass: kept, it would let every install silently clobber any file owned by any
  package. A conflict now fails loud instead.
- `depends=()` is intentional for now: every runtime dep is already pulled in by
  `install.sh` §1's `pacman -S`, and empty deps keep this first packaging pass from
  failing on transient resolution.
- ⚠️ The `makedepends` in the generators below are the **minimum for this path only**,
  where §1 has already installed everything. `veltrix-repo` has no such step and derives
  its whole CI toolchain from the `makedepends` its committed PKGBUILDs declare, so the
  authoritative per-package lists live in that repo's `scripts/gen-pkgbuilds.sh` — if you
  add a build dep here, add it there too, or CI builds without it and fails.
- The same applies to **`veltrix/PKGBUILD` in this directory**, which veltrix-repo reads
  straight out of the release tag: anything its `build()` reaches for must be named in
  `makedepends` or it will not exist in the build container. That is how v0.7.0 died on
  a missing `hyprland-focus-grab-v1.xml`.

> **Fork status (Phase 0):** the two "DONE" items below describe **upstream Nidara's**
> published repo, not this fork's. The `[veltrix]` pacman repository, its CI, and its
> GPG signing key **do not exist yet** — the URLs and the key file they name are
> placeholders, and the upstream signing key was deleted from this tree
> (`packaging/nidara-repo.gpg` removed; do not re-add it). Treat this whole section as
> "how publishing is intended to work", not as a claim about what exists today.

## Where this is heading (veltrix-repo)

This is the local/dev form. The intended end state for the distributable DE:

1. ✅ **DONE (2026-06-21)** — these generated PKGBUILDs are now **committed** in
   [`adnqcr7-code/veltrix-repo`](https://github.com/adnqcr7-code/veltrix-repo) and built by
   CI into real `.pkg.tar.zst` artifacts, published to a pacman repo on GitHub Pages:
   `https://adnqcr7-code.github.io/veltrix-repo/$arch` (pacman repo name `veltrix`;
   **GPG-signed since 2026-07-05** — packages + db signed by CI, clients use
   `SigLevel = Required DatabaseOptional`, public key to be bundled here as
   `veltrix-repo.gpg` and imported by `install.sh` — **not yet generated**).
2. ✅ **DONE (2026-06-21, Phase 3)** — `install.sh` consumes `veltrix-repo`: it registers the
   repo in `pacman.conf` and `pacman -S`'s the stack — **no build toolchain on the user's
   machine**, identical pinned binaries for everyone, dep bumps propagate via `pacman -Syu`.
   The from-source build (§2) remains as the automatic fallback when the repo is
   unreachable or lags the pin (lockstep guard).
3. At that point tighten `depends=()` to real runtime deps and add `provides`/`conflicts`
   so the packages coexist cleanly with any future AUR/official Astal packages.

`install.sh --dev` keeps building from source locally for development either way.

> **Lockstep pins (permanent):** the pinned revisions live in **two** places —
> `install.sh`'s `ASTAL_REF` (kept for the from-source fallback and
> the update pin-skip record) and `veltrix-repo/pins.env` (the repo build). Bump **both**
> together, always. `pins.env` additionally carries `VELTRIX_REF` — the veltrix release
> tag the published `veltrix` package is built from (see the top of this file).
