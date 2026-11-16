#pragma once
// The new-tab page, built where it belongs: outside the window. The
// window assembles the Inputs (its search engine, accent and toggles
// from settings, the session's blocked count under the log lock, and
// the most-visited entries from the history store) and the builder
// renders the HTML — logo inlined, live clock by script, native form
// submission for the search box (no JS bridge).

#include <QObject>
#include <QString>

#include <functional>
#include <vector>

#include "theme.h"
#include "vile/storage.hpp"

class NtpPage : public QObject {
    Q_OBJECT
public:
    struct Inputs {
        QString searchTemplate;  // the engine's "...?q={q}" template
        Accent accent;
        bool showClock = true;
        // Gates the bookmarks box (the Settings toggle kept its
        // stored key when the quick-tiles grid it used to gate was
        // removed — the box is what the page shows now).
        bool showTiles = true;
        bool showStats = true;
        std::size_t blocked = 0;
        // The SAME palette the app stylesheet resolves from — the
        // page's colours are read out of it, never a second literal
        // table (round 13, finding T3: the light values used to be
        // duplicated here as string swaps and would quietly drift).
        // There is deliberately no separate lightTheme flag: round
        // 14's architect noted a caller could pass a palette and a
        // flag that disagree, so html() reads the palette's own
        // isLight member.
        Palette palette = darkPalette();
        bool blockTrackers = true;
        // The user's saved bookmarks: the page renders them as a
        // box of site logos; clicking one opens the page.
        std::vector<vile::Bookmark> bookmarks;
        // Site logo for a host as a file:// URL, "" when none is
        // stored — tiles fall back to their letter.
        std::function<QString(const QString&)> faviconUrl;
    };

    static QString html(const Inputs& in);
};
