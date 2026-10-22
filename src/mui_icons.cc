#include "mui_icons.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <tuple>
#include <vector>

namespace fallout {

namespace {

    // The icons, SVG on a 24 unit square as the design board draws them: a
    // subset - path (all commands), circle, rect (rx), g with translate /
    // scale / rotate; class "f" is filled, the rest stroked with round caps
    // and joins. In `MuiIcon` order.
    const char* const kIconSvg[] = {
        // Menu
        "<path d=\"M4 6.5h16M4 12h16M4 17.5h16\"/>",
        // QuickSave
        "<path d=\"M4 5h12l4 4v10.5H4zM8 19.5v-5h8v5M12 2.5v8M9 7.5l3 3 3-3\"/>",
        // QuickLoad
        "<path d=\"M4 5h12l4 4v10.5H4zM8 19.5v-5h8v5M12 11V3M9 6l3-3 3 3\"/>",
        // Inventory
        "<path d=\"M9 6.5V5.2a3 3 0 0 1 6 0v1.3M5.5 6.5h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2zM3.5 12h17M9.5 12v3h5v-3\"/>",
        // Character
        "<circle cx=\"12\" cy=\"7.5\" r=\"3.5\"/><path d=\"M4.5 20.5a7.5 7.5 0 0 1 15 0z\"/>",
        // Pipboy
        "<rect x=\"1.84\" y=\"5.38\" width=\"20.31\" height=\"13.25\" rx=\"1.77\"/><rect x=\"4.49\" y=\"8.03\" width=\"10.16\" height=\"7.95\" rx=\"0.88\"/><circle cx=\"18.62\" cy=\"10.68\" r=\"1.32\"/><path d=\"M17.74 15.53H19.51M6.26 5.38V1.84M6.26 18.62V22.16M12.88 5.38V1.84M12.88 18.62V22.16\"/>",
        // Map
        "<path d=\"M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2zM9 4.5v13M15 6.5v13\"/>",
        // Skills
        "<path d=\"M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5zM12 6.5v13M6 8.6c1.5-.2 2.8 0 4 .6M6 11.6c1.5-.2 2.8 0 4 .6M14 9.2c1.2-.6 2.5-.8 4-.6M14 12.2c1.2-.6 2.5-.8 4-.6\"/>",
        // Highlight
        "<path d=\"M9.5 17.5h5M10.5 20.5h3M12 3.5a6 6 0 0 1 3.5 10.9V16h-7v-1.6A6 6 0 0 1 12 3.5z\"/>",
        // Sneak
        "<path d=\"M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6zM4 20 20 4\"/><circle cx=\"12\" cy=\"12\" r=\"2.5\"/>",
        // Log
        "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"14\" rx=\"2.5\"/><path d=\"M7 9.5l3 2.5-3 2.5M12 15h5\"/>",
        // EndTurn
        "<path d=\"M5.5 5v14l10-7zM18.5 5v14\"/>",
        // EndCombat
        "<path d=\"M6 21V3.5M6 4h12l-3 4.5 3 4.5H6\"/>",
        // ActionPoints
        "<path class=\"f\" d=\"M13.5 2 5 13.5h6L9.8 22 19 10h-6z\"/>",
        // HitPoints
        "<path class=\"f\" d=\"M12 20.5s-8-4.8-8-10.7A4.5 4.5 0 0 1 12 6.6a4.5 4.5 0 0 1 8 3.2c0 5.9-8 10.7-8 10.7z\"/>",
        // Aim
        "<path d=\"M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5\"/><circle cx=\"12\" cy=\"12\" r=\"6.5\"/><circle class=\"f\" cx=\"12\" cy=\"12\" r=\"1.2\"/>",
        // Reload
        "<path d=\"M19.5 9A8 8 0 0 0 5 7.5M4.5 15A8 8 0 0 0 19 16.5M5 3.5v4h4M19 20.5v-4h-4\"/>",
        // Fist
        "<path d=\"M3.36 8.64A2.16 2.16 0 0 1 7.68 8.64V12.48M7.68 8.64A2.16 2.16 0 0 1 12.00 8.64V12.48M12.00 8.64A2.16 2.16 0 0 1 16.32 8.64V12.48M16.32 8.64A2.16 2.16 0 0 1 20.64 8.64V16.80M3.36 8.64L3.36 17.76L7.20 22.56L17.76 22.56L20.64 17.76L20.64 16.80M3.36 13.92L13.92 13.92L15.84 16.80\"/>",
        // Kick
        "<path d=\"M6.5 3h6v8.5l5.3 2.1c1.6.6 2.7 2.2 2.7 3.9V19h-14zM6.5 19h14v1.5h-14zM9.5 7h3M9.5 9.5h3\"/>",
        // Weight
        "<path d=\"M12 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6.5 8.5h11l3 12h-17z\"/>",
        // Back
        "<path d=\"M20 12H4.5M10.5 5.5 4 12l6.5 6.5\"/>",
        // PartyOrders
        "<circle cx=\"9\" cy=\"8\" r=\"3\"/><path d=\"M3 19.5a6 6 0 0 1 12 0zM16 12.6c3 .3 5 2.5 5 5.5h-3.5\"/><circle cx=\"16.5\" cy=\"7\" r=\"2.4\"/>",
        // Holster
        "<g transform=\"translate(1.5 -1.5) scale(.75)\"><path d=\"M2.5 7.5h15.5l1-1.5h2v5h-8l-1.2 2.2h-2.6L7.6 19.5H4.2l1.7-8H2.5z\"/></g><path d=\"M18 14v7M15.5 18.5 18 21l2.5-2.5\"/>",
        // Regroup
        "<path d=\"M12 3v6M9.5 6.5 12 9l2.5-2.5M12 21v-6M9.5 17.5 12 15l2.5 2.5M3 12h6M6.5 9.5 9 12l-2.5 2.5M21 12h-6M17.5 9.5 15 12l2.5 2.5\"/>",
        // Spread
        "<path d=\"M12 9V3M9.5 5.5 12 3l2.5 2.5M12 15v6M9.5 18.5 12 21l2.5-2.5M9 12H3M5.5 9.5 3 12l2.5 2.5M15 12h6M18.5 9.5 21 12l-2.5 2.5\"/>",
        // Burst
        "<g transform=\"translate(-6 0)\"><path d=\"M9.5 21h5M10 21v-9h4v9M10 12c0-3.2.9-6 2-7.5 1.1 1.5 2 4.3 2 7.5\"/></g><g transform=\"translate(0 0)\"><path d=\"M9.5 21h5M10 21v-9h4v9M10 12c0-3.2.9-6 2-7.5 1.1 1.5 2 4.3 2 7.5\"/></g><g transform=\"translate(6 0)\"><path d=\"M9.5 21h5M10 21v-9h4v9M10 12c0-3.2.9-6 2-7.5 1.1 1.5 2 4.3 2 7.5\"/></g>",
        // AutoLoot
        "<path d=\"M5 3.5v8.5a7 7 0 0 0 14 0V3.5h-4V12a3 3 0 0 1-6 0V3.5zM5 7.5h4M15 7.5h4\"/>",
        // Lockpick
        "<rect x=\"5\" y=\"11\" width=\"14\" height=\"9.5\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 7.8-1.2M12 14.5v2.5\"/>",
        // Steal
        "<path d=\"M2.5 10c2.6-1.6 6-1.8 9.5-.6 3.5-1.2 6.9-1 9.5.6 0 3.6-1.9 6-4.6 6-1.9 0-3.4-1.1-4.9-2.6-1.5 1.5-3 2.6-4.9 2.6-2.7 0-4.6-2.4-4.6-6zM5.5 12.2c.8-.9 2.4-1 3.3 0M15.2 12.2c.8-.9 2.4-1 3.3 0\"/>",
        // Traps
        "<path d=\"M2.5 20h19M4.5 20v-2.6c0-1 1-1.9 2.3-1.9h10.4c1.3 0 2.3.9 2.3 1.9V20M10 15.5v-2.3h4v2.3M8.5 11.2h7\"/>",
        // Doctor
        "<rect x=\"3.5\" y=\"7.5\" width=\"17\" height=\"12.5\" rx=\"2.5\"/><path d=\"M9 7.5V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5M12 10.5v6M9 13.5h6\"/>",
        // Science
        "<path d=\"M7 7h10v10H7zM10 10h4v4h-4zM10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3\"/>",
        // Repair
        "<path d=\"M14.93 7.16L17.75 4.34A4.6 4.6 0 0 0 11.49 10.46L4.70 17.25A1.45 1.45 0 0 0 6.75 19.30L13.54 12.51A4.6 4.6 0 0 0 19.66 6.25L16.84 9.07z\"/>",
        // Target
        "<path d=\"M3.5 8V3.5H8M16 3.5h4.5V8M20.5 16v4.5H16M8 20.5H3.5V16\"/><circle cx=\"12\" cy=\"12\" r=\"3.5\"/>",
        // Talk
        "<path d=\"M6 4.5h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-5 4.5v-4.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z\"/>",
        // Barter
        "<path d=\"M4 8h15M15.5 4.5 19 8l-3.5 3.5M20 16H5M8.5 12.5 5 16l3.5 3.5\"/>",
        // Review
        "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3 2\"/>",
        // FilterAll
        "<path d=\"M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z\"/>",
        // FilterWeapons
        "<path d=\"M2.5 7.5h15.5l1-1.5h2v5h-8l-1.2 2.2h-2.6L7.6 19.5H4.2l1.7-8H2.5zM9.3 11.5v2.2h2.4\"/>",
        // FilterWeaponsAndAmmo
        "<g transform=\"translate(.2 4.3) scale(.62)\"><path d=\"M2.5 7.5h15.5l1-1.5h2v5h-8l-1.2 2.2h-2.6L7.6 19.5H4.2l1.7-8H2.5z\"/></g><g transform=\"translate(8.6 2.05) scale(.78)\"><path d=\"M9.5 21h5M10 21v-9h4v9M10 12c0-3.2.9-6 2-7.5 1.1 1.5 2 4.3 2 7.5\"/></g>",
        // FilterArmor
        "<path d=\"M7 4h3l2 2 2-2h3l3 3-1.5 3.5V20H5.5V10.5L4 7zM7.5 12h9M7.5 15.5h9\"/>",
        // Stimpak
        "<g transform=\"rotate(-45 12 12)\"><path d=\"M6 10h9v4H6zM15 12h3.5M18.5 9.5v5M6 12H2.5M9 10v1.4M11.5 10v1.4\"/></g>",
        // FilterAmmo
        "<g transform=\"translate(-6 0)\"><path d=\"M9.5 21h5M10 21v-9h4v9M10 12c0-3.2.9-6 2-7.5 1.1 1.5 2 4.3 2 7.5\"/></g><g transform=\"translate(0 0)\"><path d=\"M9.5 21h5M10 21v-9h4v9M10 12c0-3.2.9-6 2-7.5 1.1 1.5 2 4.3 2 7.5\"/></g><g transform=\"translate(6 0)\"><path d=\"M9.5 21h5M10 21v-9h4v9M10 12c0-3.2.9-6 2-7.5 1.1 1.5 2 4.3 2 7.5\"/></g>",
        // FilterMisc
        "<path d=\"M12 2.8 20.5 7v10L12 21.2 3.5 17V7zM3.5 7 12 11.2 20.5 7M12 11.2v10\"/>",
        // Cancel
        "<path d=\"M5.5 5.5l13 13M18.5 5.5l-13 13\"/>",
        // Drop
        "<path d=\"M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 20h15\"/>",
        // Look
        "<path d=\"M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z\"/><circle cx=\"12\" cy=\"12\" r=\"2.8\"/>",
        // Rotate
        "<circle cx=\"11.5\" cy=\"4.8\" r=\"2.2\"/><path d=\"M7.5 13a4 4 0 0 1 8 0M4.25 15.96 L3.78 16.51 L3.54 17.08 L3.52 17.66 L3.75 18.24 L4.19 18.78 L4.86 19.29 L5.71 19.75 L6.74 20.13 L7.90 20.44 L9.17 20.65 L10.51 20.77 L11.88 20.80 L13.23 20.72 L14.54 20.55 L15.75 20.28 L16.85 19.93 L17.78 19.51 L18.53 19.02 L19.08 18.49 L19.40 17.92 L19.50 17.34 L19.36 16.76 L18.99 16.21 L18.40 15.68 L17.61 15.21 L16.64 14.80M20.03 13.63L16.64 14.80L18.53 17.85\"/>",
        // Use
        "<path d=\"M8 13V6.2a1.5 1.5 0 0 1 3 0V11.5M11 11V4.7a1.5 1.5 0 0 1 3 0V11M14 11V5.7a1.5 1.5 0 0 1 3 0V11.5M17 11.5V8.7a1.5 1.5 0 0 1 3 0v5.8c0 4-2.8 7-6.6 7-2.5 0-4-1.2-5.2-3L5 14.6c-.8-1.2.7-2.6 1.8-1.7L8 14\"/>",
        // Unload
        "<g transform=\"translate(-4 1)\"><path d=\"M9.5 21h5M10 21v-9h4v9M10 12c0-3.2.9-6 2-7.5 1.1 1.5 2 4.3 2 7.5\"/></g><path d=\"M16.5 20V9M13.5 12l3-3 3 3\"/>",
        // Push
        "<path d=\"M3.5 12h11M10.5 7.5 15 12l-4.5 4.5M19.5 4.5v15\"/>",
        // Plus
        "<path d=\"M12 5v14M5 12h14\"/>",
        // Minus
        "<path d=\"M5 12h14\"/>",
        // Edit
        "<path d=\"M15.5 4.5l4 4L9 19H5v-4zM13 7l4 4\"/>",
        // Play
        "<path class=\"f\" d=\"M7 4.5v15l12.5-7.5z\"/>",
        // Pause
        "<path class=\"f\" d=\"M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z\"/>",
        // Stop
        "<path class=\"f\" d=\"M5.5 5.5h13v13h-13z\"/>",
        // Expand
        "<path d=\"M3.5 9V3.5H9M15 3.5h5.5V9M20.5 15v5.5H15M9 20.5H3.5V15\"/>",
        // Collapse
        "<path d=\"M9 3.5V9H3.5M15 3.5V9h5.5M20.5 15H15v5.5M3.5 15H9v5.5\"/>",
        // TacticalView
        "<path d=\"M2.73 12.00L5.38 8.91L10.68 8.91L13.32 12.00L10.68 15.09L5.38 15.09zM10.68 8.91L13.32 5.82L18.62 5.82L21.27 8.91L18.62 12.00L13.32 12.00zM10.68 15.09L13.32 12.00L18.62 12.00L21.27 15.09L18.62 18.18L13.32 18.18z\"/>",
    };

    static_assert(sizeof(kIconSvg) / sizeof(kIconSvg[0]) == static_cast<size_t>(MuiIcon::Count), "an icon without its drawing");

    constexpr float kGrid = 24.0f;
    // The drawings keep to 2..22 of the grid; those 20 units take 93% of the
    // icon's square, as far out as the icons went before.
    constexpr float kSizeUnits = 21.5f;
    // Strokes are 1.8 units at every size.
    constexpr float kStroke = 1.8f;
    constexpr float kPi = 3.14159265f;

    // x' = a x + c y + e, y' = b x + d y + f.
    struct Affine {
        float a = 1.0f;
        float b = 0.0f;
        float c = 0.0f;
        float d = 1.0f;
        float e = 0.0f;
        float f = 0.0f;

        SDL_FPoint apply(float x, float y) const { return { a * x + c * y + e, b * x + d * y + f }; }

        // [other] first, then this one.
        Affine operator*(const Affine& other) const
        {
            Affine result;
            result.a = a * other.a + c * other.b;
            result.b = b * other.a + d * other.b;
            result.c = a * other.c + c * other.d;
            result.d = b * other.c + d * other.d;
            result.e = a * other.e + c * other.f + e;
            result.f = b * other.e + d * other.f + f;
            return result;
        }
    };

    struct Polyline {
        std::vector<SDL_FPoint> points;
        bool closed;
    };

    // An icon in grid units.
    struct IconShapes {
        std::vector<Polyline> strokes;
        std::vector<std::vector<SDL_FPoint>> fills;
    };

    bool readNumber(const char** cursor, float* value)
    {
        const char* p = *cursor;
        while (*p == ' ' || *p == ',' || *p == '\t' || *p == '\n') {
            p++;
        }
        char* end;
        float result = strtof(p, &end);
        if (end == p) {
            return false;
        }
        *value = result;
        *cursor = end;
        return true;
    }

    // A flag of an arc: a single 0 or 1, maybe with no separator after it.
    bool readFlag(const char** cursor, bool* value)
    {
        const char* p = *cursor;
        while (*p == ' ' || *p == ',') {
            p++;
        }
        if (*p != '0' && *p != '1') {
            return false;
        }
        *value = *p == '1';
        *cursor = p + 1;
        return true;
    }

    void addCubic(std::vector<SDL_FPoint>& points, SDL_FPoint from, SDL_FPoint c1, SDL_FPoint c2, SDL_FPoint to)
    {
        constexpr int kSegments = 16;
        for (int step = 1; step <= kSegments; step++) {
            float t = static_cast<float>(step) / kSegments;
            float u = 1.0f - t;
            float a = u * u * u;
            float b = 3.0f * u * u * t;
            float c = 3.0f * u * t * t;
            float d = t * t * t;
            points.push_back({ a * from.x + b * c1.x + c * c2.x + d * to.x, a * from.y + b * c1.y + c * c2.y + d * to.y });
        }
    }

    void addQuadratic(std::vector<SDL_FPoint>& points, SDL_FPoint from, SDL_FPoint control, SDL_FPoint to)
    {
        constexpr int kSegments = 12;
        for (int step = 1; step <= kSegments; step++) {
            float t = static_cast<float>(step) / kSegments;
            float u = 1.0f - t;
            points.push_back({ u * u * from.x + 2.0f * u * t * control.x + t * t * to.x, u * u * from.y + 2.0f * u * t * control.y + t * t * to.y });
        }
    }

    // SVG's endpoint arc through its center form (SVG 1.1 F.6.5).
    void addArc(std::vector<SDL_FPoint>& points, SDL_FPoint from, float rx, float ry, float rotation, bool large, bool sweep, SDL_FPoint to)
    {
        rx = std::fabs(rx);
        ry = std::fabs(ry);
        if (rx < 1e-4f || ry < 1e-4f) {
            points.push_back(to);
            return;
        }

        float phi = rotation * kPi / 180.0f;
        float cosPhi = std::cos(phi);
        float sinPhi = std::sin(phi);
        float dx = (from.x - to.x) / 2.0f;
        float dy = (from.y - to.y) / 2.0f;
        float x1 = cosPhi * dx + sinPhi * dy;
        float y1 = -sinPhi * dx + cosPhi * dy;

        float lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
        if (lambda > 1.0f) {
            rx *= std::sqrt(lambda);
            ry *= std::sqrt(lambda);
        }

        float numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
        float denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
        float coefficient = denominator > 0.0f ? std::sqrt(std::max(numerator / denominator, 0.0f)) : 0.0f;
        if (large == sweep) {
            coefficient = -coefficient;
        }
        float cx1 = coefficient * rx * y1 / ry;
        float cy1 = -coefficient * ry * x1 / rx;
        float cx = cosPhi * cx1 - sinPhi * cy1 + (from.x + to.x) / 2.0f;
        float cy = sinPhi * cx1 + cosPhi * cy1 + (from.y + to.y) / 2.0f;

        auto angle = [](float ux, float uy, float vx, float vy) {
            return std::atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        };
        float start = angle(1.0f, 0.0f, (x1 - cx1) / rx, (y1 - cy1) / ry);
        float delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
        if (!sweep && delta > 0.0f) {
            delta -= 2.0f * kPi;
        } else if (sweep && delta < 0.0f) {
            delta += 2.0f * kPi;
        }

        int segments = std::max(static_cast<int>(std::ceil(std::fabs(delta) / (10.0f * kPi / 180.0f))), 2);
        for (int step = 1; step <= segments; step++) {
            float t = start + delta * step / segments;
            float px = rx * std::cos(t);
            float py = ry * std::sin(t);
            points.push_back({ cosPhi * px - sinPhi * py + cx, sinPhi * px + cosPhi * py + cy });
        }
    }

    void addShape(IconShapes* shapes, std::vector<SDL_FPoint>& points, bool closed, bool fill, const Affine& transform)
    {
        if (points.size() >= 2) {
            for (SDL_FPoint& point : points) {
                point = transform.apply(point.x, point.y);
            }
            if (fill) {
                shapes->fills.push_back(points);
            } else {
                shapes->strokes.push_back({ points, closed });
            }
        }
        points.clear();
    }

    void parsePath(const char* data, const Affine& transform, bool fill, IconShapes* shapes)
    {
        std::vector<SDL_FPoint> points;
        SDL_FPoint current = { 0.0f, 0.0f };
        SDL_FPoint start = { 0.0f, 0.0f };
        // The last curve's second control point, for S and T.
        SDL_FPoint control = { 0.0f, 0.0f };
        char previous = 0;
        char command = 0;
        const char* p = data;
        while (true) {
            while (*p == ' ' || *p == ',' || *p == '\t' || *p == '\n') {
                p++;
            }
            if (*p == '\0') {
                break;
            }
            if (isalpha(static_cast<unsigned char>(*p))) {
                command = *p++;
            } else if (command == 0) {
                break;
            }

            bool relative = islower(static_cast<unsigned char>(command)) != 0;
            char upper = static_cast<char>(toupper(static_cast<unsigned char>(command)));
            float ox = relative ? current.x : 0.0f;
            float oy = relative ? current.y : 0.0f;
            if (upper != 'M' && upper != 'Z' && points.empty()) {
                points.push_back(current);
            }

            bool ok = true;
            switch (upper) {
            case 'M': {
                float x;
                float y;
                ok = readNumber(&p, &x) && readNumber(&p, &y);
                if (ok) {
                    addShape(shapes, points, false, fill, transform);
                    current = { ox + x, oy + y };
                    start = current;
                    points.push_back(current);
                    // Pairs after it are lines.
                    command = relative ? 'l' : 'L';
                }
                break;
            }
            case 'L': {
                float x;
                float y;
                ok = readNumber(&p, &x) && readNumber(&p, &y);
                if (ok) {
                    current = { ox + x, oy + y };
                    points.push_back(current);
                }
                break;
            }
            case 'H': {
                float x;
                ok = readNumber(&p, &x);
                if (ok) {
                    current.x = ox + x;
                    points.push_back(current);
                }
                break;
            }
            case 'V': {
                float y;
                ok = readNumber(&p, &y);
                if (ok) {
                    current.y = oy + y;
                    points.push_back(current);
                }
                break;
            }
            case 'C':
            case 'S': {
                float v[6];
                SDL_FPoint c1;
                if (upper == 'C') {
                    for (int index = 0; index < 6 && ok; index++) {
                        ok = readNumber(&p, &v[index]);
                    }
                    c1 = { ox + v[0], oy + v[1] };
                } else {
                    for (int index = 2; index < 6 && ok; index++) {
                        ok = readNumber(&p, &v[index]);
                    }
                    c1 = previous == 'C' || previous == 'S' ? SDL_FPoint { 2.0f * current.x - control.x, 2.0f * current.y - control.y } : current;
                }
                if (ok) {
                    SDL_FPoint c2 = { ox + v[2], oy + v[3] };
                    SDL_FPoint to = { ox + v[4], oy + v[5] };
                    addCubic(points, current, c1, c2, to);
                    control = c2;
                    current = to;
                }
                break;
            }
            case 'Q':
            case 'T': {
                float v[4];
                SDL_FPoint c;
                if (upper == 'Q') {
                    for (int index = 0; index < 4 && ok; index++) {
                        ok = readNumber(&p, &v[index]);
                    }
                    c = { ox + v[0], oy + v[1] };
                } else {
                    for (int index = 2; index < 4 && ok; index++) {
                        ok = readNumber(&p, &v[index]);
                    }
                    c = previous == 'Q' || previous == 'T' ? SDL_FPoint { 2.0f * current.x - control.x, 2.0f * current.y - control.y } : current;
                }
                if (ok) {
                    SDL_FPoint to = { ox + v[2], oy + v[3] };
                    addQuadratic(points, current, c, to);
                    control = c;
                    current = to;
                }
                break;
            }
            case 'A': {
                float rx;
                float ry;
                float rotation;
                bool large;
                bool sweep;
                float x;
                float y;
                ok = readNumber(&p, &rx) && readNumber(&p, &ry) && readNumber(&p, &rotation)
                    && readFlag(&p, &large) && readFlag(&p, &sweep) && readNumber(&p, &x) && readNumber(&p, &y);
                if (ok) {
                    SDL_FPoint to = { ox + x, oy + y };
                    addArc(points, current, rx, ry, rotation, large, sweep, to);
                    current = to;
                }
                break;
            }
            case 'Z':
                addShape(shapes, points, true, fill, transform);
                current = start;
                break;
            default:
                ok = false;
                break;
            }

            if (!ok) {
                break;
            }
            previous = upper;
        }
        addShape(shapes, points, false, fill, transform);
    }

    Affine parseTransform(const std::string& text)
    {
        Affine result;
        const char* p = text.c_str();
        while (*p != '\0') {
            while (*p == ' ' || *p == ',') {
                p++;
            }
            std::string name;
            while (isalpha(static_cast<unsigned char>(*p))) {
                name += *p++;
            }
            if (*p != '(') {
                break;
            }
            p++;
            float v[3] = { 0.0f, 0.0f, 0.0f };
            int count = 0;
            while (count < 3 && readNumber(&p, &v[count])) {
                count++;
            }
            while (*p != '\0' && *p != ')') {
                p++;
            }
            if (*p == ')') {
                p++;
            }

            Affine step;
            if (name == "translate") {
                step.e = v[0];
                step.f = count > 1 ? v[1] : 0.0f;
            } else if (name == "scale") {
                step.a = v[0];
                step.d = count > 1 ? v[1] : v[0];
            } else if (name == "rotate") {
                float angle = v[0] * kPi / 180.0f;
                Affine rotation;
                rotation.a = std::cos(angle);
                rotation.b = std::sin(angle);
                rotation.c = -std::sin(angle);
                rotation.d = std::cos(angle);
                Affine to;
                to.e = v[1];
                to.f = v[2];
                Affine back;
                back.e = -v[1];
                back.f = -v[2];
                step = count == 3 ? to * rotation * back : rotation;
            }
            result = result * step;
        }
        return result;
    }

    IconShapes parseIcon(const char* svg)
    {
        IconShapes shapes;
        std::vector<Affine> transforms(1);
        const char* p = svg;
        while ((p = strchr(p, '<')) != nullptr) {
            p++;
            if (*p == '/') {
                if (transforms.size() > 1) {
                    transforms.pop_back();
                }
                continue;
            }

            std::string tag;
            while (isalpha(static_cast<unsigned char>(*p))) {
                tag += *p++;
            }

            std::map<std::string, std::string> attributes;
            bool selfClosing = false;
            while (*p != '\0' && *p != '>') {
                if (*p == '/') {
                    selfClosing = true;
                    p++;
                    continue;
                }
                if (*p == ' ') {
                    p++;
                    continue;
                }
                std::string name;
                while (*p != '\0' && *p != '=' && *p != ' ' && *p != '>' && *p != '/') {
                    name += *p++;
                }
                if (*p == '=' && (p[1] == '"' || p[1] == '\'')) {
                    char quote = p[1];
                    const char* value = p + 2;
                    const char* end = strchr(value, quote);
                    if (end == nullptr) {
                        return shapes;
                    }
                    attributes[name] = std::string(value, end);
                    p = end + 1;
                }
            }

            Affine transform = transforms.back();
            if (attributes.count("transform") != 0) {
                transform = transform * parseTransform(attributes["transform"]);
            }
            if (tag == "g") {
                if (!selfClosing) {
                    transforms.push_back(transform);
                }
                continue;
            }

            bool fill = attributes["class"] == "f";
            auto number = [&](const char* name) {
                return static_cast<float>(atof(attributes[name].c_str()));
            };
            std::vector<SDL_FPoint> points;
            if (tag == "path") {
                parsePath(attributes["d"].c_str(), transform, fill, &shapes);
            } else if (tag == "circle") {
                float cx = number("cx");
                float cy = number("cy");
                float r = number("r");
                constexpr int kSegments = 48;
                for (int step = 0; step < kSegments; step++) {
                    float angle = 2.0f * kPi * step / kSegments;
                    points.push_back({ cx + std::cos(angle) * r, cy + std::sin(angle) * r });
                }
                addShape(&shapes, points, true, fill, transform);
            } else if (tag == "rect") {
                float x = number("x");
                float y = number("y");
                float w = number("width");
                float h = number("height");
                float r = std::min(number("rx"), std::min(w, h) / 2.0f);
                if (r <= 0.0f) {
                    points = { { x, y }, { x + w, y }, { x + w, y + h }, { x, y + h } };
                } else {
                    struct Corner {
                        float cx;
                        float cy;
                        float start;
                    };
                    Corner corners[4] = { { x + w - r, y + r, -90.0f }, { x + w - r, y + h - r, 0.0f }, { x + r, y + h - r, 90.0f }, { x + r, y + r, 180.0f } };
                    for (const Corner& corner : corners) {
                        for (int step = 0; step <= 8; step++) {
                            float angle = (corner.start + 90.0f * step / 8.0f) * kPi / 180.0f;
                            points.push_back({ corner.cx + std::cos(angle) * r, corner.cy + std::sin(angle) * r });
                        }
                    }
                }
                addShape(&shapes, points, true, fill, transform);
            }
        }
        return shapes;
    }

    float signedArea(const std::vector<SDL_FPoint>& points)
    {
        float area = 0.0f;
        for (size_t index = 0; index < points.size(); index++) {
            const SDL_FPoint& a = points[index];
            const SDL_FPoint& b = points[(index + 1) % points.size()];
            area += a.x * b.y - b.x * a.y;
        }
        return area;
    }

    // All one way round: overlapping parts add up instead of cutting holes.
    void addContour(std::vector<std::vector<SDL_FPoint>>* contours, std::vector<SDL_FPoint> points)
    {
        if (signedArea(points) < 0.0f) {
            std::reverse(points.begin(), points.end());
        }
        contours->push_back(std::move(points));
    }

    // A stroke as the union of its segments' quads and a round cap at every
    // point (round joins and ends).
    void addStroke(std::vector<std::vector<SDL_FPoint>>* contours, const Polyline& line, float halfWidth)
    {
        size_t count = line.points.size();
        size_t segments = line.closed ? count : count - 1;
        for (size_t index = 0; index < segments; index++) {
            const SDL_FPoint& a = line.points[index];
            const SDL_FPoint& b = line.points[(index + 1) % count];
            float dx = b.x - a.x;
            float dy = b.y - a.y;
            float length = std::sqrt(dx * dx + dy * dy);
            if (length < 1e-3f) {
                continue;
            }
            float nx = -dy / length * halfWidth;
            float ny = dx / length * halfWidth;
            addContour(contours, { { a.x + nx, a.y + ny }, { b.x + nx, b.y + ny }, { b.x - nx, b.y - ny }, { a.x - nx, a.y - ny } });
        }

        int steps = std::clamp(static_cast<int>(halfWidth * 4.0f), 8, 32);
        for (const SDL_FPoint& point : line.points) {
            std::vector<SDL_FPoint> cap;
            for (int step = 0; step < steps; step++) {
                float angle = 2.0f * kPi * step / steps;
                cap.push_back({ point.x + std::cos(angle) * halfWidth, point.y + std::sin(angle) * halfWidth });
            }
            addContour(contours, std::move(cap));
        }
    }

    const IconShapes& iconShapes(MuiIcon icon)
    {
        static std::vector<IconShapes> parsed;
        if (parsed.empty()) {
            for (const char* svg : kIconSvg) {
                parsed.push_back(parseIcon(svg));
            }
        }
        return parsed[static_cast<size_t>(icon)];
    }

    // An icon drawn in white into a texture (alpha premultiplied), tinted
    // when drawn: rasterized once per size.
    struct IconTexture {
        SDL_Texture* texture = nullptr;
        int extent = 0;
    };

    using IconKey = std::tuple<int, int>;
    std::map<IconKey, IconTexture> gIconTextures;

    // Sizes change during animations; the cache is dropped when it grows
    // past this.
    constexpr size_t kMaxIconTextures = 256;

    const IconTexture* iconTexture(SDL_Renderer* renderer, MuiIcon icon, float size)
    {
        IconKey key(static_cast<int>(icon), static_cast<int>(lroundf(size * 4.0f)));
        auto it = gIconTextures.find(key);
        if (it != gIconTextures.end()) {
            return it->second.texture != nullptr ? &(it->second) : nullptr;
        }

        if (gIconTextures.size() >= kMaxIconTextures) {
            muiIconsReset();
        }

        IconTexture& entry = gIconTextures[key];

        // The whole grid with room for strokes sticking out of it.
        float scale = size / kSizeUnits;
        float halfWidth = kStroke * scale / 2.0f;
        entry.extent = static_cast<int>(std::ceil(kGrid * scale + halfWidth * 2.0f)) + 4;
        float origin = entry.extent / 2.0f - kGrid / 2.0f * scale;

        const IconShapes& shapes = iconShapes(icon);
        std::vector<std::vector<SDL_FPoint>> contours;
        auto toPixels = [&](std::vector<SDL_FPoint> points) {
            for (SDL_FPoint& point : points) {
                point = { origin + point.x * scale, origin + point.y * scale };
            }
            return points;
        };
        for (const Polyline& line : shapes.strokes) {
            addStroke(&contours, { toPixels(line.points), line.closed }, halfWidth);
        }
        for (const std::vector<SDL_FPoint>& fill : shapes.fills) {
            addContour(&contours, toPixels(fill));
        }

        std::vector<unsigned char> coverage = muiRasterizeContours(contours, entry.extent, entry.extent);
        std::vector<Uint32> pixels(coverage.size());
        for (size_t index = 0; index < coverage.size(); index++) {
            Uint32 value = coverage[index];
            pixels[index] = (value << 24) | (value << 16) | (value << 8) | value;
        }

        entry.texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STATIC, entry.extent, entry.extent);
        if (entry.texture == nullptr) {
            return nullptr;
        }
        SDL_UpdateTexture(entry.texture, nullptr, pixels.data(), entry.extent * static_cast<int>(sizeof(Uint32)));
        SDL_SetTextureBlendMode(entry.texture, muiPremultipliedBlendMode());
        SDL_SetTextureScaleMode(entry.texture, SDL_ScaleModeNearest);
        return &entry;
    }

} // namespace

void muiDrawIcon(MuiIcon icon, float x, float y, float size, MuiColor color)
{
    SDL_Renderer* renderer = muiDrawGetRenderer();
    if (renderer == nullptr || icon == MuiIcon::Count || size <= 0.0f) {
        return;
    }

    const IconTexture* entry = iconTexture(renderer, icon, size);
    if (entry == nullptr) {
        return;
    }

    // Premultiplied: the tint's alpha scales the color too.
    SDL_SetTextureColorMod(entry->texture, color.r * color.a / 255, color.g * color.a / 255, color.b * color.a / 255);
    SDL_SetTextureAlphaMod(entry->texture, color.a);

    // Whole pixels keep the icon as sharp as rasterized.
    SDL_Rect dest = {
        static_cast<int>(lroundf(x - entry->extent / 2.0f)),
        static_cast<int>(lroundf(y - entry->extent / 2.0f)),
        entry->extent,
        entry->extent,
    };
    SDL_RenderCopy(renderer, entry->texture, nullptr, &dest);
}

void muiIconsReset()
{
    for (auto& entry : gIconTextures) {
        if (entry.second.texture != nullptr) {
            SDL_DestroyTexture(entry.second.texture);
        }
    }
    gIconTextures.clear();
}

} // namespace fallout
