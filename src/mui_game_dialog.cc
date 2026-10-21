#include "mui.h"
#include "mui_icons.h"
#include "mui_screens.h"

#include <algorithm>
#include <string>
#include <vector>

#include "combat.h"
#include "game.h"
#include "game_commands.h"
#include "game_dialog.h"
#include "game_sound.h"
#include "input.h"
#include "inventory.h"
#include "item.h"
#include "kb.h"
#include "message.h"
#include "mui_notify.h"
#include "object.h"
#include "pipboy.h"
#include "settings.h"
#include "skill.h"

namespace fallout {

namespace {

    // Tab column of game screens, dp.
    constexpr float kTabColumnWidthDp = 52.0f;

    // Game screen windows (`muiScreenFrame`), dp: the largest window (the
    // size the screens' tablet layouts are made for), the least margin to
    // the screen's edges, the gap to the tab column outside, the strip
    // past the tabs where a tap doesn't close the window (the tabs have no
    // frame; the window's padding keeps its own buttons off its edge).
    constexpr float kWindowWidthDp = 896.0f;
    constexpr float kWindowHeightDp = 680.0f;
    constexpr float kWindowPaddingDp = 14.0f;
    constexpr float kWindowMarginDp = 24.0f;
    constexpr float kWindowTabsGapDp = 12.0f;
    constexpr float kWindowRadiusDp = 12.0f;
    constexpr float kWindowTabsSlopDp = 8.0f;
    constexpr Uint8 kWindowAlpha = 247;

    // A window shown again within this time (another game screen's tab)
    // keeps the world dark instead of fading it in anew, ms.
    constexpr unsigned int kWindowContinueMs = 1000;

    // When a window was last drawn (`muiScreenFrame`), the opening of the
    // screen that drew it, whether that one went on from another window.
    unsigned int gWindowShownTime = 0;
    unsigned int gWindowOpenTime = 0;
    bool gWindowContinued = false;

    // Content area the screens' tall layouts need, dp.
    constexpr float kTallMinWidthDp = 680.0f;
    constexpr float kTallMinHeightDp = 440.0f;

    // Talk in windows: the left column (the speaker picture over the reply
    // or the party member's stats) at most, the party member's name row, dp.
    constexpr float kTallLeftColumnDp = 460.0f;
    constexpr float kPartyStatsNameDp = 24.0f;

    const MuiColor kBackground = muiRgb(0x060A07);
    const MuiColor kReactionGood = muiRgb(0x78B4FF);
    const MuiColor kReactionBad = muiRgb(0xFF6E5E);

    // Changed, not applied yet (sections, settings).
    const MuiColor kSectionMarkColor = muiRgb(0xFFB000);

    // Texts in `game\ce.msg`.
    constexpr int kTextPartyStats = 172;
    constexpr int kTextPartyBestWeapon = 182;
    constexpr int kTextPartyBestArmor = 183;
    constexpr int kTextPartyDisposition = 184;
    constexpr int kTextPartyDispositions = 185;
    constexpr int kTextPartyNoWeapon = 382;
    constexpr int kTextPartyNoArmor = 383;
    constexpr int kTextPartyWearsNoArmor = 384;
    constexpr int kTextPartyBest = 385;

    const char* const kPartyStatFallbacks[] = { "Hit points", "Skill", "Carrying", "Melee damage", "APs", "Level", "AC", "Addict" };
    const char* const kPartyDispositionFallbacks[kPartyControlDispositionCount] = { "Custom", "Coward", "Defensive", "Aggressive", "Berserk" };

    // Icons of the party member settings (burst, run away, weapon, distance,
    // attack who, chems).
    const MuiIcon kPartySettingIcons[kPartyControlSettingCount] = {
        MuiIcon::Burst,
        MuiIcon::Back,
        MuiIcon::FilterWeapons,
        MuiIcon::Spread,
        MuiIcon::Target,
        MuiIcon::FilterDrugs,
    };

    std::u32string partyText(int id, const char* fallback)
    {
        return muiDecodeGameText(muiText(id, fallback));
    }

    // A row of the party member's stats (as the game's combat control
    // panel): label (index in kPartyStatFallbacks), value (none: the label
    // alone, the addiction), whether it warns.
    struct PartyStat {
        int label;
        std::string value;
        bool warning;
    };

    std::vector<PartyStat> partyStats(const PartyControlView& view)
    {
        std::vector<PartyStat> stats = {
            { 0, std::to_string(view.hitPoints) + "/" + std::to_string(view.maximumHitPoints), false },
            { 1, skillGetName(view.bestSkill), false },
            { 2, std::to_string(view.weight) + "/" + std::to_string(view.carryWeight), view.encumbered },
            { 3, std::to_string(view.meleeDamage), false },
            { 4, std::to_string(view.actionPoints) + "/" + std::to_string(view.maximumActionPoints), false },
        };
        if (view.extraInfo) {
            stats.push_back({ 5, std::to_string(view.level), false });
            stats.push_back({ 6, std::to_string(view.armorClass), false });
            if (view.addicted) {
                stats.push_back({ 7, std::string(), true });
            }
        }
        return stats;
    }

    // Talk screen: speaker (talking head or map around the speaker, drawn by
    // the game) on the left with the reply below it, options on the right,
    // tabs at the right edge. Reply, options and review scroll in their own
    // areas. Party members also get the party member control panel (the
    // game's combat control and customization panels in one): their stats
    // and equipment under the head instead of the reply, the combat
    // settings instead of the options.
    class TalkScreen : public MuiScreen {
    public:
        bool reviewOpen = false;
        bool reviewScrollToEnd = false;
        std::string lastReply;
        int lastOptionCount = -1;
        unsigned int headVersion = 0;
        std::vector<unsigned char> head;

        // Review requested by the barter screen's review tab.
        bool reviewPending = false;

        bool partyOpen = false;
        bool partyPending = false;

        bool coversScreen() override { return !muiUsesWindows(); }
        bool isGameScreen() override { return true; }

        // Closes the review or party panel (the game's talk has no back:
        // answers end it).
        void back() override
        {
            reviewOpen = false;
            partyOpen = false;
        }

        bool isActive() override
        {
            bool talking = gameDialogIsTalking();
            modal = talking;
            if (!talking) {
                reviewOpen = false;
                partyOpen = false;
            } else if (reviewPending) {
                reviewPending = false;
                reviewOpen = true;
                partyOpen = false;
                reviewScrollToEnd = true;
            } else if (partyPending) {
                partyPending = false;
                partyOpen = true;
                reviewOpen = false;
            }

            if (partyOpen && !gameDialogSpeakerIsPartyMember()) {
                partyOpen = false;
            }
            return talking;
        }

        // Talk and barter screens switch without the map showing between
        // them (while the game switches neither is up).
        bool holdsFrame() override
        {
            BarterView view;
            return !gameDialogIsTalking() && gameDialogIsInBarter() && !barterGetView(&view);
        }

        void build(MuiContext& ui) override;

    private:
        void buildHead(MuiContext& ui, const MuiRect& rect);
        void buildIconButtons(MuiContext& ui, const MuiRect& column);
        void buildReply(MuiContext& ui, const MuiRect& rect, bool tall);
        void buildOptions(MuiContext& ui, const MuiRect& area, bool tall);
        void buildReview(MuiContext& ui, const MuiRect& rect);
        void buildPartyMember(MuiContext& ui, const MuiRect& rect, const PartyControlView& view, bool tall);
        void buildPartyStats(MuiContext& ui, const MuiRect& rect, const std::vector<PartyStat>& stats, bool tall);
        bool buildPartyCard(MuiContext& ui, const MuiRect& rect, const std::string& id, Object* item, bool weapon, bool enabled, const std::u32string& emptyText);
        void buildPartySettings(MuiContext& ui, const MuiRect& rect, const PartyControlView& view, bool tall);
        void buildPartyDispositions(MuiContext& ui, const MuiRect& rect, const PartyControlView& view, bool tall);
    };

    TalkScreen* gTalkScreen = nullptr;

    void TalkScreen::build(MuiContext& ui)
    {
        // Opaque over the map, or a window over it. No tap outside: the
        // game's talk has no back, answers end it.
        MuiScreenFrame frame = muiScreenFrame(ui, kBackground);
        const MuiRect& content = frame.content;
        const MuiRect& iconColumn = frame.tabs;
        float gap = ui.dp(10.0f);

        // New reply: show it from the top.
        const char* reply = gameDialogGetReplyText();
        int optionCount = gameDialogGetOptionCount();
        if (lastReply != reply || lastOptionCount != optionCount) {
            lastReply = reply;
            lastOptionCount = optionCount;
            ui.setScroll("talk.reply", 0.0f);
            ui.setScroll("talk.options", 0.0f);
        }

        // The speaker picture keeps the game's aspect (388 x 200) across the
        // left column, the reply (the party member's stats and equipment)
        // below it, the answers (review, party member settings) at the
        // right. Tablet windows (their mockups): a wider column, the picture
        // about 1.2 times the game's.
        bool tall = muiIsTallContent(ui, content);
        MuiRect left;
        float headHeight;
        if (tall) {
            left = { content.x, content.y, std::floor(std::min(ui.dp(kTallLeftColumnDp), content.w * 0.53f)), content.h };
            headHeight = std::floor(std::min(left.w * 200.0f / 388.0f, content.h * 0.42f));
            // A picture held back by the height takes the column with it:
            // the reply's panel as wide as the picture, the rest to the
            // right.
            left.w = std::min(left.w, std::ceil(headHeight * 388.0f / 200.0f));
        } else {
            left = { content.x, content.y, (iconColumn.right() - content.x) * 0.46f, content.h };
            headHeight = std::min(left.w * 200.0f / 388.0f, left.h * 0.6f);
        }
        MuiRect right = { left.right() + gap, content.y, content.right() - left.right() - gap, content.h };
        buildHead(ui, { left.x, left.y, left.w, headHeight });
        MuiRect below = { left.x, left.y + headHeight + gap, left.w, left.h - headHeight - gap };

        PartyControlView partyView;
        if (partyOpen && gameDialogGetPartyControlView(&partyView)) {
            buildPartyMember(ui, below, partyView, tall);
            buildPartySettings(ui, right, partyView, tall);
        } else {
            buildReply(ui, below, tall);
            if (reviewOpen) {
                buildReview(ui, right);
            } else {
                buildOptions(ui, right, tall);
            }
        }

        buildIconButtons(ui, iconColumn);
    }

    void TalkScreen::buildHead(MuiContext& ui, const MuiRect& rect)
    {
        const MuiTheme& theme = muiTheme();

        // Talking head as the game draws it (animated, lips), or the map
        // around the speaker.
        const unsigned char* data;
        int width;
        int height;
        int pitch;
        if (!gameDialogGetHeadImage(&data, &width, &height, &pitch)) {
            return;
        }

        head.resize(static_cast<size_t>(width) * height);
        for (int row = 0; row < height; row++) {
            std::copy(data + row * pitch, data + row * pitch + width, head.begin() + row * width);
        }

        SDL_Texture* texture = muiIndexedTexture("talk.head", head.data(), width, height, ++headVersion);
        MuiRect headRect = muiFitRect(rect, static_cast<float>(width), static_cast<float>(height));
        muiFillRoundRect(headRect, ui.dp(6.0f), kBackground);
        muiDrawTexture(texture, headRect);
        muiStrokeRoundRect(headRect.inset(-ui.dp(1.0f)), ui.dp(6.0f), ui.dp(theme.borderWidth), theme.panelBorder);
    }

    // Tabs at the right edge: talk, barter (traders only), review, party
    // member control (party members only).
    void TalkScreen::buildIconButtons(MuiContext& ui, const MuiRect& column)
    {
        MuiDialogTab active = partyOpen ? MuiDialogTab::Party : (reviewOpen ? MuiDialogTab::Review : MuiDialogTab::Talk);
        int tab = muiDialogTabs(ui, column, active, gameDialogSpeakerCanBarter(), gameDialogSpeakerIsPartyMember());
        switch (tab) {
        case static_cast<int>(MuiDialogTab::Talk):
            reviewOpen = false;
            partyOpen = false;
            break;
        case static_cast<int>(MuiDialogTab::Barter):
            reviewOpen = false;
            partyOpen = false;
            gameDialogRequestBarter();
            break;
        case static_cast<int>(MuiDialogTab::Review):
            reviewOpen = true;
            partyOpen = false;
            reviewScrollToEnd = true;
            break;
        case static_cast<int>(MuiDialogTab::Party):
            partyOpen = true;
            reviewOpen = false;
            break;
        }
    }

    void TalkScreen::buildReply(MuiContext& ui, const MuiRect& rect, bool tall)
    {
        const MuiTheme& theme = muiTheme();
        ui.panel(rect);

        float size = ui.dp(tall ? 18.0f : 17.0f);
        float lineHeight = std::max(muiLineHeight(size), ui.dp(tall ? 27.0f : 0.0f));
        MuiRect content = tall ? rect.inset(ui.dp(18.0f), ui.dp(12.0f)) : rect.inset(ui.dp(12.0f), ui.dp(10.0f));

        // Speaker name as the header.
        if (gGameDialogSpeaker != nullptr) {
            float nameSize = ui.dp(tall ? 16.0f : 15.0f);
            float nameHeight = std::max(muiLineHeight(nameSize), ui.dp(tall ? 24.0f : 0.0f));
            muiDrawTextAligned(muiDecodeGameText(objectGetName(gGameDialogSpeaker)), { content.x, content.y, content.w, nameHeight }, nameSize, theme.accent, MuiAlign::Start, MuiAlign::Center);
            content.y += nameHeight + ui.dp(4.0f);
            content.h -= nameHeight + ui.dp(4.0f);
        }

        std::vector<std::u32string> lines = muiWrapText(muiDecodeGameText(gameDialogGetReplyText()), content.w, size);
        float height = lines.size() * lineHeight;

        float offset = ui.scroll("talk.reply", content, height);

        muiPushClip(content);
        float y = content.y - offset;
        for (const std::u32string& line : lines) {
            if (y + lineHeight >= content.y && y <= content.bottom()) {
                muiDrawTextAligned(line, { content.x, y, content.w, lineHeight }, size, theme.text, MuiAlign::Start, MuiAlign::Center);
            }
            y += lineHeight;
        }
        muiPopClip();
    }

    void TalkScreen::buildOptions(MuiContext& ui, const MuiRect& area, bool tall)
    {
        const MuiTheme& theme = muiTheme();

        // In windows the scroll bar gets its room at the right.
        MuiRect rect = tall ? MuiRect { area.x, area.y, area.w - ui.dp(12.0f), area.h } : area;
        float size = ui.dp(tall ? 17.0f : 16.0f);
        float paddingX = ui.dp(tall ? 18.0f : 10.0f);
        float paddingY = ui.dp(tall ? 12.0f : 7.0f);
        float gap = ui.dp(tall ? 8.0f : 6.0f);
        float minHeight = ui.dp(tall ? 52.0f : 46.0f);
        float radius = ui.dp(tall ? 8.0f : 6.0f);
        float lineHeight = std::max(muiLineHeight(size), ui.dp(tall ? 26.0f : 0.0f));
        float textWidth = rect.w - paddingX * 2.0f;

        int count = gameDialogGetOptionCount();
        std::vector<std::vector<std::u32string>> texts;
        std::vector<float> heights;
        float total = 0.0f;
        for (int index = 0; index < count; index++) {
            texts.push_back(muiWrapText(muiDecodeGameText(gameDialogGetOptionText(index)), textWidth, size));
            heights.push_back(std::max(texts.back().size() * lineHeight + paddingY * 2.0f, minHeight));
            total += heights.back() + (index > 0 ? gap : 0.0f);
        }

        float offset = ui.scroll("talk.options", rect, total);
        bool scrolling = ui.isScrolling("talk.options");

        muiPushClip(rect);
        float y = rect.y - offset;
        for (int index = 0; index < count; index++) {
            MuiRect optionRect = { rect.x, y, rect.w, heights[index] };
            y += heights[index] + gap;

            if (optionRect.bottom() < rect.y || optionRect.y > rect.bottom()) {
                continue;
            }

            // Visible part only, so a half hidden option can't be tapped
            // outside the area.
            MuiRect touchRect = optionRect;
            touchRect.y = std::max(optionRect.y, rect.y);
            touchRect.h = std::min(optionRect.bottom(), rect.bottom()) - touchRect.y;

            bool pressed;
            bool tapped = ui.touchable("talk.options." + std::to_string(index), touchRect, &pressed);

            muiFillRoundRect(optionRect, radius, pressed ? theme.buttonPressed : theme.button);
            muiStrokeRoundRect(optionRect, radius, ui.dp(1.0f), pressed ? theme.accent : theme.buttonBorder);

            MuiColor color = theme.text;
            switch (gameDialogGetOptionReaction(index)) {
            case 0:
                color = kReactionGood;
                break;
            case 2:
                color = kReactionBad;
                break;
            default:
                break;
            }

            float textY = optionRect.y + (optionRect.h - texts[index].size() * lineHeight) / 2.0f;
            for (const std::u32string& line : texts[index]) {
                muiDrawTextAligned(line, { optionRect.x + paddingX, textY, textWidth, lineHeight }, size, color, MuiAlign::Start, MuiAlign::Center);
                textY += lineHeight;
            }

            if (tapped && !scrolling) {
                _gsound_red_butt_press(-1, 0);
                gameDialogChooseOption(index);
            }
        }
        muiPopClip();
    }

    // Under the head: the party member's stats and its weapon and armor -
    // in windows the stats over the width in two columns and the two cards
    // beside each other under them, on phones the stats at the left and
    // the cards over each other at the right.
    void TalkScreen::buildPartyMember(MuiContext& ui, const MuiRect& rect, const PartyControlView& view, bool tall)
    {
        std::vector<PartyStat> stats = partyStats(view);
        MuiRect statsRect;
        MuiRect weapon;
        MuiRect armor;
        if (tall) {
            float gap = ui.dp(10.0f);
            int rows = static_cast<int>(stats.size() + 1) / 2;
            float fixed = ui.dp(10.0f) * 2.0f + ui.dp(kPartyStatsNameDp) + ui.dp(11.0f);
            // The cards keep at least a low card's height.
            float rowHeight = std::clamp((rect.h - ui.dp(96.0f) - gap - fixed) / rows, ui.dp(20.0f), ui.dp(28.0f));
            statsRect = { rect.x, rect.y, rect.w, fixed + rows * rowHeight };
            float cardsY = statsRect.bottom() + gap;
            float cardWidth = std::floor((rect.w - gap) / 2.0f);
            weapon = { rect.x, cardsY, cardWidth, rect.bottom() - cardsY };
            armor = { weapon.right() + gap, cardsY, rect.right() - weapon.right() - gap, weapon.h };
        } else {
            float gap = ui.dp(6.0f);
            statsRect = { rect.x, rect.y, std::floor((rect.w - gap) / 2.0f), rect.h };
            float x = statsRect.right() + gap;
            float cardHeight = (rect.h - gap) / 2.0f;
            weapon = { x, rect.y, rect.right() - x, cardHeight };
            armor = { x, weapon.bottom() + gap, weapon.w, rect.bottom() - weapon.bottom() - gap };
        }

        buildPartyStats(ui, statsRect, stats, tall);

        if (buildPartyCard(ui, weapon, "talk.party.weapon", view.weapon, true, true, partyText(kTextPartyNoWeapon, "No weapon"))) {
            _gsound_red_butt_press(-1, 0);
            gameDialogQueuePartyControlAction(PartyControlAction::UseBestWeapon);
        }
        std::u32string noArmor = view.canEquipArmor ? partyText(kTextPartyNoArmor, "No armor") : partyText(kTextPartyWearsNoArmor, "Wears no armor");
        if (buildPartyCard(ui, armor, "talk.party.armor", view.armor, false, view.canEquipArmor, noArmor)) {
            _gsound_red_butt_press(-1, 0);
            gameDialogQueuePartyControlAction(PartyControlAction::UseBestArmor);
        }
    }

    // Name and the stats (two columns in windows), rows as high as the
    // panel allows; they scroll only if even their least rows don't fit.
    void TalkScreen::buildPartyStats(MuiContext& ui, const MuiRect& rect, const std::vector<PartyStat>& stats, bool tall)
    {
        const MuiTheme& theme = muiTheme();
        ui.panel(rect);
        MuiRect content = tall ? rect.inset(ui.dp(14.0f), ui.dp(10.0f)) : rect.inset(ui.dp(9.0f), ui.dp(5.0f));

        float nameSize = ui.dp(tall ? 17.0f : 13.0f);
        float nameHeight = tall ? ui.dp(kPartyStatsNameDp) : std::max(muiLineHeight(nameSize), ui.dp(17.0f));
        std::u32string name = muiDecodeGameText(objectGetName(gGameDialogSpeaker));
        muiDrawTextAligned(name, { content.x, content.y, content.w, nameHeight }, muiFitTextSize(name, content.w, nameSize, ui.dp(11.0f)), theme.accent, MuiAlign::Start, MuiAlign::Center);
        float y = content.y + nameHeight + ui.dp(tall ? 6.0f : 3.0f);
        muiFillRect({ content.x, y, content.w, ui.dp(1.0f) }, theme.panelBorder);
        y += ui.dp(tall ? 5.0f : 3.0f);

        int columns = tall ? 2 : 1;
        int rows = (static_cast<int>(stats.size()) + columns - 1) / columns;
        MuiRect area = { content.x, y, content.w, content.bottom() - y };
        float rowHeight = tall
            ? std::min(ui.dp(28.0f), area.h / rows)
            : std::clamp(area.h / rows, ui.dp(14.0f), ui.dp(23.0f));
        float labelSize = tall ? ui.dp(14.0f) : std::min(ui.dp(15.0f), rowHeight * 0.74f);
        float valueSize = tall ? ui.dp(15.0f) : labelSize;
        float columnGap = ui.dp(24.0f);
        float columnWidth = (area.w - columnGap * (columns - 1)) / columns;

        float offset = ui.scroll("talk.party.stats", area, rows * rowHeight);
        muiPushClip(area);
        for (size_t index = 0; index < stats.size(); index++) {
            const PartyStat& stat = stats[index];
            int column = static_cast<int>(index) / rows;
            int row = static_cast<int>(index) % rows;
            MuiRect cell = { area.x + column * (columnWidth + columnGap), area.y - offset + row * rowHeight, columnWidth, rowHeight };
            std::u32string label = partyText(kTextPartyStats + stat.label, kPartyStatFallbacks[stat.label]);
            MuiColor valueColor = stat.warning ? muiRgb(0xFF6E5E) : theme.text;
            if (stat.value.empty()) {
                muiDrawTextAligned(label, cell, labelSize, valueColor, MuiAlign::Start, MuiAlign::Center);
            } else {
                // The value fits beside its label (the best skill's name).
                std::u32string value = muiDecodeGameText(stat.value.c_str());
                float labelWidth = muiTextWidth(label, labelSize) + ui.dp(8.0f);
                muiDrawTextAligned(label, cell, labelSize, theme.textDim, MuiAlign::Start, MuiAlign::Center);
                muiDrawTextAligned(value, cell, muiFitTextSize(value, cell.w - labelWidth, valueSize, ui.dp(9.0f)), valueColor, MuiAlign::End, MuiAlign::Center);
            }
        }
        muiPopClip();
    }

    // Weapon or armor: its picture (the empty slot's mark without one) over
    // the name and its "use best" button - or, where the card is too low
    // for that (phones, 7" tablets), the picture at the left of the name
    // over the button; returns true if the button was tapped.
    bool TalkScreen::buildPartyCard(MuiContext& ui, const MuiRect& rect, const std::string& id, Object* item, bool weapon, bool enabled, const std::u32string& emptyText)
    {
        const MuiTheme& theme = muiTheme();
        ui.panel(rect);
        MuiRect inner = rect.inset(ui.dp(8.0f));
        float gap = ui.dp(8.0f);

        float size = ui.dp(item != nullptr ? 15.0f : 14.0f);
        float lineHeight = std::max(muiLineHeight(size), ui.dp(20.0f));
        float buttonHeight = ui.dp(36.0f);
        MuiRect art;
        MuiRect text;
        MuiRect buttonRect;
        if (inner.h - buttonHeight - lineHeight - gap * 2.0f >= ui.dp(56.0f)) {
            buttonRect = { inner.x, inner.bottom() - buttonHeight, inner.w, buttonHeight };
            text = { inner.x, buttonRect.y - gap - lineHeight, inner.w, lineHeight };
            art = { inner.x, inner.y, inner.w, text.y - gap - inner.y };
        } else {
            art = { inner.x, inner.y, std::min(ui.dp(84.0f), inner.w * 0.48f), inner.h };
            float right = art.right() + gap;
            buttonHeight = std::min(buttonHeight, inner.h * 0.5f);
            buttonRect = { right, inner.bottom() - buttonHeight, inner.right() - right, buttonHeight };
            text = { right, inner.y, inner.right() - right, buttonRect.y - ui.dp(4.0f) - inner.y };
        }

        muiFillRoundRect(art, ui.dp(6.0f), muiRgb(0x0F1C14));
        muiStrokeRoundRect(art, ui.dp(6.0f), ui.dp(1.0f), theme.panelBorder);
        if (item != nullptr) {
            int width;
            int height;
            SDL_Texture* texture = muiArtTexture(itemGetInventoryFrmId(item), 0, &width, &height);
            if (texture != nullptr) {
                // No bigger than an inventory cell shows it.
                MuiRect box = art.inset(ui.dp(4.0f));
                float boxWidth = std::min(box.w, ui.dp(120.0f));
                float boxHeight = std::min(box.h, ui.dp(80.0f));
                box = { box.centerX() - boxWidth / 2.0f, box.centerY() - boxHeight / 2.0f, boxWidth, boxHeight };
                muiDrawTexture(texture, muiFitRect(box, static_cast<float>(width), static_cast<float>(height)));
            }
        } else {
            float iconSize = std::min({ art.h * 0.55f, art.w * 0.55f, ui.dp(44.0f) });
            muiDrawIcon(weapon ? MuiIcon::Use : MuiIcon::FilterArmor, art.centerX(), art.centerY(), iconSize, ui.dp(1.6f), theme.buttonBorder);
        }

        // Up to two lines (as many as there's room for); one line smaller
        // before it's cut.
        std::u32string name = item != nullptr ? muiDecodeGameText(itemGetName(item)) : emptyText;
        std::vector<std::u32string> lines = muiWrapText(name, text.w, size);
        size_t maxLines = std::clamp(static_cast<size_t>(text.h / lineHeight), static_cast<size_t>(1), static_cast<size_t>(2));
        float nameSize = size;
        if (maxLines == 1 && lines.size() > 1) {
            float fitted = muiFitTextSize(name, text.w, size, ui.dp(11.0f));
            if (muiTextWidth(name, fitted) <= text.w) {
                lines = { name };
                nameSize = fitted;
            }
        }
        if (lines.size() > maxLines) {
            lines.resize(maxLines);
        }
        float y = text.centerY() - lines.size() * lineHeight / 2.0f;
        muiPushClip(text);
        for (const std::u32string& line : lines) {
            muiDrawTextAligned(line, { text.x, y, text.w, lineHeight }, nameSize, item != nullptr ? theme.text : theme.textDim, MuiAlign::Start, MuiAlign::Center);
            y += lineHeight;
        }
        muiPopClip();

        // Short where the whole one doesn't fit (the picture tells which).
        std::u32string buttonText = weapon ? partyText(kTextPartyBestWeapon, "Use best weapon") : partyText(kTextPartyBestArmor, "Use best armor");
        if (muiTextWidth(buttonText, ui.dp(12.0f)) > buttonRect.w - ui.dp(12.0f)) {
            buttonText = partyText(kTextPartyBest, "Best");
        }
        bool pressed;
        bool tapped = ui.touchable(id, buttonRect, &pressed) && enabled;
        pressed = pressed && enabled;
        muiFillRoundRect(buttonRect, ui.dp(8.0f), !enabled ? muiRgb(0x0F1C14) : (pressed ? theme.buttonPressed : theme.button));
        muiStrokeRoundRect(buttonRect, ui.dp(8.0f), ui.dp(1.0f), !enabled ? theme.panelBorder : (pressed ? theme.accent : theme.buttonBorder));
        float buttonSize = muiFitTextSize(buttonText, buttonRect.w - ui.dp(12.0f), ui.dp(14.0f), ui.dp(10.0f));
        muiDrawTextAligned(buttonText, buttonRect, buttonSize, enabled ? theme.buttonText : theme.textDim, MuiAlign::Center, MuiAlign::Center);
        return tapped;
    }

    // The right column: the title (in windows), the dispositions (the
    // game's presets) in a row, the six settings under them one per row
    // (their name, the value; a tap opens the values). The settings scroll
    // only if even their least rows don't fit. Their values are the chosen
    // disposition's; changing one switches to the custom one, as in the
    // game.
    void TalkScreen::buildPartySettings(MuiContext& ui, const MuiRect& rect, const PartyControlView& view, bool tall)
    {
        const MuiTheme& theme = muiTheme();
        float y = rect.y;
        if (tall) {
            float titleHeight = ui.dp(28.0f);
            std::u32string title = partyText(kTextPartyDisposition, "Disposition");
            muiDrawTextAligned(title, { rect.x, y, rect.w, titleHeight }, muiFitTextSize(title, rect.w, ui.dp(17.0f), ui.dp(11.0f)), theme.accent, MuiAlign::Start, MuiAlign::Center);
            y += titleHeight + ui.dp(8.0f);
        }
        float dispositionHeight = ui.dp(tall ? 48.0f : 36.0f);
        buildPartyDispositions(ui, { rect.x, y, rect.w, dispositionHeight }, view, tall);
        y += dispositionHeight + ui.dp(tall ? 10.0f : 6.0f);

        MuiRect area = { rect.x, y, rect.w, rect.bottom() - y };
        float rowGap = ui.dp(tall ? 8.0f : 4.0f);
        float rowHeight = std::clamp((area.h - rowGap * (kPartyControlSettingCount - 1)) / kPartyControlSettingCount,
            ui.dp(tall ? 52.0f : 40.0f), ui.dp(tall ? 96.0f : 64.0f));
        float total = rowHeight * kPartyControlSettingCount + rowGap * (kPartyControlSettingCount - 1);

        float offset = ui.scroll("talk.party", area, total);
        bool scrolling = ui.isScrolling("talk.party");

        float iconSize = ui.dp(tall ? 24.0f : 18.0f);
        float padding = ui.dp(tall ? 16.0f : 10.0f);
        float chevronWidth = ui.dp(tall ? 16.0f : 12.0f);
        float nameSize = ui.dp(tall ? 13.0f : 11.0f);
        float nameHeight = std::max(muiLineHeight(nameSize), ui.dp(tall ? 18.0f : 13.0f));
        float valueSize = ui.dp(tall ? 17.0f : 13.0f);
        float valueLine = std::max(muiLineHeight(valueSize), ui.dp(tall ? 24.0f : 17.0f));
        int maxLines = rowHeight >= nameHeight + valueLine * 2.0f + ui.dp(8.0f) ? 2 : 1;

        float textX = area.x + padding * 2.0f + iconSize;
        float textWidth = area.right() - padding - chevronWidth - ui.dp(8.0f) - textX;
        std::u32string values[kPartyControlSettingCount];
        for (int setting = 0; setting < kPartyControlSettingCount; setting++) {
            values[setting] = muiDecodeGameText(view.settings[setting] != -1
                    ? gameDialogPartyControlValueName(setting, view.settings[setting])
                    : gameDialogPartyControlNotApplicable());
        }

        // One line: the values in one size, as small as the longest needs
        // (cut below the least).
        if (maxLines == 1) {
            for (const std::u32string& value : values) {
                valueSize = std::min(valueSize, muiFitTextSize(value, textWidth, valueSize, ui.dp(10.0f)));
            }
        }

        muiPushClip(area);
        for (int setting = 0; setting < kPartyControlSettingCount; setting++) {
            MuiRect row = { area.x, area.y - offset + setting * (rowHeight + rowGap), area.w, rowHeight };

            bool pressed;
            bool tapped = ui.touchable("talk.party.setting." + std::to_string(setting), row, &pressed);
            muiFillRoundRect(row, ui.dp(8.0f), pressed ? theme.buttonPressed : theme.button);
            muiStrokeRoundRect(row, ui.dp(8.0f), ui.dp(1.0f), pressed ? theme.accent : theme.buttonBorder);

            muiDrawIcon(kPartySettingIcons[setting], row.x + padding + iconSize / 2.0f, row.centerY(), iconSize, ui.dp(1.8f), theme.accent);

            MuiRect text = { textX, row.y, textWidth, row.h };
            std::u32string name = muiDecodeGameText(gameDialogPartyControlSettingName(setting));

            // Two lines where the row is high enough.
            std::vector<std::u32string> lines = maxLines == 1 ? std::vector<std::u32string> { values[setting] } : muiWrapText(values[setting], text.w, valueSize);
            if (static_cast<int>(lines.size()) > maxLines) {
                lines.resize(maxLines);
            }
            float blockHeight = nameHeight + ui.dp(2.0f) + lines.size() * valueLine;
            float ty = row.centerY() - blockHeight / 2.0f;
            muiDrawTextAligned(name, { text.x, ty, text.w, nameHeight }, muiFitTextSize(name, text.w, nameSize, ui.dp(9.0f)), theme.textDim, MuiAlign::Start, MuiAlign::Center);
            ty += nameHeight + ui.dp(2.0f);
            MuiColor valueColor = view.settings[setting] != -1 ? theme.accent : theme.textDim;
            for (const std::u32string& line : lines) {
                muiDrawTextAligned(line, { text.x, ty, text.w, valueLine }, valueSize, valueColor, MuiAlign::Start, MuiAlign::Center);
                ty += valueLine;
            }
            float chevronX = row.right() - padding - chevronWidth / 2.0f;
            float chevron = ui.dp(tall ? 5.0f : 4.0f);
            muiDrawPolyline({ { chevronX - chevron / 2.0f, row.centerY() - chevron }, { chevronX + chevron / 2.0f, row.centerY() }, { chevronX - chevron / 2.0f, row.centerY() + chevron } }, ui.dp(1.8f), theme.textDim);

            if (tapped && !scrolling) {
                _gsound_red_butt_press(-1, 0);

                std::vector<MuiActionItem> items;
                int count = gameDialogPartyControlValueCount(setting);
                for (int value = 0; value < count; value++) {
                    MuiActionItem item;
                    item.icon = kPartySettingIcons[setting];
                    item.label = muiDecodeGameText(gameDialogPartyControlValueName(setting, value));
                    item.detail = value == view.settings[setting] ? U"•" : U"";
                    item.enabled = gameDialogPartyControlValueSupported(setting, value);
                    items.push_back(item);
                }

                muiShowActionList(
                    "talk.party.values", items, row, row,
                    [setting](int value) {
                        gameDialogQueuePartyControlAction(PartyControlAction::SetSetting, setting, value);
                    },
                    []() { return gTalkScreen != nullptr && gTalkScreen->partyOpen && gameDialogIsTalking(); });
            }
        }
        muiPopClip();
    }

    // The dispositions in one row, each as wide as its name and the room
    // left shared out; the names smaller where they don't fit together.
    void TalkScreen::buildPartyDispositions(MuiContext& ui, const MuiRect& rect, const PartyControlView& view, bool tall)
    {
        const MuiTheme& theme = muiTheme();
        float gap = ui.dp(tall ? 6.0f : 4.0f);
        float padding = ui.dp(6.0f);
        float size = ui.dp(tall ? 14.0f : 12.0f);

        std::u32string labels[kPartyControlDispositionCount];
        float textWidth = 0.0f;
        for (int disposition = 0; disposition < kPartyControlDispositionCount; disposition++) {
            labels[disposition] = partyText(kTextPartyDispositions + disposition, kPartyDispositionFallbacks[disposition]);
            textWidth += muiTextWidth(labels[disposition], size);
        }
        float room = rect.w - gap * (kPartyControlDispositionCount - 1) - padding * 2.0f * kPartyControlDispositionCount;
        if (textWidth > room && textWidth > 0.0f) {
            float fitted = std::max(size * room / textWidth, ui.dp(9.0f));
            textWidth *= fitted / size;
            size = fitted;
        }
        float extra = std::max(room - textWidth, 0.0f) / kPartyControlDispositionCount;

        float x = rect.x;
        for (int disposition = 0; disposition < kPartyControlDispositionCount; disposition++) {
            float width = disposition == kPartyControlDispositionCount - 1
                ? rect.right() - x
                : muiTextWidth(labels[disposition], size) + padding * 2.0f + extra;
            MuiRect cell = { x, rect.y, width, rect.h };
            x += width + gap;
            bool supported = view.dispositionSupported[disposition];
            bool active = view.disposition == disposition;

            bool pressed;
            bool tapped = ui.touchable("talk.party.disposition." + std::to_string(disposition), cell, &pressed) && supported;
            pressed = pressed && supported;

            MuiColor fill = pressed ? theme.buttonPressed : (active ? theme.buttonPrimary : theme.button);
            muiFillRoundRect(cell, ui.dp(tall ? 8.0f : 7.0f), fill);
            muiStrokeRoundRect(cell, ui.dp(tall ? 8.0f : 7.0f), ui.dp(1.0f), active || pressed ? theme.accent : theme.buttonBorder);

            MuiColor color = !supported ? theme.textDim : (active && !pressed ? theme.buttonPrimaryText : theme.buttonText);
            muiDrawTextAligned(labels[disposition], cell, size, color, MuiAlign::Center, MuiAlign::Center);

            if (tapped && !active) {
                _gsound_red_butt_press(-1, 0);
                gameDialogQueuePartyControlAction(PartyControlAction::SetDisposition, disposition);
            }
        }
    }

    // Everything said in this conversation, like the game's review window.
    void TalkScreen::buildReview(MuiContext& ui, const MuiRect& rect)
    {
        const MuiTheme& theme = muiTheme();
        ui.panel(rect);

        float size = ui.dp(16.0f);
        float lineHeight = muiLineHeight(size);
        float paragraphGap = ui.dp(8.0f);
        MuiRect content = rect.inset(ui.dp(12.0f), ui.dp(10.0f));

        struct Line {
            std::u32string text;
            MuiColor color;
            float gapBefore;
        };

        std::u32string speaker = gGameDialogSpeaker != nullptr ? muiDecodeGameText(objectGetName(gGameDialogSpeaker)) : U"";
        std::u32string dude = muiDecodeGameText(objectGetName(gDude));

        std::vector<Line> lines;
        int count = gameDialogGetReviewCount();
        for (int index = 0; index < count; index++) {
            const char* reply;
            const char* option;
            gameDialogGetReviewEntry(index, &reply, &option);

            bool first = true;
            for (const std::u32string& text : muiWrapText(speaker + U": " + muiDecodeGameText(reply), content.w, size)) {
                lines.push_back({ text, theme.text, first && !lines.empty() ? paragraphGap : 0.0f });
                first = false;
            }

            if (option != nullptr) {
                first = true;
                for (const std::u32string& text : muiWrapText(dude + U": " + muiDecodeGameText(option), content.w, size)) {
                    lines.push_back({ text, theme.accent, first ? paragraphGap / 2.0f : 0.0f });
                    first = false;
                }
            }
        }

        float height = 0.0f;
        for (const Line& line : lines) {
            height += line.gapBefore + lineHeight;
        }

        if (reviewScrollToEnd) {
            ui.setScroll("talk.review", std::max(height - content.h, 0.0f));
            reviewScrollToEnd = false;
        }

        float offset = ui.scroll("talk.review", content, height);

        muiPushClip(content);
        float y = content.y - offset;
        for (const Line& line : lines) {
            y += line.gapBefore;
            if (y + lineHeight >= content.y && y <= content.bottom()) {
                muiDrawText(line.text, content.x, y, size, line.color);
            }
            y += lineHeight;
        }
        muiPopClip();
    }

} // namespace

void muiDialogLayout(MuiContext& ui, MuiRect* content, MuiRect* tabs)
{
    MuiRect safe = ui.safeRect().inset(ui.dp(10.0f));
    float width = ui.dp(kTabColumnWidthDp);
    *tabs = { safe.right() - width, safe.y, width, safe.h };
    *content = { safe.x, safe.y, tabs->x - ui.dp(10.0f) - safe.x, safe.h };
}

MuiScreenFrame muiScreenFrameLayout(MuiContext& ui)
{
    MuiScreenFrame frame;
    if (!muiUsesWindows()) {
        frame.window = ui.screenRect();
        muiDialogLayout(ui, &frame.content, &frame.tabs);
        return frame;
    }

    // The window: at most the size the screens are laid out for, the
    // screen's margins and the tab column outside it kept. In the UI's dp
    // like everything inside: a UI size works as a screen of that many dp
    // (at 100% a 10" tablet shows the windows' mockups as they are).
    MuiRect safe = ui.safeRect();
    float margin = ui.dp(kWindowMarginDp);
    float tabsWidth = ui.dp(kTabColumnWidthDp);
    float tabsGap = ui.dp(kWindowTabsGapDp);
    float width = std::min(ui.dp(kWindowWidthDp), safe.w - margin * 2.0f - tabsGap - tabsWidth);
    float height = std::min(ui.dp(kWindowHeightDp), safe.h - margin * 2.0f);
    float x = safe.centerX() - width / 2.0f;
    x = std::min(x, safe.right() - margin - tabsWidth - tabsGap - width);
    x = std::max(x, safe.x + margin);
    float y = safe.centerY() - height / 2.0f;

    frame.windowed = true;
    frame.window = { x, y, width, height };
    frame.content = frame.window.inset(ui.dp(kWindowPaddingDp));
    frame.tabs = muiTabsBeside(ui, frame.window);
    return frame;
}

bool muiIsTallContent(MuiContext& ui, const MuiRect& content)
{
    switch (settings.touch.layout) {
    case kMuiLayoutPhone:
        return false;
    case kMuiLayoutTablet:
        // Even where they don't fit: the player sees it and chooses again.
        return true;
    default:
        // Only windows: screens covering the screen keep the phone's
        // layouts.
        return muiUsesWindows() && content.w >= ui.dp(kTallMinWidthDp) && content.h >= ui.dp(kTallMinHeightDp);
    }
}

MuiScreenFrame muiScreenFrame(MuiContext& ui, MuiColor background, bool overTitle)
{
    MuiScreenFrame frame = muiScreenFrameLayout(ui);
    if (!frame.windowed) {
        muiFillRect(ui.screenRect(), background);
        return frame;
    }

    // The title menu's picture instead of the world (the menu itself is
    // closed under its screens).
    if (overTitle) {
        muiDrawTitleArt(ui, ui.screenRect().x);
    }

    // Decided when the screen opens: it fades the world in, or goes on from
    // the window just closed.
    unsigned int openTime = ui.current != nullptr ? ui.current->openTime : 0;
    if (openTime != gWindowOpenTime) {
        gWindowOpenTime = openTime;
        gWindowContinued = gWindowShownTime != 0 && ui.now - gWindowShownTime < kWindowContinueMs;
    }
    gWindowShownTime = ui.now;
    ui.dim(!gWindowContinued);
    const MuiTheme& theme = muiTheme();
    MuiColor fill = background.withAlpha(kWindowAlpha);
    float radius = ui.dp(kWindowRadiusDp);
    muiFillRoundRect(frame.window, radius, fill);
    muiStrokeRoundRect(frame.window, radius, ui.dp(theme.borderWidth), theme.panelBorder);

    // Like the game menu: a tap past the window's edge closes it, only a
    // finger missing a tab sideways doesn't.
    MuiRect around = { frame.window.x, frame.window.y, frame.tabs.right() + ui.dp(kWindowTabsSlopDp) - frame.window.x, frame.window.h };
    ui.mark(kMuiWindowTapArea, around);
    frame.tappedOutside = settings.touch.windows_tap_outside && ui.tappedOutside(around);
    return frame;
}

MuiRect muiTabsBeside(MuiContext& ui, const MuiRect& rect)
{
    return { rect.right() + ui.dp(kWindowTabsGapDp), rect.y, ui.dp(kTabColumnWidthDp), rect.h };
}

int muiDialogTabs(MuiContext& ui, const MuiRect& column, MuiDialogTab active, bool barterAvailable, bool partyAvailable)
{
    float size = column.w;
    float gap = ui.dp(8.0f);
    float y = column.y;
    int result = -1;

    struct Tab {
        MuiDialogTab tab;
        const char* id;
        MuiIcon icon;
    };

    const Tab tabs[] = {
        { MuiDialogTab::Talk, "dialog.tab.talk", MuiIcon::Talk },
        { MuiDialogTab::Barter, "dialog.tab.barter", MuiIcon::Barter },
        { MuiDialogTab::Review, "dialog.tab.review", MuiIcon::Review },
        { MuiDialogTab::Party, "dialog.tab.party", MuiIcon::PartyOrders },
    };

    for (const Tab& tab : tabs) {
        if ((tab.tab == MuiDialogTab::Barter && !barterAvailable) || (tab.tab == MuiDialogTab::Party && !partyAvailable)) {
            continue;
        }

        MuiRect rect = { column.x, y, size, size };
        y += size + gap;

        if (muiTabButton(ui, tab.id, rect, tab.icon, tab.tab == active)) {
            result = static_cast<int>(tab.tab);
        }
    }

    return result;
}

int muiSectionList(MuiContext& ui, const std::string& idPrefix, const MuiRect& column, const std::vector<std::u32string>& labels, int selected, const std::vector<bool>& marked, bool roomy)
{
    const MuiTheme& theme = muiTheme();
    ui.panel(column);

    MuiRect inner = column.inset(ui.dp(roomy ? 8.0f : 6.0f));
    float gap = ui.dp(4.0f);
    float height = std::min(ui.dp(roomy ? 56.0f : 46.0f), (inner.h - gap * (labels.size() - 1)) / std::max<size_t>(labels.size(), 1));
    float radius = ui.dp(theme.radius);

    int result = selected;
    for (size_t index = 0; index < labels.size(); index++) {
        MuiRect rect = { inner.x, inner.y + (height + gap) * index, inner.w, height };
        bool on = static_cast<int>(index) == selected;
        bool pressed;
        if (ui.touchable(idPrefix + "." + std::to_string(index), rect, &pressed) && !on) {
            _gsound_red_butt_press(-1, 0);
            result = static_cast<int>(index);
        }

        if (on || pressed) {
            muiFillRoundRect(rect, radius, on ? theme.buttonPrimary : theme.buttonPressed);
        }

        float padding = ui.dp(roomy ? 16.0f : 12.0f);
        float textX = rect.x + padding;
        if (index < marked.size() && marked[index]) {
            float dot = ui.dp(4.0f);
            muiFillCircle(textX + dot, rect.centerY(), dot, on ? theme.buttonPrimaryText : kSectionMarkColor);
            textX += dot * 2.0f + ui.dp(8.0f);
        }

        MuiRect textRect = { textX, rect.y, rect.right() - textX - padding, rect.h };
        float size = muiFitTextSize(labels[index], textRect.w, ui.dp(roomy ? 17.0f : 15.0f), ui.dp(11.0f));
        muiDrawTextAligned(labels[index], textRect, size, on ? theme.buttonPrimaryText : theme.text, MuiAlign::Start, MuiAlign::Center);
    }

    return result;
}

MuiGameScreenTab muiGameScreenTabs(MuiContext& ui, const MuiRect& column, const std::string& idPrefix, MuiGameScreenTab active, bool screens)
{
    struct Tab {
        MuiGameScreenTab tab;
        const char* id;
        MuiIcon icon;
    };

    const Tab tabs[] = {
        { MuiGameScreenTab::Back, "back", MuiIcon::Back },
        { MuiGameScreenTab::Inventory, "inventory", MuiIcon::Inventory },
        { MuiGameScreenTab::Character, "character", MuiIcon::Character },
        { MuiGameScreenTab::Pipboy, "pipboy", MuiIcon::Pipboy },
        { MuiGameScreenTab::Map, "map", MuiIcon::Map },
    };

    float size = column.w;
    float gap = ui.dp(8.0f);
    MuiRect rect = { column.x, column.y, size, size };
    MuiGameScreenTab result = MuiGameScreenTab::None;

    for (const Tab& tab : tabs) {
        if (tab.tab != MuiGameScreenTab::Back && !screens) {
            break;
        }

        // Game screens play the game's sound when they open.
        if (muiTabButton(ui, idPrefix + "." + tab.id, rect, tab.icon, tab.tab == active, tab.tab == MuiGameScreenTab::Back)) {
            result = tab.tab;
        }

        // In combat: what opening the inventory costs; no Pip-Boy in combat
        // or before the vault suit. The overlay is visual only; blocked taps
        // still show the game's message.
        if (tab.tab == MuiGameScreenTab::Inventory && tab.tab != active) {
            std::u32string cost;
            bool blocked = false;
            if (muiInventoryCost(&cost, &blocked)) {
                if (blocked) {
                    muiDrawUnavailableOverlay(ui, rect, muiTheme().radius);
                }
                muiDrawCostBadge(ui, rect, cost, blocked);
            }
        } else if (tab.tab == MuiGameScreenTab::Pipboy && tab.tab != active && pipboyUnavailableReason() != PipboyUnavailable::None) {
            muiDrawUnavailableOverlay(ui, rect, muiTheme().radius);
        }
        rect.y += size + gap;
    }

    return result;
}

bool muiSwitchGameScreen(MuiContext& ui, MuiGameScreenTab tab)
{
    GameCommandType command;

    switch (tab) {
    case MuiGameScreenTab::Inventory: {
        int actionPoints;
        switch (inventoryCheckOpen(gDude, &actionPoints)) {
        case InventoryOpenCheck::NotYourTurn:
            return false;
        case InventoryOpenCheck::NoActionPoints:
            inventoryReportNoActionPoints();
            return false;
        case InventoryOpenCheck::Ok:
            break;
        }
        command = GameCommandType::Inventory;
        break;
    }
    case MuiGameScreenTab::Character:
        command = GameCommandType::Character;
        break;
    case MuiGameScreenTab::Pipboy: {
        // The screen stays, the game's message says why.
        PipboyUnavailable reason = pipboyUnavailableReason();
        if (reason != PipboyUnavailable::None) {
            if (reason == PipboyUnavailable::InCombat) {
                soundPlayFile("iisxxxx1");
            }
            muiNotify(pipboyUnavailableText(reason), MuiNoticeKind::Warning);
            return false;
        }
        command = GameCommandType::Pipboy;
        break;
    }
    case MuiGameScreenTab::Map:
        command = GameCommandType::Automap;
        break;
    default:
        return false;
    }

    gameCommandPost(command);
    muiHoldFrameForSwitch(ui.current);
    return true;
}

bool muiInventoryCost(std::u32string* text, bool* blocked)
{
    int actionPoints;
    InventoryOpenCheck check = inventoryCheckOpen(gDude, &actionPoints);
    if (check == InventoryOpenCheck::NotYourTurn || actionPoints <= 0) {
        return false;
    }

    std::string value = std::to_string(actionPoints);
    *text = std::u32string(value.begin(), value.end());
    *blocked = check == InventoryOpenCheck::NoActionPoints;
    return true;
}

void muiDrawCostBadge(MuiContext& ui, const MuiRect& button, const std::u32string& text, bool warning)
{
    const MuiTheme& theme = muiTheme();
    float size = ui.dp(11.0f);
    float height = ui.dp(17.0f);
    float width = std::max(height, muiTextWidth(text, size) + ui.dp(8.0f));
    MuiRect badge = { button.right() - width + ui.dp(3.0f), button.y - ui.dp(3.0f), width, height };
    MuiColor color = warning ? muiRgb(0xFF6E5E) : theme.accent;
    muiFillRoundRect(badge, height / 2.0f, muiRgb(0x0B120D));
    muiStrokeRoundRect(badge, height / 2.0f, ui.dp(1.2f), color);
    muiDrawTextAligned(text, badge, size, color, MuiAlign::Center, MuiAlign::Center);
}

void muiDrawUnavailableOverlay(MuiContext& ui, const MuiRect& button, float radiusDp)
{
    muiFillRoundRect(button, ui.dp(radiusDp), muiRgb(0x000000, 140));
}

bool muiTabButton(MuiContext& ui, const std::string& id, const MuiRect& rect, MuiIcon icon, bool active, bool sound)
{
    const MuiTheme& theme = muiTheme();

    bool pressed;
    bool tapped = ui.touchable(id, rect, &pressed);
    MuiColor fill = pressed ? theme.buttonPressed : (active ? theme.buttonPrimary : theme.button);
    MuiColor iconColor = active && !pressed ? theme.buttonPrimaryText : theme.accent;
    muiFillRoundRect(rect, ui.dp(theme.radius), fill);
    muiStrokeRoundRect(rect, ui.dp(theme.radius), ui.dp(theme.borderWidth), pressed || active ? theme.accent : theme.buttonBorder);
    muiDrawIcon(icon, rect.centerX(), rect.centerY(), rect.w * 0.46f, ui.dp(2.2f), iconColor);

    if (tapped && !active) {
        if (sound) {
            _gsound_red_butt_press(-1, 0);
        }
        return true;
    }
    return false;
}

void muiGameDialogOpenReview()
{
    if (gTalkScreen != nullptr) {
        gTalkScreen->reviewPending = true;
    }
}

void muiGameDialogOpenParty()
{
    if (gTalkScreen != nullptr) {
        gTalkScreen->partyPending = true;
    }
}

void muiGameDialogInit()
{
    if (!muiIsEnabled() || gTalkScreen != nullptr) {
        return;
    }

    gTalkScreen = new TalkScreen();
    muiPush(gTalkScreen);
}

void muiGameDialogExit()
{
    if (gTalkScreen == nullptr) {
        return;
    }

    muiRemove(gTalkScreen);
    delete gTalkScreen;
    gTalkScreen = nullptr;
}

bool muiGameDialogBack()
{
    if (gTalkScreen == nullptr || (!gTalkScreen->reviewOpen && !gTalkScreen->partyOpen)) {
        return false;
    }

    gTalkScreen->reviewOpen = false;
    gTalkScreen->partyOpen = false;
    return true;
}

} // namespace fallout
