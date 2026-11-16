// Pure rotation-step selection for the wallpaper rotator.
//
// No imports at all: this is pure math over a catalogue, so a probe can
// drive it without GTK, GJS or a display — the same reason the game-session
// logic lives in its own pure file. `ui/lib/wallpaper.ts` re-exports it so
// callers that already import from there keep working.

/**
 * The next wallpaper a rotation step lands on: `pool` is the bundled
 * catalogue in order, `current` the wallpaper on screen now, `savedIndex`
 * the last sequential index (for a current that is not in the pool),
 * `shuffle` picks randomly instead of in order. Returns null when there is
 * nothing to rotate to (fewer than two in the pool, or the only other one
 * is the current).
 */
export function nextRotationPath(
    pool: string[],
    current: string,
    savedIndex: number,
    shuffle: boolean,
): { path: string; index: number } | null {
    if (pool.length < 2) return null
    const base = (p: string) => p.split("/").pop() ?? p
    const curBase = base(current)
    if (shuffle) {
        const others = pool.filter((p) => base(p) !== curBase)
        if (others.length === 0) return null
        const path = others[Math.floor(Math.random() * others.length)]
        return { path, index: pool.indexOf(path) }
    }
    const at = pool.findIndex((p) => base(p) === curBase)
    const next = at >= 0 ? (at + 1) % pool.length
        : (savedIndex >= 0 ? (savedIndex + 1) % pool.length : 0)
    return { path: pool[next], index: next }
}
