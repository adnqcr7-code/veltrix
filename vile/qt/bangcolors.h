#pragma once
// The !bang letter colours — ONE table. Round 13's architect found
// three copies (new-tab tiles, sidebar favorites, suggestions popup)
// that had already drifted apart: the popup used #e5534b / #d98c41 /
// #6c9bd2 where both tile tables used #ff0000 / #f48024 / #4285f4.
// Brand-coloured bangs keep their site's colour in both themes; the
// neutral bangs (w, gh, mdn) take the themed neutral.
#include <QString>
#include <string>

inline QString bangNeutral(bool lightTheme) {
    // Near-white letters on dark, near-black on light.
    return lightTheme ? QStringLiteral("#26262b") : QStringLiteral("#ededed");
}

inline QString bangColor(const std::string& name, bool lightTheme) {
    if (name == "yt") return QStringLiteral("#ff0000");
    if (name == "so") return QStringLiteral("#f48024");
    if (name == "r") return QStringLiteral("#ff4500");
    if (name == "g") return QStringLiteral("#4285f4");
    return bangNeutral(lightTheme);
}

inline QString bangColor(const QString& name, bool lightTheme) {
    return bangColor(name.toStdString(), lightTheme);
}
