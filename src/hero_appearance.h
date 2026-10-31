#ifndef FALLOUT_HERO_APPEARANCE_H_
#define FALLOUT_HERO_APPEARANCE_H_

#include <string>

#include "db.h"

namespace fallout {

// SFALL: Hero Appearance mod (`EnableHeroAppearanceMod`): the player's race
// and style. Each is a set, `Appearance\h<M|F>R<race>S<style>` (a folder
// and/or a .dat in the game's folder) with the hero's own critter art (the
// critter names with "_", see `artHeroFrmId`) and the texts
// `text\<language>\game\AppRace.msg` / `AppStyle.msg` (100 - the name, 101 -
// the description). Races and styles go from 0 without gaps; race 0 style 0
// is the game's own look. A style's art is looked for in its set, then in
// its race's style 0. The choice is kept in sfall's global variables
// `HAp_Race` / `HApStyle` (sfallgv.sav) and at the end of the character's
// .gcd file, as sfall has it.

void heroAppearanceInit();
void heroAppearanceExit();

// 0 - off, 1 - on, 2 - on, scripts see the hero's own art ids as they are
// (sfall's backward compatibility with scripts that fix them themselves).
int heroAppearanceMode();

// Races or styles to choose from (either gender): the mod is on and there is
// a race 1 or a style 1.
bool heroAppearanceHasChoice();

// Races of [gender] (at least 1, race 0), styles of its [race] (at least 1).
int heroAppearanceRaceCount(int gender);
int heroAppearanceStyleCount(int gender, int race);

// The chosen race and style.
int heroAppearanceRace();
int heroAppearanceStyle();

// Chooses [race] and [style] of the dude's gender: false (and the choice
// kept) when that set isn't there. The hero's art is reloaded.
bool heroAppearanceChoose(int race, int style);

// A race's or a style's name and description in the game's language (else
// English), for the screens. Empty when the set has none.
void heroAppearanceGetRaceText(int gender, int race, std::string* name, std::string* description);
void heroAppearanceGetStyleText(int gender, int race, int style, std::string* name, std::string* description);

// [path] (the hero's own art) from the chosen style's set, then its race's
// style 0; nullptr when neither has it.
File* heroAppearanceOpenFile(const char* path);

// The default race and style: the player creates a character of their own
// or changes the gender.
void heroAppearanceReset();

// After a new game started: the choice into sfall's variables.
void heroAppearanceOnNewGame();

// After a game was loaded: the choice from sfall's variables, the hero's art.
void heroAppearanceOnGameLoaded();

// The choice at the end of a character's .gcd file: read (missing in older
// files: the default) and written, as sfall does.
void heroAppearanceReadGcd(File* stream);
void heroAppearanceWriteGcd(File* stream);

} // namespace fallout

#endif /* FALLOUT_HERO_APPEARANCE_H_ */
