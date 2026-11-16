#include "ntppage.h"

#include <QFile>
#include <QTime>
#include <QUrl>

#include "vile/url.hpp"

QString NtpPage::html(const Inputs& in) {
    // Read off the palette itself, never passed separately (see
    // the Inputs comment in ntppage.h) — the palette carries its
    // own isLight flag, so no colour-value guessing is involved.
    const bool lightTheme = in.palette.isLight;
    // Split the default engine's template ("https://search.brave.com/search?q={q}")
    // into a form action + query parameter, so the search box submits
    // natively with no JavaScript bridge.
    QString tpl = in.searchTemplate;
    QString action = tpl, param = QStringLiteral("q");
    int qpos = tpl.indexOf(QStringLiteral("{q}"));
    if (qpos >= 0) {
        int qm = tpl.lastIndexOf('?', qpos);
        if (qm >= 0) {
            action = tpl.left(qm);
            QString before = tpl.mid(qm + 1, qpos - qm - 1);  // e.g. "q="
            param = before.left(before.indexOf('='));
            if (param.isEmpty()) param = QStringLiteral("q");
        }
    }
    // What the new tab page shows is a setting (Settings → New Tab), and it
    // wears the user's accent colour.
    const Accent accent = in.accent;
    bool showClock = in.showClock;
    bool showStats = in.showStats;

    QString clockHtml;
    if (showClock) {
        const int hour = QTime::currentTime().hour();
        const QString greet = hour < 5    ? tr("Up late?")
                              : hour < 12 ? tr("Good morning")
                              : hour < 18 ? tr("Good afternoon")
                              : hour < 23 ? tr("Good evening")
                                          : tr("Good night");
        clockHtml = QStringLiteral("<p id=\"greet\">%1</p><p id=\"clock\">--:--</p>"
                                   "<p id=\"date\"></p>")
                        .arg(greet);
    }

    // No bookmarks here any more: they live in the tab rail as
    // the colour-squares package (the user's call — bookmarks
    // belong with the tabs, not on the page). tilesHtml stays
    // empty; the slot in the layout simply renders nothing.
    QString tilesHtml;

    QString statsHtml;
    if (showStats) {
        // Trackers blocked so far this session (the assembler read
        // the count under the BlockLog's lock — it arrives as data).
        const size_t blocked = in.blocked;
        // Green means "something was blocked": with zero blocked the line
        // is muted, and with blocking off it is the amber warning.
        QString color = !in.blockTrackers
                            ? QStringLiteral("#d9a441")
                            : blocked > 0 ? QStringLiteral("#3fb68b")
                                          : QStringLiteral("#707070");
        QString text = in.blockTrackers
                           ? tr("%1 trackers blocked this session").arg(blocked)
                           : tr("Tracker blocking is off");
        statsHtml =
            QStringLiteral("<div class=\"stats\" style=\"color:%1\">%2</div>").arg(color, text);
    }

    // Brand mark from the compiled-in assets, inlined as a data URI (the
    // page is setHtml content, so it cannot reach qrc: URLs itself).
    QString logoHtml;
    {
        QFile logoFile(QStringLiteral(":/assets/logo-v.png"));
        if (logoFile.open(QIODevice::ReadOnly))
            logoHtml = QStringLiteral("<img class=\"logo\" src=\"data:image/png;base64,%1\">")
                           .arg(QString::fromLatin1(logoFile.readAll().toBase64()));
    }
    // A whisper of the accent colour in the top-right corner, echoing the
    // brand artwork without shipping a 470 KB background to every tab.
    QString glow = QStringLiteral("rgba(0,0,0,0)");
    {
        bool ok = false;
        const uint rgb = accent.focus.mid(1).toUInt(&ok, 16);
        if (ok)
            glow = QStringLiteral("rgba(%1,%2,%3,0.14)")
                       .arg((rgb >> 16) & 0xff)
                       .arg((rgb >> 8) & 0xff)
                       .arg(rgb & 0xff);
    }
    // %1 action, %2 param, %3 logo, %4 clock, %5 tiles, %6 stats,
    // %7/%8/%9 accent primary/light/focus. The clock script is appended
    // AFTER the substitution: it contains "%12", which .arg() would eat.
    QString html = QStringLiteral(
                       "<!doctype html><html><head><meta charset=\"utf-8\">"
                       "<title>New Tab</title><style>"
                       "body{background:radial-gradient(640px 420px at 88% -40px,__GLOW__,rgba(0,0,0,0) 70%),__PAGEBG__;"
                       "color:__TEXT__;font-family:sans-serif;margin:0;"
                       "display:flex;min-height:100vh;align-items:flex-start;justify-content:center;}"
                       ".box{width:min(720px,92vw);text-align:center;padding:28px 0 32px;}"
                       ".logo{height:56px;margin-bottom:14px;"
                       // The mark's baked-in near-black background blends into
                       // the page instead of sitting on it as a pasted square.
                       "mix-blend-mode:screen;}"
                       "#greet{font-size:15px;color:__SECONDARY__;margin:0 0 2px;}"
                       "#clock{font-size:38px;font-weight:600;letter-spacing:-0.5px;margin:0;}"
                       "#date{font-size:14px;color:__SECONDARY__;margin:4px 0 20px;}"
                       "form{display:flex;gap:8px;}"
                       "input{flex:1;background:__INPUTBG__;color:__TEXT__;border:1px solid __INPUTBORDER__;"
                       "border-radius:10px;padding:13px 16px;font-size:15px;outline:none;}"
                       "input:focus{border-color:%9;}"
                       
                       // No scrollbar rules here: the engine's
                       // injected style (qt_engine.cpp) owns every
                       // page's scrollbar with palette colours, and
                       // its DOMContentLoaded append won the cascade
                       // over the rule this page used to carry.
                       ".stats{margin-top:24px;font-size:12px;}"
                       "</style></head><body><div class=\"box\">"
                       "%3"
                       "%4"
                       "<form action=\"%1\" method=\"get\">"
                       "<input type=\"text\" name=\"%2\" autofocus placeholder=\"Search or enter an address\" "
                       "autocomplete=\"off\"></form>"
                       "%5"
                       "%6"
                       "</div>")
                       .arg(action, param, logoHtml, clockHtml, tilesHtml, statsHtml,
                            accent.primary, accent.light, accent.focus);
    html.replace(QStringLiteral("__GLOW__"), glow);
    {
        // Every colour slot resolves from the caller's Palette —
        // the same struct the app stylesheet is built from, so the
        // page can never disagree with the chrome around it. (This
        // block replaces a hand-maintained dark->light string-swap
        // table that duplicated the light palette as literals:
        // round 13, finding T3.) Two roles genuinely invert between
        // themes and say so: the input well is the DEEPEST surface
        // on dark and the brightest card on light; tiles invert too.
        const Palette& p = in.palette;
        html.replace(QStringLiteral("__PAGEBG__"), p.bg);
        html.replace(QStringLiteral("__TEXT__"), p.text);
        html.replace(QStringLiteral("__SECONDARY__"), p.secondary);
        html.replace(QStringLiteral("__INPUTBG__"),
                     lightTheme ? p.surface : p.bgDeep);
        html.replace(QStringLiteral("__INPUTBORDER__"), p.borderStrong);
        html.replace(QStringLiteral("__TILEBG__"),
                     lightTheme ? p.surface : p.well);
        html.replace(QStringLiteral("__TILEBORDER__"), p.cardBorder);
        html.replace(QStringLiteral("__RAISED__"), p.raised);
        html.replace(QStringLiteral("__TILENAME__"), p.tabText);
        html.replace(QStringLiteral("__FAINT__"), p.faint);
        // The hero mark blends by screen on dark (its dark fringes
        // vanish); on light, multiply is the mirror trick.
        if (lightTheme)
            html.replace(QStringLiteral("mix-blend-mode:screen;"),
                         QStringLiteral("mix-blend-mode:multiply;"));
    }
    if (showClock)
        html += QStringLiteral(
            "<script>"
            "function tick(){var d=new Date();var h=d.getHours()%12||12;"
            "var m=('0'+d.getMinutes()).slice(-2);"
            "var ap=d.getHours()<12?'AM':'PM';"
            "document.getElementById('clock').textContent=h+':'+m+' '+ap;"
            "var days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];"
            "var months=['January','February','March','April','May','June','July','August',"
            "'September','October','November','December'];"
            "document.getElementById('date').textContent=days[d.getDay()]+', '+"
            "months[d.getMonth()]+' '+d.getDate();}"
            "tick();setInterval(tick,1000);"
            "</script>");
    html += QStringLiteral("</body></html>");
    return html;
}
