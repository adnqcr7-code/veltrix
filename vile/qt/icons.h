// Minimal line icons for VILE, drawn with QPainter — no stock Qt icons.
//
// The stock StandardPixmap set (a document for "new tab", an "i" for the
// assistant, a checkmark for the shield) reads as a parts bin. These are one
// consistent set: 1.7 px strokes on a 24 px grid, round caps, drawn at 2x
// and downscaled. Colours are the caller's choice so the same drawing can
// be grey in a toolbar, green/amber for the Shield badge, or violet.
#pragma once

#include <QColor>
#include <QIcon>
#include <QPixmap>

namespace icons {

enum class Kind {
    Plus,         // new tab
    ChevronLeft,  // back
    ChevronRight, // forward
    ChevronUp,    // find previous
    ChevronDown,  // find next
    Globe,        // neutral site icon for IPs / hostless pages
    Download,     // downloads panel
    Pause,        // pause a download
    Play,         // resume a download
    Reload,
    Close, // stop loading / close
    Shield,
    Sparkle, // assistant / local AI
    Sliders, // settings
    Search,
    Grid,    // new tab page
    Palette, // appearance
    Clock,
    Star,   // bookmarks
};

// A letter (or two) drawn as an icon — the flat-letter vocabulary of
// the new-tab tiles, for list rows that name a site or a !bang.
QIcon letterIcon(const QString& letters, const QColor& color);

// Icon in `color`, with a muted `disabledColor` variant for QIcon::Disabled.
// The default colour is the ACTIVE palette's tab text (dark: the
// familiar #c9c9c9; light: a dark grey that survives a white button).
// An invalid colour means "use the palette"; explicit colours win.
QIcon icon(Kind kind, const QColor& color = QColor(),
           const QColor& disabledColor = QColor(QStringLiteral("#5c5c5c")));
QPixmap pixmap(Kind kind, const QColor& color, int size = 48);
// One frame of the loading spinner: a 270-degree arc at `angleDegrees`
// (screen angle, 0 = 3 o'clock, increasing clockwise), same stroke as the
// icons. The caller advances the angle on a timer.
QPixmap spinnerPixmap(int angleDegrees, const QColor& color, int size = 48);
// A five-pointed star for the bookmark button: filled when the page is
// bookmarked, an outline when it is not.
QPixmap bookmarkPixmap(bool filled, const QColor& color, int size = 48);

}  // namespace icons
