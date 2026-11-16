-- birth-placement-probe.lua — a newborn floating window is written ONCE, at its
-- final rectangle.
--
--   lua5.4 scripts/dev/birth-placement-probe.lua [config/hypr/hyprland.lua]
--   lua5.4 scripts/dev/birth-placement-probe.lua --broken <path-to-old-config>
--
-- Drives the REAL `config/hypr/hyprland.lua` against a fake `hl` — no Hyprland,
-- no GJS, no Dell. The fake records every `hl.dispatch` and answers
-- `hl.get_windows` from a per-scenario list, so the probe can count exactly how
-- many moves/resizes a birth writes and where they point.
--
-- What it has to show, in order:
--   1. an oversized birth (Brave's shape: 1900x1060 at (10,10)) is shrunk to the
--      85% ceiling (1623x909) with exactly ONE move, to the clamped position;
--   2. a birth that would completely cover another window (Settings 1100x760
--      born centred over Files) is stepped ONCE, straight to the cascaded
--      position (548,288);
--   3. an oversized birth OVER an existing window — the discriminating case: a
--      second oversized browser born at (10,10) over the first (1623x909 at
--      (10,10)). The old shape wrote THREE dispatches, resize + move(10,10) +
--      move(38,38), and a frame between the two moves showed the window at the
--      clamped rectangle before it jumped; the fixed code writes resize +
--      move(38,38) only;
--   4. a no-size birth (Hyprland's invented 640x400) opens at 1100x700;
--   5. `window.update_rules` never cascades: a fitting window over Files is not
--      moved at all, and a window pushed above the top edge is pulled back to
--      the top only;
--   6. a fullscreen birth is untouched.
--
-- The monitor is the Dell's: 1920x1080, no reserves (at birth the bar and dock
-- have released theirs — the newborn's workspace has a fullscreen window on it),
-- so the usable area is (5,5) 1910x1070 and the 85% ceiling is 1623x909.
--
-- ⚠️ Prove it can FAIL before believing a green run. `--broken <old-config>`
-- re-runs the SAME assertions against the pre-fix config: it must FAIL
-- (scenario 3 writes three dispatches there: resize + move(10,10) +
-- move(38,38)). If it passes, the assertions are not reading the dispatch log.
-- The pre-fix file is not in the repo — rebuild it by reversing the
-- compute/dispatch split in `placeFloatingGuarded` (clamp, then cascade, each
-- dispatching), or take it from the v1.2.2 release.
--
-- What this does NOT cover, and only the Dell can: a client that refuses to
-- shrink (the `lastAsk` guard needs a live client with a real min_size);
-- whether a dispatch lands before or after a frame is painted (that is
-- Hyprland's `hl.dispatch` timing, not Lua); and the reserved values on the
-- real machine at the moment a window is born.

local configPath = "config/hypr/hyprland.lua"
local brokenPath = nil
for i = 1, #arg do
    if arg[i] == "--broken" then
        brokenPath = arg[i + 1]
    elseif arg[i]:sub(1, 2) ~= "--" then
        configPath = arg[i]
    end
end
if brokenPath then configPath = brokenPath end

-- ── Fake `hl` ───────────────────────────────────────────────────────────────
local handlers = {}
local dispatchLog = {}
local fakeWindows = {}

local function dspFn(kind)
    return function(t)
        t = t or {}
        if type(t) == "string" then return { _kind = kind, cmd = t } end
        t._kind = kind
        return t
    end
end

hl = {
    on = function(event, fn) handlers[event] = fn end,
    dispatch = function(d)
        if type(d) == "table" and d._kind then dispatchLog[#dispatchLog + 1] = d end
    end,
    get_windows = function() return fakeWindows end,
    get_monitors = function() return {} end,
    monitor = function() end,
    config = function() end,
    curve = function() end,
    animation = function() end,
    bind = function() end,
    layer_rule = function() end,
    define_submap = function() end,
    window_rule = function() end,
    exec_cmd = function() end,
    notify = function() end,
    notification = { create = function() end },
    dsp = {
        exec_cmd = dspFn("exec_cmd"),
        focus = dspFn("focus"),
        submap = dspFn("submap"),
        -- `t` is nil for the mouse-drag/resize binds (lines ~461-462), which
        -- call these with no arguments at load time. Anything not listed here
        -- (drag, pseudo, fullscreen, close, cycle_next, ...) stubs itself via
        -- the metatable, so a new keybind cannot break the load.
        window = setmetatable({
            resize = function(t) t = t or {} return { _kind = "resize", x = t.x, y = t.y, window = t.window } end,
            move = function(t) t = t or {} return { _kind = "move", x = t.x, y = t.y, window = t.window } end,
            float = function(t) t = t or {} return { _kind = "float", action = t.action, window = t.window } end,
        }, { __index = function(_, k) return function() return { _kind = k } end end }),
    },
}

dofile(configPath)
assert(handlers["window.open"], "window.open handler was not registered")
assert(handlers["window.update_rules"], "window.update_rules handler was not registered")

-- ── Harness ─────────────────────────────────────────────────────────────────
local MON = { x = 0, y = 0, width = 1920, height = 1080,
              reserved = { top = 0, bottom = 0, left = 0, right = 0 } }

local function mkwin(addr, x, y, w, h, extra)
    local win = {
        address = addr, floating = true, fullscreen = 0,
        at = { x = x, y = y }, size = { x = w, y = h },
        monitor = MON, workspace = { id = 1 },
    }
    if extra then for k, v in pairs(extra) do win[k] = v end end
    return win
end

local function fire(event, w)
    dispatchLog = {}
    handlers[event](w)
    return dispatchLog
end

local function ofKind(log, kind)
    local out = {}
    for _, d in ipairs(log) do
        if d._kind == kind then out[#out + 1] = d end
    end
    return out
end

local pass, fail = 0, 0
local function check(name, ok, detail)
    if ok then
        pass = pass + 1
        print("  ok — " .. name .. (detail and (" (" .. detail .. ")") or ""))
    else
        fail = fail + 1
        print("  FAIL — " .. name .. (detail and (" (" .. detail .. ")") or ""))
    end
end

local function show(log)
    local parts = {}
    for _, d in ipairs(log) do
        if d._kind == "resize" then
            parts[#parts + 1] = string.format("resize %dx%d", d.x, d.y)
        elseif d._kind == "move" then
            parts[#parts + 1] = string.format("move (%d,%d)", d.x, d.y)
        else
            parts[#parts + 1] = d._kind
        end
    end
    return table.concat(parts, ", ")
end

-- ── Scenarios ───────────────────────────────────────────────────────────────
-- 1. Oversized birth, empty workspace — Brave's shape.
fakeWindows = {}
local log = fire("window.open", mkwin("0xbrave", 10, 10, 1900, 1060))
local resizes, moves = ofKind(log, "resize"), ofKind(log, "move")
check("oversized birth: one resize to the 85% ceiling",
    #resizes == 1 and resizes[1].x == 1623 and resizes[1].y == 909, show(log))
check("oversized birth: exactly one move, to the clamped position",
    #moves == 1 and moves[1].x == 10 and moves[1].y == 10, show(log))
check("oversized birth: nothing else dispatched", #log == 2, show(log))

-- 2. Cascade birth — Settings born centred over Files. Pins the cascade
--    arithmetic: one move, straight to (548,288). (Same on old and new — the
--    clamp writes nothing here because the window already fits.)
fakeWindows = { mkwin("0xfiles", 520, 260, 880, 560) }
log = fire("window.open", mkwin("0xsettings", 410, 160, 1100, 760))
resizes, moves = ofKind(log, "resize"), ofKind(log, "move")
check("cascade birth: no resize (1100x760 fits the ceiling)",
    #resizes == 0, show(log))
check("cascade birth: exactly one move, straight to the cascaded position",
    #moves == 1 and moves[1].x == 548 and moves[1].y == 288, show(log))
check("cascade birth: nothing else dispatched", #log == 1, show(log))

-- 3. Oversized birth over an existing window — THE discriminating case. The
--    first browser sits clamped at (10,10) 1623x909; the second arrives
--    1900x1060 at (10,10) and would completely cover it, so the cascade steps
--    it to (38,38) (step 28, and 38+1623 <= 1915, 38+909 <= 1075, so it fits).
fakeWindows = { mkwin("0xbrave1", 10, 10, 1623, 909) }
log = fire("window.open", mkwin("0xbrave2", 10, 10, 1900, 1060))
resizes, moves = ofKind(log, "resize"), ofKind(log, "move")
check("oversized birth over a window: one resize to the 85% ceiling",
    #resizes == 1 and resizes[1].x == 1623 and resizes[1].y == 909, show(log))
check("oversized birth over a window: exactly one move, straight to the cascaded position",
    #moves == 1 and moves[1].x == 38 and moves[1].y == 38, show(log))
check("oversized birth over a window: nothing else dispatched", #log == 2, show(log))

-- 4. No-size birth — Hyprland's invented 640x400 becomes the 1100x700 default.
fakeWindows = {}
log = fire("window.open", mkwin("0xterm", 640, 340, 640, 400))
resizes, moves = ofKind(log, "resize"), ofKind(log, "move")
check("no-size birth: one resize to the 1100x700 default",
    #resizes == 1 and resizes[1].x == 1100 and resizes[1].y == 700, show(log))
check("no-size birth: exactly one move, shrunk in place",
    #moves == 1 and moves[1].x == 640 and moves[1].y == 340, show(log))

-- 5. update_rules never cascades, even over a window the birth would cover.
fakeWindows = { mkwin("0xfiles", 520, 260, 880, 560) }
log = fire("window.update_rules", mkwin("0xsettings", 410, 160, 1100, 760))
check("update_rules: a fitting window over Files is not moved at all",
    #log == 0, show(log))

-- 6. update_rules defends the top edge only.
fakeWindows = {}
log = fire("window.update_rules", mkwin("0xterm", 100, -20, 800, 600))
resizes, moves = ofKind(log, "resize"), ofKind(log, "move")
check("update_rules: window above the top edge is pulled back to it",
    #resizes == 0 and #moves == 1 and moves[1].x == 100 and moves[1].y == 5, show(log))

-- 7. Fullscreen birth is untouched.
fakeWindows = {}
log = fire("window.open", mkwin("0xvideo", 0, 0, 1920, 1080, { fullscreen = 1 }))
check("fullscreen birth: nothing dispatched", #log == 0, show(log))

print(string.format("birth-placement-probe: %d passed, %d failed (%s)",
    pass, fail, brokenPath and "broken control" or configPath))

if brokenPath then
    -- The control must FAIL: if the old config passes every assertion, the
    -- assertions are not reading the dispatch log.
    if fail == 0 then
        print("BROKEN CONTROL PASSED — the probe cannot tell old from new; do not trust a green run")
        os.exit(1)
    end
    print("broken control failed as expected — the probe can tell old from new")
    os.exit(0)
end
os.exit(fail == 0 and 0 or 1)
