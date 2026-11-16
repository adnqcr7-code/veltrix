# 2026-09-14 — ai.json and gaming.json → GSettings `org.veltrix.ai` (#573)
#
# The second pair of stores to move, later than the first six because other
# programs read these files directly: bin/veltrix-agent, bin/veltrix-mcp and the
# four computer-use helpers read ai.json's gates, and config/hypr/hyprland.lua read
# gaming.json with pattern matches. They read GSettings (and, for the compositor,
# the VELTRIX_GAMING table the shell writes) in the same change that ships this.
#
# A separate unit, not two more lines in 2026-09-14-settings-to-gsettings: that one
# has already run on machines that will never run it again.
#
# VELTRIX fork (Phase 0): the gaming half is DELETED — Game Mode is gone and
# org.veltrix.gaming no longer exists, so importing gaming.json would fail the
# whole unit forever (settings_import returns 1 when its schema is missing and
# the runner retries next session). A legacy gaming.json is left in place,
# unread, by design: nothing reads it any more. Only ai.json is imported.
# (The ai half still imports the gates; a per-provider model entry in
# brain-models is imported as inert data — the provider table no longer has
# it, so it is never used.)

settings_import ai.json     ai     || return 1
