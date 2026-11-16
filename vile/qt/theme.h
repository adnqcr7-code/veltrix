#pragma once
// VILE's visual system: semantic color roles, not a long palette. There
// is ONE accent — the brand violet from the logo — and TWO palettes,
// dark and light, chosen in Settings → Appearance. (The earlier
// green/blue/neutral accent presets went away on the user's call,
// 2026-11-12: they changed a few buttons and nothing else. A real
// light theme changes everything, so that's where the effort goes.)
// Semantic constants hold across palettes: green means protected,
// amber means a protection is off, red is destructive.
#include <QString>
#include <vector>

struct Accent {
    QString id;       // stored in QSettings under ui/accent
    QString name;     // shown in Settings
    QString primary;  // primary buttons, selection, progress
    QString light;    // primary button border
    QString focus;    // focus rings, active-tab dot
    QString hover;    // primary button hover
};

const std::vector<Accent>& accents();
Accent accentById(const QString& id);  // unknown id falls back to violet

// Every surface colour the stylesheet needs, by role. The dark
// palette is the original obsidian system; the light palette mirrors
// it role for role (same relationships, inverted luminance).
struct Palette {
    QString bg, bgDeep, chrome, surface, well, tabList;
    QString button, btnHover, railHover, pressed, raised, track, vertItem;
    QString bookmarkWash;  // the open bookmarks' light background tint
    QString option, optionSelected;
    QString border, cardBorder, borderStrong, hoverBorder, indicator;
    QString scroll, scrollHover, scrollBg;
    QString text, bright, buttonText, tabText, secondary, muted, faint;
    QString disabled, groupText, accentText;
    QString selected, selectedSoft;
    QString dangerBg, dangerBorder, dangerText;
    QString dangerBgHover, dangerBorderHover, dangerTextHover;
    // Which side of the dark/light pair this is — carried IN the
    // palette so consumers never have to guess it back from a
    // colour value (round 15 derived it from bg equality; round
    // 16's code review named the latent trap: a future palette
    // sharing a bg would inherit the wrong answer).
    bool isLight = false;
};

const Palette& darkPalette();
const Palette& lightPalette();
// "dark" (default) or "light"; unknown ids fall back to dark.
const Palette& paletteById(const QString& id);
// The palette for the user's saved theme choice (qt/uisettings).
const Palette& activePalette();

QString appStyleSheet(const Accent& accent, const Palette& palette);
