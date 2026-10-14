# sfall fixes carried by the port

Fallout 2 CE builds sfall into the engine (sfall itself patches the original
`fallout2.exe` and can't be used with CE). Some of sfall's engine fixes
aren't in CE yet. The port adds them the way CE does, and offers each to CE
as a pull request:

- One fix (or one group of sfall's own) is a branch from upstream `main` and
  a pull request to [fallout2-ce](https://github.com/fallout2-ce/fallout2-ce).
- The same commit is cherry-picked into the port's `main` (`git cherry-pick
  -x`, the original commit is recorded in the message).
- The code follows sfall's behavior and values (flags, thresholds), marked
  `SFALL:` with sfall's name of the fix. No `[enhancements]` setting: the
  fixes sfall always applies are always on.
- An autotest (`src/dev_autotest.cc`, port-only) checks the behavior; it
  fails without the fix.
- Merging upstream: when CE has taken the fix, upstream's version wins in a
  conflict and the row below is marked merged. If CE changed it, the
  autotest still checks the behavior.

Which sfall fixes CE has and which it doesn't:
[sfall-fixes-audit.md](sfall-fixes-audit.md).

| sfall fix | Port commit | Pull request | Autotest | State |
|---|---|---|---|---|
| Fix to allow fleeing NPC to use drugs; Fix for AI not checking minimum HP properly for using stimpaks; Fix for NPC stuck in fleeing mode when the hit chance of a target was too low; Restore combat flags after fleeing when NPC cannot move closer to target (`Modules/AI.cpp`, `Game/combatAI.cpp`) | fd32f057 | [fallout2-ce#839](https://github.com/fallout2-ce/fallout2-ce/pull/839) | `fleeheal` | open |
| use_obj_on_obj: an object using an item on itself uses it at once (`Modules/BugFixes.cpp`, `op_use_obj_on_obj_hack`) | e16a5be2 | [fallout2-ce#840](https://github.com/fallout2-ce/fallout2-ce/pull/840) | `talkheal` | open |
| Critical hit table: sfall's corrections after CE's port of its table fixes - right arm messages of men, women, geckos, aliens and giant ants (cfcc66ad, 2023-12), the super mutants' fix on the right arm (c0f11b7a, 2024-02) (`Modules/Criticals.cpp`) | 42953e08 | [fallout2-ce#841](https://github.com/fallout2-ce/fallout2-ce/pull/841) | `crittable` | open |
| Fix for incorrect initialization of action points at the beginning of each turn (`Modules/BugFixes.cpp`, `combat_hack`) | 550b490e | [fallout2-ce#843](https://github.com/fallout2-ce/fallout2-ce/pull/843) | `apturn` | open |
| Fix for Bonus Move APs being replenished when you save and load the game in combat (`Modules/BugFixes.cpp`, `combat_load_hook`, `combat_turn_hack`) | 570fd40c | [fallout2-ce#844](https://github.com/fallout2-ce/fallout2-ce/pull/844) | `bonusmoveload` | open |
| Fix for the player's movement in combat being interrupted when trying to use objects with Bonus Move APs available; Fix for anim_move_to_tile_ engine function ignoring the distance argument for the player (`Modules/BugFixes.cpp`) | 0a7e92dd | [fallout2-ce#845](https://github.com/fallout2-ce/fallout2-ce/pull/845) | `bonusmovewalk` | open |
| Fix for critter_state function when a critter in combat recovers from the knockout state outside its turn; Fixes for knockout/down issues; Fix for "NPC turns into a container" bug; Fix for knocked down critters not playing stand up animation when the combat ends (`Modules/BugFixes.cpp`) | 7f8dd5ff | [fallout2-ce#846](https://github.com/fallout2-ce/fallout2-ce/pull/846) | `knockouts` | open |
| Fix for the removal of party member's corpse when loading the map (`Modules/BugFixes.cpp`, `partyFixMultipleMembers_hack`) | f96c6285 | [fallout2-ce#847](https://github.com/fallout2-ce/fallout2-ce/pull/847) | `partycorpse` | open |
| Fix for critters not being healed over time when entering a map with 'dead_bodies_age=No' set in maps.txt (`Modules/BugFixes.cpp`, `map_age_dead_critters_hack`) | 84c3439f | [fallout2-ce#848](https://github.com/fallout2-ce/fallout2-ce/pull/848) | `mapageheal` | open |

## Other fixes offered to CE

Where CE differs from the original game in a way sfall doesn't change
(checked against the original `fallout2.exe`), the same scheme: a branch
from upstream `main`, a pull request, a cherry-pick here, an autotest.

| Fix | Port commit | Pull request | Autotest | State |
|---|---|---|---|---|
| Corpse aging after 6/14 days, party member placement's first direction, automap dots, a new critter proto's team: four changes of fallout2-ce#675 that differ from the original | 379f3359 | [fallout2-ce#849](https://github.com/fallout2-ce/fallout2-ce/pull/849) | `orig675` | open |
