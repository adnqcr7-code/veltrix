// Minimal line icons, drawn with QPainter on a 24x24 grid and rendered
// at 2x (48 px) so they stay crisp when scaled down to 16-20 px.
#include "icons.h"

#include "theme.h"

#include <QPainter>
#include <QPainterPath>
#include <QtMath>

namespace icons {

namespace {

// All drawings live in a 24x24 box; the pen is 1.7 px in that space.
constexpr qreal kPen = 1.7;
constexpr QRectF kBox(5.0, 5.0, 14.0, 14.0);

QPointF polar(const QPointF& c, qreal r, qreal degrees) {
    const qreal a = qDegreesToRadians(degrees);
    return QPointF(c.x() + r * qCos(a), c.y() + r * qSin(a));
}

// Five-pointed star: outer radius 8, inner radius 3.4, first point up.
QPainterPath starPath() {
    QPainterPath star;
    for (int i = 0; i < 10; ++i) {
        double r = (i % 2 == 0) ? 8.0 : 3.4;
        QPointF pt = polar(QPointF(12.0, 12.0), r, -90.0 + i * 36.0);
        if (i == 0) star.moveTo(pt);
        else star.lineTo(pt);
    }
    star.closeSubpath();
    return star;
}

void draw(Kind kind, QPainter& p, const QColor& color) {
    p.setRenderHint(QPainter::Antialiasing, true);
    p.setPen(QPen(color, kPen, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
    p.setBrush(Qt::NoBrush);
    const QPointF c(12.0, 12.0);
    switch (kind) {
    case Kind::Plus:
        p.drawLine(QPointF(12, 6), QPointF(12, 18));
        p.drawLine(QPointF(6, 12), QPointF(18, 12));
        break;
    case Kind::ChevronLeft:
        p.drawLine(QPointF(14.5, 6), QPointF(9, 12));
        p.drawLine(QPointF(9, 12), QPointF(14.5, 18));
        break;
    case Kind::ChevronRight:
        p.drawLine(QPointF(9.5, 6), QPointF(15, 12));
        p.drawLine(QPointF(15, 12), QPointF(9.5, 18));
        break;
    case Kind::ChevronUp:
        p.drawLine(QPointF(6, 14.5), QPointF(12, 9));
        p.drawLine(QPointF(12, 9), QPointF(18, 14.5));
        break;
    case Kind::ChevronDown:
        p.drawLine(QPointF(6, 9.5), QPointF(12, 15));
        p.drawLine(QPointF(12, 15), QPointF(18, 9.5));
        break;
    case Kind::Globe:
        p.drawEllipse(QRectF(5, 5, 14, 14));
        p.drawEllipse(QRectF(9.25, 5, 5.5, 14));
        p.drawLine(QPointF(5, 12), QPointF(19, 12));
        break;
    case Kind::Download:
        // Arrow down into a tray.
        p.drawLine(QPointF(12, 5), QPointF(12, 15));
        p.drawLine(QPointF(8, 11), QPointF(12, 15));
        p.drawLine(QPointF(16, 11), QPointF(12, 15));
        p.drawLine(QPointF(5, 19), QPointF(19, 19));
        break;
    case Kind::Pause:
        p.drawLine(QPointF(9, 6), QPointF(9, 18));
        p.drawLine(QPointF(15, 6), QPointF(15, 18));
        break;
    case Kind::Play: {
        QPainterPath tri;
        tri.moveTo(QPointF(9, 6));
        tri.lineTo(QPointF(17, 12));
        tri.lineTo(QPointF(9, 18));
        tri.closeSubpath();
        p.drawPath(tri);
        break;
    }
    case Kind::Reload: {
        // Almost-full circle sweeping clockwise, arrowhead at the TOP
        // (a reload glyph; an arrowhead at the side reads as a power
        // symbol). Angles are screen angles (y down): 0 deg = 3 o'clock,
        // increasing clockwise. The arc ends at -80 deg (just right of
        // top), so it starts at 210 deg and sweeps -290 deg.
        QPainterPath arc;
        arc.moveTo(polar(c, 7.0, 210.0));
        arc.arcTo(kBox, 210.0, -290.0);
        p.drawPath(arc);
        // Arrowhead at the arc's end (-80 deg), pointing along the
        // clockwise tangent.
        const QPointF tip = polar(c, 7.0, -80.0);
        const QPointF dir = polar(QPointF(0, 0), 1.0, -80.0 + 90.0);
        const QPointF side = polar(QPointF(0, 0), 1.0, -80.0);
        const QPointF a = tip - dir * 3.4 + side * 1.6;
        const QPointF b = tip - dir * 3.4 - side * 1.6;
        p.setBrush(color);
        p.setPen(Qt::NoPen);
        p.drawPolygon(QPolygonF() << tip << a << b);
        break;
    }
    case Kind::Close:
        p.drawLine(QPointF(7, 7), QPointF(17, 17));
        p.drawLine(QPointF(17, 7), QPointF(7, 17));
        break;
    case Kind::Shield: {
        QPainterPath path;
        path.moveTo(12.0, 3.5);
        path.lineTo(19.0, 6.0);
        path.lineTo(19.0, 11.5);
        path.cubicTo(19.0, 16.5, 16.0, 19.8, 12.0, 21.0);
        path.cubicTo(8.0, 19.8, 5.0, 16.5, 5.0, 11.5);
        path.lineTo(5.0, 6.0);
        path.closeSubpath();
        p.drawPath(path);
        break;
    }
    case Kind::Sparkle: {
        // Speech bubble (the page assistant talks about the page) — a
        // functional line drawing like the rest of the set, not a sparkle.
        p.drawRoundedRect(QRectF(4, 4, 16, 13), 3, 3);
        QPainterPath tail;
        tail.moveTo(QPointF(8, 17));
        tail.lineTo(QPointF(8, 21));
        tail.lineTo(QPointF(13, 17));
        p.drawPath(tail);
        p.drawLine(QPointF(8, 9), QPointF(16, 9));
        p.drawLine(QPointF(8, 13), QPointF(13, 13));
        break;
    }
    case Kind::Sliders: {
        const qreal ys[3] = {6.5, 12.0, 17.5};
        const qreal xs[3] = {15.0, 9.0, 14.0};
        for (int i = 0; i < 3; ++i) {
            p.drawLine(QPointF(5, ys[i]), QPointF(19, ys[i]));
            p.setBrush(color);
            p.setPen(Qt::NoPen);
            p.drawEllipse(QPointF(xs[i], ys[i]), 2.0, 2.0);
            p.setBrush(Qt::NoBrush);
            p.setPen(QPen(color, kPen, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        }
        break;
    }
    case Kind::Search:
        p.drawEllipse(QPointF(11, 11), 6.0, 6.0);
        p.drawLine(QPointF(15.5, 15.5), QPointF(19.5, 19.5));
        break;
    case Kind::Grid:
        for (qreal x : {5.0, 12.5})
            for (qreal y : {5.0, 12.5})
                p.drawRoundedRect(QRectF(x, y, 6.5, 6.5), 1.5, 1.5);
        break;
    case Kind::Palette:
        p.drawEllipse(c, 7.5, 7.5);
        p.setBrush(color);
        p.setPen(Qt::NoPen);
        for (const QPointF& d : {QPointF(9.3, 10.0), QPointF(14.7, 10.0),
                                 QPointF(12.0, 14.8)})
            p.drawEllipse(d, 1.3, 1.3);
        break;
    case Kind::Clock:
        p.drawEllipse(c, 7.5, 7.5);
        p.drawLine(QPointF(12, 12), QPointF(12, 7.5));
        p.drawLine(QPointF(12, 12), QPointF(15.5, 13.5));
        break;
    case Kind::Star:
        p.drawPath(starPath());
        break;
    }
}

}  // namespace

QPixmap pixmap(Kind kind, const QColor& color, int size) {
    QPixmap pm(size, size);
    pm.fill(Qt::transparent);
    QPainter p(&pm);
    // Map the 24x24 drawing space onto the pixmap.
    p.scale(size / 24.0, size / 24.0);
    draw(kind, p, color);
    return pm;
}

QPixmap spinnerPixmap(int angleDegrees, const QColor& color, int size) {
    QPixmap pm(size, size);
    pm.fill(Qt::transparent);
    QPainter p(&pm);
    p.scale(size / 24.0, size / 24.0);
    p.setRenderHint(QPainter::Antialiasing, true);
    p.setPen(QPen(color, kPen, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
    p.setBrush(Qt::NoBrush);
    QPainterPath arc;
    arc.moveTo(polar(QPointF(12.0, 12.0), 7.0, angleDegrees));
    arc.arcTo(kBox, -static_cast<qreal>(angleDegrees), -270.0);
    p.drawPath(arc);
    return pm;
}

QPixmap bookmarkPixmap(bool filled, const QColor& color, int size) {
    QPixmap pm(size, size);
    pm.fill(Qt::transparent);
    QPainter p(&pm);
    p.scale(size / 24.0, size / 24.0);
    p.setRenderHint(QPainter::Antialiasing, true);
    if (filled) {
        p.setPen(Qt::NoPen);
        p.setBrush(color);
    } else {
        p.setPen(QPen(color, kPen, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        p.setBrush(Qt::NoBrush);
    }
    p.drawPath(starPath());
    return pm;
}

QIcon letterIcon(const QString& letters, const QColor& color) {
    const int size = 36;  // 2x the 18px slot, downscaled by Qt
    QPixmap pm(size, size);
    pm.fill(Qt::transparent);
    QPainter p(&pm);
    p.setRenderHint(QPainter::Antialiasing, true);
    p.setRenderHint(QPainter::TextAntialiasing, true);
    QFont font = p.font();
    font.setBold(true);
    font.setPixelSize(letters.size() > 1 ? 17 : 22);
    p.setFont(font);
    p.setPen(color);
    p.drawText(pm.rect(), Qt::AlignCenter, letters);
    return QIcon(pm);
}

QIcon icon(Kind kind, const QColor& color, const QColor& disabledColor) {
    const QColor resolved =
        color.isValid() ? color : QColor(activePalette().tabText);
    QIcon ic;
    ic.addPixmap(pixmap(kind, resolved), QIcon::Normal, QIcon::On);
    ic.addPixmap(pixmap(kind, resolved), QIcon::Normal, QIcon::Off);
    ic.addPixmap(pixmap(kind, disabledColor), QIcon::Disabled, QIcon::On);
    ic.addPixmap(pixmap(kind, disabledColor), QIcon::Disabled, QIcon::Off);
    return ic;
}

}  // namespace icons
