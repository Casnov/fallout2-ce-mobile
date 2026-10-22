#ifndef FALLOUT_MUI_ICONS_H_
#define FALLOUT_MUI_ICONS_H_

#include "mui_draw.h"

namespace fallout {

// Line icons of the mobile UI, drawn with the theme colors at any size
// instead of game art or abbreviated labels (SVG on a 24 unit grid in
// mui_icons.cc, as the design board draws them).
enum class MuiIcon {
    // HUD.
    Menu,
    QuickSave,
    QuickLoad,
    Inventory,
    Character,
    Pipboy,
    Map,
    Skills,
    Highlight,
    Sneak,
    Log,
    EndTurn,
    EndCombat,
    ActionPoints,
    HitPoints,
    Aim,
    Reload,
    Fist,
    // Boot (bare hands' kick).
    Kick,
    Weight,
    Back,

    // Party orders.
    PartyOrders,
    Holster,
    Regroup,
    Spread,
    Burst,
    AutoLoot,

    // Skills (sneak, first aid use Sneak and Stimpak).
    Lockpick,
    Steal,
    Traps,
    Doctor,
    Science,
    Repair,
    Target,

    // Dialog tabs.
    Talk,
    Barter,
    Review,

    // Item filters.
    FilterAll,
    FilterWeapons,
    FilterWeaponsAndAmmo,
    FilterArmor,
    // Stimpak: first aid, healing orders and settings.
    Stimpak,
    FilterAmmo,
    FilterMisc,

    // Action menu (the rest are above).
    Cancel,
    Drop,
    Look,
    Rotate,
    Use,
    Unload,
    Push,

    // Steppers, editing.
    Plus,
    Minus,
    Edit,

    // Movie player.
    Play,
    Pause,
    Stop,
    Expand,
    Collapse,

    // Combat's tactical view: three tiles.
    TacticalView,

    Count,
};

// Icon centered at ([x], [y]) in a [size] square (output pixels), its
// strokes 1.8 of 24 of it.
void muiDrawIcon(MuiIcon icon, float x, float y, float size, MuiColor color);

// Icons are rasterized once per size into textures (see `muiDrawIcon`);
// they belong to the renderer.
void muiIconsReset();

} // namespace fallout

#endif /* FALLOUT_MUI_ICONS_H_ */
