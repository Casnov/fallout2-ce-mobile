#include "mui.h"
#include "mui_screens.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "art.h"
#include "critter.h"
#include "dev_autotest.h"
#include "fps_limiter.h"
#include "game.h"
#include "game_sound.h"
#include "hero_appearance.h"
#include "input.h"
#include "kb.h"
#include "object.h"
#include "stat.h"
#include "svga.h"

namespace fallout {

namespace {

    // Texts in `game\ce.msg`.
    constexpr int kTextDone = 123;
    constexpr int kTextRace = 446;
    constexpr int kTextStyle = 447;

    // The creation screen's selected row.
    const MuiColor kSelected = muiRgb(0x16301D);

    // sfall's hero_select_win (Hero Appearance): the races of the dude's
    // gender, or the styles of his race, in a window over the dimmed map, as
    // the creation screen's appearance: the rows at the left, the card (the
    // hero turning, the chosen one's description) at the right. A row shows
    // the hero so at once; Done keeps it, Back or a tap outside the window
    // brings the look back (sfall's Esc).
    class HeroSelectScreen : public MuiScreen {
    public:
        explicit HeroSelectScreen(bool style);

        bool hidesHud() override { return true; }
        void build(MuiContext& ui) override;
        void back() override;

        bool chosen = false;

    private:
        bool style;
        int startRace;
        int startStyle;
    };

    HeroSelectScreen::HeroSelectScreen(bool style)
        : style(style)
        , startRace(heroAppearanceRace())
        , startStyle(heroAppearanceStyle())
    {
        modal = true;
    }

    void HeroSelectScreen::back()
    {
        heroAppearanceChoose(startRace, startStyle);
        finished = true;
    }

    void HeroSelectScreen::build(MuiContext& ui)
    {
        ui.dim();

        MuiScreenFrame frame = muiScreenFrameLayout(ui);
        const MuiRect& content = frame.content;
        const MuiTheme& theme = muiTheme();

        // A window in the creation screen's look: the rows at the left, the
        // card at the right.
        float padding = ui.dp(10.0f);
        float gap = ui.dp(8.0f);
        float headerHeight = ui.dp(32.0f);
        // Narrow and tall: the rows are one short column, the card takes the
        // rest.
        MuiRect window = { 0.0f, 0.0f, std::min(content.w * 0.92f, ui.dp(540.0f)), std::min(content.h * 0.96f, ui.dp(420.0f)) };
        window.x = content.centerX() - window.w / 2.0f;
        window.y = content.centerY() - window.h / 2.0f;

        MuiRect rail = frame.windowed ? muiTabsBeside(ui, window) : frame.tabs;
        if (muiGameScreenTabs(ui, rail, "heroselect", MuiGameScreenTab::None, false) == MuiGameScreenTab::Back || ui.tappedOutside(window)) {
            back();
            return;
        }

        muiFillRoundRect(window, ui.dp(theme.radius), theme.panel);
        muiStrokeRoundRect(window, ui.dp(theme.radius), ui.dp(1.5f), theme.accent);

        int gender = critterGetStat(gDude, STAT_GENDER);
        int race = heroAppearanceRace();
        int current = style ? heroAppearanceStyle() : race;
        int count = style ? heroAppearanceStyleCount(gender, race) : heroAppearanceRaceCount(gender);

        MuiRect inner = window.inset(padding);
        MuiRect header = { inner.x, inner.y, inner.w, headerHeight };
        std::u32string titleText = style ? muiDecodeGameText(muiText(kTextStyle, "Style")) : muiDecodeGameText(muiText(kTextRace, "Race"));
        muiDrawTextAligned(titleText, { header.x + ui.dp(4.0f), header.y, header.w, header.h }, ui.dp(16.0f), theme.accent, MuiAlign::Start, MuiAlign::Center);

        float doneWidth = ui.dp(120.0f);
        MuiRect done = { header.right() - doneWidth, header.y, doneWidth, header.h };
        if (ui.button("heroselect.done", done, muiDecodeGameText(muiText(kTextDone, "DONE")), MuiButtonStyle::Primary)) {
            _gsound_red_butt_press(-1, 0);
            chosen = true;
            finished = true;
            return;
        }

        MuiRect body = { inner.x, header.bottom() + gap, inner.w, inner.bottom() - header.bottom() - gap };
        float listWidth = std::clamp(body.w * 0.4f, ui.dp(160.0f), ui.dp(220.0f));
        MuiRect listPanel = { body.x, body.y, listWidth, body.h };
        MuiRect cardRect = { listPanel.right() + gap, body.y, body.w - listWidth - gap, body.h };

        // The rows as creation's (traits, appearance).
        ui.panel(listPanel);
        MuiRect list = listPanel.inset(ui.dp(6.0f));
        float rowHeight = ui.dp(42.0f);
        float offset = ui.scroll("heroselect.list", list, rowHeight * count);
        bool scrolling = ui.isScrolling("heroselect.list");

        muiPushClip(list);
        for (int value = 0; value < count; value++) {
            MuiRect row = { list.x, list.y - offset + value * rowHeight, list.w, rowHeight };
            if (row.bottom() < list.y || row.y > list.bottom()) {
                continue;
            }

            std::string name;
            std::string description;
            if (style) {
                heroAppearanceGetStyleText(gender, race, value, &name, &description);
            } else {
                heroAppearanceGetRaceText(gender, value, &name, &description);
            }

            bool selected = value == current;
            bool pressed;
            if (ui.touchable("heroselect.row." + std::to_string(value), row, &pressed) && !scrolling && !selected) {
                _gsound_red_butt_press(-1, 0);
                if (style) {
                    heroAppearanceChoose(race, value);
                } else {
                    heroAppearanceChoose(value, 0);
                }
            }
            if (pressed || selected) {
                muiFillRoundRect(row, ui.dp(5.0f), pressed ? theme.buttonPressed : kSelected);
            }

            float padding = ui.dp(6.0f);
            float dot = ui.dp(5.0f);
            float dotX = row.x + padding + dot;
            if (selected) {
                muiFillCircle(dotX, row.centerY(), dot, theme.accent);
            } else {
                muiStrokeCircle(dotX, row.centerY(), dot, ui.dp(1.2f), theme.textDim);
            }
            std::u32string text = muiHeroAppearanceRowName(name, value);
            float labelX = dotX + dot + ui.dp(10.0f);
            float labelWidth = row.right() - labelX - padding;
            muiDrawTextAligned(text, { labelX, row.y, labelWidth, row.h }, muiFitTextSize(text, labelWidth, ui.dp(15.0f), ui.dp(10.0f)), selected ? theme.accent : theme.text, MuiAlign::Start, MuiAlign::Center);
        }
        muiPopClip();

        // The card as creation's: the hero turning, the chosen one's title
        // and description (scrolls when long).
        ui.panel(cardRect);
        MuiRect card = cardRect.inset(ui.dp(12.0f), ui.dp(10.0f));
        std::string currentTitle;
        std::string currentDescription;
        if (style) {
            heroAppearanceGetStyleText(gender, race, current, &currentTitle, &currentDescription);
        } else {
            heroAppearanceGetRaceText(gender, current, &currentTitle, &currentDescription);
        }

        float pictureHeight = card.h * 0.42f;
        muiDrawDudeTurning({ card.x, card.y, card.w, pictureHeight }, ui.now);
        float y = card.y + pictureHeight + ui.dp(8.0f);

        float titleSize = ui.dp(17.0f);
        std::u32string nameText = muiDecodeGameText(currentTitle.c_str());
        muiDrawTextAligned(nameText, { card.x, y, card.w, muiLineHeight(titleSize) }, muiFitTextSize(nameText, card.w, titleSize, ui.dp(12.0f)), theme.accent, MuiAlign::Start, MuiAlign::Center);
        y += muiLineHeight(titleSize) + ui.dp(3.0f);
        muiDrawLine(card.x, y, card.right(), y, ui.dp(1.0f), theme.panelBorder);
        y += ui.dp(6.0f);

        float textSize = ui.dp(13.5f);
        float lineHeight = muiLineHeight(textSize);
        std::vector<std::u32string> lines = muiWrapText(muiDecodeGameText(currentDescription.c_str()), card.w, textSize);
        MuiRect textRect = { card.x, y, card.w, card.bottom() - y };
        float textOffset = ui.scroll("heroselect.text", textRect, lines.size() * lineHeight);
        muiPushClip(textRect);
        for (size_t index = 0; index < lines.size(); index++) {
            float lineY = textRect.y - textOffset + index * lineHeight;
            if (lineY + lineHeight >= textRect.y && lineY <= textRect.bottom()) {
                muiDrawText(lines[index], textRect.x, lineY, textSize, theme.text);
            }
        }
        muiPopClip();
    }

} // namespace

void muiDrawDudeTurning(const MuiRect& area, unsigned int now)
{
    // Standing, a turn every 0.3 s (as sfall's preview); one scale for all
    // directions (fits the tallest), whole pixels when it grows.
    const FrmId body = CritterFrmId(FrmId(gDude).frameId<CritterFrameId>(), ANIM_STAND, WeaponAnimation::None, ROTATION_NE);
    int width;
    int height;
    int maxHeight = 0;
    for (int rotation = 0; rotation < ROTATION_COUNT; rotation++) {
        if (muiArtTexture(body, 0, &width, &height, rotation) != nullptr) {
            maxHeight = std::max(maxHeight, height);
        }
    }

    SDL_Texture* texture = muiArtTexture(body, 0, &width, &height, static_cast<int>(now / 300 % ROTATION_COUNT));
    if (texture == nullptr || maxHeight <= 0) {
        return;
    }

    float scale = area.h / maxHeight;
    if (scale >= 1.0f) {
        scale = std::floor(scale);
    }
    float w = width * scale;
    float h = height * scale;
    muiDrawTexture(texture, { area.centerX() - w / 2.0f, area.bottom() - h, w, h });
}

std::u32string muiHeroAppearanceRowName(const std::string& title, int index)
{
    // What the set's title has in parentheses ("Race (Black)": "Black"),
    // else the title, else its number.
    std::string text = title;
    size_t open = text.rfind('(');
    size_t close = text.rfind(')');
    if (open != std::string::npos && close != std::string::npos && close > open + 1) {
        text = text.substr(open + 1, close - open - 1);
    }
    if (text.empty()) {
        text = std::to_string(index);
    }
    return muiDecodeGameText(text.c_str());
}

bool muiHeroSelectRun(bool style)
{
    HeroSelectScreen screen(style);
    muiPush(&screen);

    while (!screen.finished) {
        sharedFpsLimiter.mark();

        int keyCode = inputGetInput();
        if (keyCode == KEY_ESCAPE) {
            screen.back();
        }

        if (_game_user_wants_to_quit != GAME_QUIT_REQUEST_NONE) {
            screen.back();
        }

        devAutotestTick();
        renderPresent();
        sharedFpsLimiter.throttle();
    }

    muiRemove(&screen);
    return screen.chosen;
}

} // namespace fallout
