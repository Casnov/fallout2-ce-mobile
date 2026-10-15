# sfall engine fixes in Fallout 2 CE: audit

Which of sfall's engine bug fixes Fallout 2 CE has. sfall patches the
original `fallout2.exe`; CE builds sfall into the engine, so a fix sfall
always applies belongs in CE too. See
[sfall-fixes-carried.md](sfall-fixes-carried.md) for the ones the port
carries until CE has them.

Checked 2026-10-14: sfall `master` 6c65e673 (after 4.5.1), CE `main`
5f6f1060 (the port's tree, same code in these functions).

## Method

- The list: every comment in sfall's `Modules/*.cpp` and `Game/*.cpp` that
  starts with "Fix" (207). Other sfall changes (options, tweaks, new
  features) aren't in it.
- Each fix's patched addresses were mapped to CE's functions by the
  original addresses CE marks them with (`// 0x42B130`), then the sfall
  code and CE's function compared by hand.
- "yes" - CE does it (a `SFALL:` note, or CE's own code doing the same);
  "**no**" - CE has the original behavior; "no?" / "yes?" - likely, not
  fully compared; "unclear" - CE changed the code, needs a closer look;
  "not checked" - not compared yet (mostly the original game screens);
  "sfall option, off" - sfall applies it only when an ini option is set
  (off by default); "port" - in the port, offered to CE.
- Scope: "game" - gameplay; "scripts" - script functions (mods);
  "original screens" - the game's own windows (the port's touch screens
  replace them, CE's desktop builds use them); "platform", "debug", "mods".

## Summary

| | Count |
|---|---|
| CE has it | 95 (3 of them likely) |
| Ported by the port, offered to CE | 28 (see [sfall-fixes-carried.md](sfall-fixes-carried.md)) |
| **Missing in CE** | **12** (5 gameplay, 7 scripts) + 5 likely + 1 partly |
| Unclear | 4 |
| Not checked | 45 (27 original screens, 16 gameplay, 2 other) |
| sfall option, off by default | 8 |
| Not applicable (platform, debug, other mods) | 9 |

## Missing gameplay fixes, by how much players notice them

1. **#33** dropping worn armor (drop_obj) keeps its AC.
2. **#75** exit grids while loading or entering a map; **#109** the
   automap reveals unexplored areas when entering a map; **#160**
   misc items' charges not fixed on load; **#152** knocked-down team
   members can be pushed in combat.

Script functions: **#96** attack_complex result flags, **#101**
pickup_obj/drop_obj/use_obj take `self`, **#105** has_skill for an invalid
skill, **#113** dialogue_reaction argument, **#125** critter_add/rm_trait
amount, **#147** create_object_sid with no script.

## All fixes

| # | sfall fix | sfall source | CE | Scope | Notes |
|---|---|---|---|---|---|
| 1 | Fix the carry weight penalty of the Small Frame trait not being applied to bonus Strength points | `stats.cpp:126` | sfall option, off (`Misc/SmallFrameFix=0`) | game | sfall SmallFrameFix=0 (off by default); CE has no option |
| 2 | Fix for NPCs not fully reloading a weapon if it has an ammo capacity more than a box of ammo | `AI.cpp:603` | yes | game | CE reloads from several boxes (aiAttemptWeaponReload, _ai_try_attack loop) |
| 3 | Fix for the incorrect check and AP cost when AI reloads a weapon | `AI.cpp:609` | yes | game | marked SFALL in _ai_try_attack |
| 4 | Fix AI weapon switching when not having enough AP to make an attack AI will try to change attack mode before deciding to switch weapon | `AI.cpp:617` | yes | game | aiTryAttackSwitchFix |
| 5 | Fix to reduce friendly fire in burst attacks Adds a check/roll for friendly critters in the line of fire when AI uses burst attacks | `AI.cpp:621` | port | game | friendly in the straight line of fire stops a burst (IQ roll), random area_attack_mode checks burst safety (fallout2-ce#857) |
| 6 | Fix for duplicate critters being added to the list of potential targets for AI | `AI.cpp:627` | yes | game | aiFindAttackers rejects duplicates |
| 7 | Fix to allow fleeing NPC to use drugs | `AI.cpp:637` | port | game | fallout2-ce#839 |
| 8 | Fix for AI not checking minimum hp properly for using stimpaks (prevents premature fleeing) | `AI.cpp:639` | port | game | fallout2-ce#839 |
| 9 | Fix to prevent the use of healing drugs when not necessary | `AI.cpp:642` | yes | game | CE's own way in _ai_can_use_drug (noted there) |
| 10 | Fix for NPC stuck in fleeing mode when the hit chance of a target was too low | `AI.cpp:647` | port | game | fallout2-ce#839 |
| 11 | Fix AI target selection for combat_check_bad_shot_ function returning a no_ammo result | `AI.cpp:654` | yes | game | SFALL note in _ai_danger_source (no ammo recoverable) |
| 12 | Fix AI behavior for "Snipe" distance preference The attacker will try to shoot the target instead of always running away from it at the beginning of the turn | `AI.cpp:657` | yes | game | SFALL note in _cai_perform_distance_prefs |
| 13 | Fix for ai_move_away_ engine function not working correctly in cases when needing to move a distance away from the target now the function also takes the distance argument in a negative value for moving away at a distance | `AI.cpp:661` | port | game | negative distance to move away from combat_safety, ai_move_away moves it (fallout2-ce#858) |
| 14 | Fix for calling anim() functions in combat | `Animations.cpp:670` | yes | game | _anim_set_end calls _combat_anim_finished by the sequence's combat flag |
| 15 | Fix crash when the critter goes through a door with animation trigger | `Animations.cpp:674` | yes | game | _object_move: door step check (complete or closed door out of combat) |
| 16 | Fix for the player stuck at "climbing" frame after ladder climbing animation | `Animations.cpp:677` | yes | game | _action_climb_ladder sets NO_STAND only for another map / no destination tile |
| 17 | Fix for grave type containers in the open state not executing the use_p_proc procedure | `Animations.cpp:690` | sfall option, off (`Misc/GraveContainersFix=0`) | game | sfall GraveContainersFix=0 (off by default) |
| 18 | Fix item_count_ function returning incorrect value when there is a container item inside | `BugFixes.cpp:3556` | yes | game | SFALL note in itemGetQuantity |
| 19 | Fix for the game disappearing from the taskbar after using Alt+Tab | `BugFixes.cpp:3943` | n/a | platform | Windows Alt+Tab taskbar (SDL window) |
| 20 | Fix vanilla negate operator for float values | `BugFixes.cpp:3950` | yes | scripts | SFALL note in opUnaryMinus |
| 21 | Fix incorrect int-to-float conversion | `BugFixes.cpp:3953` | yes | scripts | CE converts int to float in C++ (no 64-bit fild) |
| 22 | Fix for vanilla division and modulo operators treating negative integers as unsigned | `BugFixes.cpp:3960` | yes | scripts | CE uses signed int division/modulo |
| 23 | Fixes for clickability issue in the pipboy and exploit that allows resting in restricted areas | `BugFixes.cpp:3985` | no? | original screens | Pip-Boy clickability / rest exploit hacks (pipboy_hack, PipAlarm_hack) not found in pipboy.cc; mobile Pip-Boy has its own rest rules |
| 24 | Fix for clickability issue of the holodisk list | `BugFixes.cpp:3989` | no? | original screens | Pip-Boy holodisk list clickability: not found |
| 25 | Fix for extra hidden buttons below the location list in the Status section | `BugFixes.cpp:3993` | no? | original screens | Pip-Boy extra hidden buttons: not found |
| 26 | Fix for the duplicate click sound when selecting a location in the Status section | `BugFixes.cpp:3995` | no? | original screens | Pip-Boy duplicate click sound: not found |
| 27 | Fix for "Too Many Items" bug | `BugFixes.cpp:3998` | unclear | game | "Too Many Items" script block writing; CE rewrote scriptSaveAll lists, needs a deeper check |
| 28 | Fix for cells getting consumed even when the car is already fully charged | `BugFixes.cpp:4005` | yes | game | SFALL note in _obj_use_power_on_car |
| 29 | Fix for being able to charge the car by using cells on other scenery/critters | `BugFixes.cpp:4008` | yes | game | SFALL note in _protinst_default_use_item |
| 30 | Fix for gaining stats from more than two doses of a specific chem after save-load | `BugFixes.cpp:4014` | port | game | drug effect pids saved in sfallgv.sav in queue order and restored after loading (fallout2-ce#855) |
| 31 | Fix crash when leaving the map while waiting for someone to die of a super stimpak overdose | `BugFixes.cpp:4019` | yes | game | SFALL note in queueClearByEventType |
| 32 | Fix for move_obj_inven_to_obj function | `BugFixes.cpp:4030` | yes | scripts | opMoveObjectInventoryToObject runs InvenWield hooks and adjusts the dude's armor |
| 33 | Fix for drop_obj function | `BugFixes.cpp:4034` | **no** | scripts | objectDrop: no InvenWield hook and no AC adjustment when a worn armor is dropped (drop_obj) |
| 34 | Fix of invalid stats when party member gains a level while being on drugs | `BugFixes.cpp:4038` | yes | game | SFALL note in _partyMemberIncLevels |
| 35 | Fix for display issues when highlighting a multiline dialogue option | `BugFixes.cpp:4048` | yes | original screens | SFALL notes in _gdProcessUpdate (multiline option highlight) |
| 36 | Fix for "Unlimited Ammo" exploit | `BugFixes.cpp:4051` | port | game | inventoryEquipFunc wields one item of a stack (fallout2-ce#856) |
| 37 | Fix for negative values in Skilldex window ("S") | `BugFixes.cpp:4055` | yes | original screens | SFALL note in skilldexWindowInit |
| 38 | Fix for negative SPECIAL values in character creation | `BugFixes.cpp:4059` | **no** | game | _is_supper_bonus / stat buttons: no lower bound for SPECIAL in character creation |
| 39 | Fix for not counting in the weight/size of equipped items on NPC when stealing or bartering | `BugFixes.cpp:4066` | port | game | was partly: CE counted the stripped equipment only in the loot screen's label, the barter and steal checks didn't (a party member could be overloaded; found in play 2026-10-15, reproduced in clean CE); fallout2-ce#864 |
| 40 | Fix for minor visual glitch when picking up solo item from the top of inventory and there is multiple item stack at the bottom of inventory | `BugFixes.cpp:4077` | not checked | original screens | inventory pickup visual glitch |
| 41 | Fix for error in player's inventory, related to IFACE_BAR_MODE=1 in f2_res.ini, and also for reverse order error | `BugFixes.cpp:4080` | not checked | original screens | inventory IFACE_BAR_MODE / reverse order error |
| 42 | Fix for using only one box of ammo when a weapon is above the ammo in the inventory list | `BugFixes.cpp:4083` | not checked | original screens | dropping ammo on a weapon above it in the list uses one box |
| 43 | Fix for Jet antidote not being removed after removing the addiction effect (when using the item) | `BugFixes.cpp:4113` | yes | game | SFALL note in drugItemTakeDrug |
| 44 | Fix for op_lookup_string_proc_ engine function not searching the last procedure in a script | `BugFixes.cpp:4140` | yes | scripts | opLookupStringProc loops to the last procedure |
| 45 | Fix for multihex critters moving too close and overlapping their targets in combat | `BugFixes.cpp:4155` | port | game | _ai_move_steps_closer / _cai_retargetTileFromFriendlyFire: multihex run/move/retarget as sfall (fallout2-ce#861) |
| 46 | Fix for multiple knockout events being added to the queue | `BugFixes.cpp:4169` | yes | game | SFALL note in _set_new_results |
| 47 | Fix for critter_state function when a critter in combat recovers from the knockout state outside its turn DAM_KNOCKOUT_WOKEN flag lets the function know that the critter was knocked out before it actually woke up (stand up) | `BugFixes.cpp:4172` | port | scripts | critter_wake_up marks a critter woken outside its turn (DAM_KNOCKOUT_WOKEN), critter_state reports it prone (fallout2-ce#846) |
| 48 | Fixes for knockout/down issues | `BugFixes.cpp:4177` | port | game | _dude_standup only from the prone frame; a critter woken during map_exit_p_proc stands at once (fallout2-ce#846) |
| 49 | Fix for "NPC turns into a container" bug | `BugFixes.cpp:4181` | port | game | knockoutClear leaves a knocked out critter knocked down and drops its wake up event; obj_load and party prep-load parts (fallout2-ce#846) |
| 50 | Fix for knocked down critters not playing stand up animation when the combat ends (when DAM_LOSE_TURN and DAM_KNOCKED_DOWN flags are set) | `BugFixes.cpp:4188` | port | game | _combat_over stands up knocked-down critters (fallout2-ce#846) |
| 51 | Fix to prevent dead NPCs from reloading their weapons when the combat ends | `BugFixes.cpp:4192` | yes | game | SFALL note in _combat_over |
| 52 | Fix crashes when killing critters with explosives | `BugFixes.cpp:4196` | yes | game | whoHitMe saved through objectPrepareWhoHitMeForSave (CE's own) |
| 53 | Fix for destroy_p_proc not being called if the critter is killed by explosives when you leave the map | `BugFixes.cpp:4199` | port | game | actionExplode without animation runs destroy_p_proc before critterKill (fallout2-ce#863) |
| 54 | Fix for being unable to sell used geiger counters or stealth boys | `BugFixes.cpp:4203` | port | game | item_queued returns the item, active Geiger counters/Stealth Boys in the offer turned off, OBJECT_QUEUED cleared on turn off (fallout2-ce#853) |
| 55 | Fix for incorrect initialization of action points at the beginning of each turn | `BugFixes.cpp:4211` | port | game | each critter gets its action points at its turn (fallout2-ce#850) |
| 56 | Fix for incorrect death animations being used when killing critters with kill_critter_type function | `BugFixes.cpp:4216` | yes | scripts | SFALL note in opKillCritterType (death animation) |
| 57 | Fix for checking the horizontal position on the y-axis instead of x when setting coordinates on the world map | `BugFixes.cpp:4221` | yes | game | wmAreaSetWorldPos checks x and y |
| 58 | Fix for display issues when calling gdialog_mod_barter with critters with no "Barter" flag set | `BugFixes.cpp:4229` | not checked | original screens | gdialog_mod_barter display with no Barter flag |
| 59 | Fix for items disappearing from inventory when you try to drag them to bag/backpack in the inventory list and are overloaded | `BugFixes.cpp:4237` | yes | original screens | SFALL note in _drop_into_container |
| 60 | Fix for the engine not checking player's inventory properly when putting items into the bag/backpack in the hands | `BugFixes.cpp:4240` | not checked | original screens | bag in hands: inventory check |
| 61 | Fix to ignore player's equipped items when opening bag/backpack | `BugFixes.cpp:4242` | not checked | original screens | bag/backpack ignores equipped items |
| 62 | Fix crash when trying to open bag/backpack on the table in the bartering interface | `BugFixes.cpp:4246` | yes | original screens | SFALL note (bag on barter table crash) |
| 63 | Fix crash when clicking on empty space in the inventory list opened by "Use Inventory Item On" (backpack) action icon | `BugFixes.cpp:4250` | yes | original screens | SFALL note (Use Inventory Item On crash) |
| 64 | Fix crash when clicking on empty space on the barter table after unloading multiple weapons | `BugFixes.cpp:4253` | not checked | original screens | barter table crash after unloading weapons |
| 65 | Fix item_count_ function returning incorrect value when there is a container-item inside | `BugFixes.cpp:4257` | yes | game | itemGetQuantity (see 18) |
| 66 | Fix for Sequence stat value not being printed correctly when using "print to file" option | `BugFixes.cpp:4260` | not checked | original screens | print to file: Sequence value |
| 67 | Fix for the incorrect object type search when loading a game saved in combat mode | `BugFixes.cpp:4263` | yes | game | SFALL notes in combatLoad |
| 68 | Fix for Bonus Move APs being replenished when you save and load the game in combat | `BugFixes.cpp:4267` | port | game | the turn resumed after loading keeps the saved free move points (fallout2-ce#851) |
| 69 | Fix for the displayed message when the attack randomly hits a target that is not a critter and has a script attached Tweak: if the main target has Flat flag set, display the "You missed" message instead of the message of hitting another object | `BugFixes.cpp:4274` | no? | game | _combat_display: no special message for a scripted non-critter main target |
| 70 | Fix for damage_p_proc being called for misses if the target is not a critter | `BugFixes.cpp:4278` | port | game | _apply_damage runs damage_p_proc of a non-critter target only on hits (fallout2-ce#865) |
| 71 | Fix for the double damage effect of Silent Death perk not being applied to critical hits | `BugFixes.cpp:4281` | yes | game | SFALL note in attackCompute (Silent Death) |
| 72 | Fix crash when calling partyMemberGetCurLevel_ on a critter that has no data in party.txt | `BugFixes.cpp:4288` | yes | game | partyMemberGetCurrentLevel returns 0 for unknown critters |
| 73 | Fix for player's base EMP DR not being properly initialized when creating a new character and then starting the game | `BugFixes.cpp:4291` | yes | game | SFALL note in _ResetPlayer |
| 74 | Fix for add_mult_objs_to_inven adding only 500 instances of an object when the "count" argument is over 99999 | `BugFixes.cpp:4294` | yes | scripts | no 500 cap in opAddMultipleObjectsToInventory |
| 75 | Fix for being at incorrect hex after map change when the exit hex in source map is at the same position as some exit hex in destination map | `BugFixes.cpp:4297` | **no** | game | objectSetLocation sets the exit grid transition while loading or entering a map (wrong hex after a map change; leaving the map after loading a game where the player died) |
| 76 | Fix for critters killed in combat by scripting still being able to move in their combat turn if the distance parameter in their AI packets is set to stay_close/charge, or NPCsTryToSpendExtraAP is enabled | `BugFixes.cpp:4301` | yes | game | aiFinishMovement clears AP of an incapacitated critter (SFALL note) |
| 77 | Fix instant death critical hits | `BugFixes.cpp:4309` | unclear | game | instant death criticals / knockback (CalcKnockbackMod); CE has sfall damage hooks in attackComputeDamage, not compared |
| 78 | Fix missing AC/DR mod stats when examining ammo in the barter screen | `BugFixes.cpp:4313` | yes | original screens | SFALL note in objectExamineFunc (ammo in barter) |
| 79 | Fix division by zero error in obj_examine_func_ engine function (when a critter's max HP <= 0 for any reason) | `BugFixes.cpp:4329` | yes | game | objectExamineFunc checks max/current HP <= 0 |
| 80 | Fix for obj_can_see_obj not checking if source and target objects are on the same elevation before calling is_within_perception_ | `BugFixes.cpp:4342` | yes | scripts | SFALL note in opObjectCanSeeObject |
| 81 | Fix broken obj_can_hear_obj function | `BugFixes.cpp:4347` | yes | scripts | SFALL note in opObjectCanHearObject (sfall: option, off by default) |
| 82 | Fix for the incorrect item being checked for the presence of weapon perks | `BugFixes.cpp:4359` | yes | game | SFALL notes in _ai_best_weapon |
| 83 | Fix for the encounter description being displayed in two lines instead of one | `BugFixes.cpp:4371` | not checked | original screens | encounter description on two lines |
| 84 | Fix for being unable to sell/give items in the barter screen when the player/party member is overloaded | `BugFixes.cpp:4376` | port | game | a table that weighs nothing always fits (fallout2-ce#854) |
| 85 | Fix for the underline position in the inventory display window when the item name is longer than one line | `BugFixes.cpp:4379` | yes | original screens | SFALL note in inventoryExamineItem |
| 86 | Fix for the exploit that allows you to gain excessive skill points from Tag! perk before leaving the character screen | `BugFixes.cpp:4382` | yes | game | tagSkill4LevelBase (sfall's Tag! fix) in character_editor.cc |
| 87 | Fix for ai_retrieve_object_ engine function not returning the requested object when there are different objects with the same ID | `BugFixes.cpp:4387` | port | game | _ai_retrieve_object looks for the object itself first, then by id (fallout2-ce#859) |
| 88 | Fix for the "mood" argument of start_gdialog function being ignored for talking heads | `BugFixes.cpp:4393` | sfall option, off (`Misc/StartGDialogFix=0`) | scripts | sfall StartGDialogFix=0 (off by default); CE has its own start_gdialog target note |
| 89 | Fix crash when calling start_gdialog outside of the talk_p_proc procedure for talking heads | `BugFixes.cpp:4398` | yes | scripts | SFALL note in opStartGameDialog |
| 90 | Fix for Heave Ho! perk increasing Strength stat above 10 when determining the maximum range of thrown weapons | `BugFixes.cpp:4403` | yes | game | SFALL note in weaponGetRange (Heave Ho!) |
| 91 | Fix for determine_to_hit_func_ engine function taking distance into account when called from determine_to_hit_no_range_ | `BugFixes.cpp:4407` | yes | game | SFALL note in attackDetermineToHit |
| 92 | Fix for chem_primary_desire values in party member AI packets not being saved correctly | `BugFixes.cpp:4436` | yes | game | aiPacketWrite writes each chem_primary_desire |
| 93 | Fix for config_get_values_ engine function not getting the last value in a list if the list has less than the requested number of values (for chem_primary_desire) | `BugFixes.cpp:4439` | yes | game | SFALL note in configGetIntList |
| 94 | Fix returned result value when the file is missing | `BugFixes.cpp:4443` | yes | game | SFALL note in fileReadInt32 |
| 95 | Fix and repurpose the unused called_shot/num_attack arguments of attack_complex function called_shot - additional damage when hitting the target num_attacks - the number of free action points on the first turn only | `BugFixes.cpp:4446` | sfall option, off (`Misc/AttackComplexFix=0`) | scripts | sfall AttackComplexFix=0 (off by default) |
| 96 | Fix setting result flags argument for the target | `BugFixes.cpp:4462` | **no** | scripts | opAttackComplex still needs both result flags equal (original bug) |
| 97 | Fix result flags for the attacker and the target when calling attack_complex function also set/unset the DAM_DEAD flag when changing the minimum/maximum damage to the target and fix minimum damage still being applied to the target when the attacker misses | `BugFixes.cpp:4466` | unclear | scripts | attack_complex result flags / DAM_DEAD in _combat_attack (CE has a SFALL note there, not compared) |
| 98 | Fix for critter_mod_skill taking a negative amount value as a positive | `BugFixes.cpp:4471` | yes | scripts | opCritterModifySkill uses signed amounts |
| 99 | Fix for script execution issues when calling critter_mod_skill in a loop | `BugFixes.cpp:4474` | yes | scripts | CE removed the unused return value |
| 100 | Fix crash when calling use_obj/use_obj_on_obj without using set_self in global scripts also change the behavior of use_obj_on_obj function if the object uses the item on itself, then another function is called (not a bug fix) | `BugFixes.cpp:4478` | port | scripts | fallout2-ce#840 (only the "on itself" part; the crash part is handled by a script error) |
| 101 | Fix pickup_obj/drop_obj/use_obj functions, change them to get pointer from script.self instead of script.target script.target contains an incorrect pointer, which may vary depending on the situations in the game | `BugFixes.cpp:4484` | **no** | scripts | opPickup/opDrop/opUseObject use script.target for ordinary scripts instead of self |
| 102 | Fix for critters not attacking the player in combat when loading a game saved in combat mode | `BugFixes.cpp:4494` | yes | game | CE doesn't call obj_fix_combat_cid_for_dude on load |
| 103 | Fix for the player's turn being skipped when loading a game saved in combat mode | `BugFixes.cpp:4497` | yes | game | _combat forces the dude's turn after loading in combat |
| 104 | Fix for the reserved item FRM being displayed in the top-left corner when in the loot/barter screens | `BugFixes.cpp:4500` | not checked | original screens | reserved item FRM in loot/barter screens |
| 105 | Fix the return value of has_skill function for incorrect skill numbers | `BugFixes.cpp:4503` | **no** | scripts | has_skill returns -5 for an invalid skill (sfall: 0) |
| 106 | Fix for NPC stuck in a loop of reloading melee/unarmed weapons or solar scorcher when out of ammo | `BugFixes.cpp:4506` | yes? | game | _ai_search_inven_weap checks ammo for the attack and AI ammo; melee/scorcher loop not compared |
| 107 | Fix for critters not being healed over time when entering a map with 'dead_bodies_age=No' set in maps.txt also fix the zero initialization of a local variable to correct time for removing corpses and blood | `BugFixes.cpp:4511` | port | game | _map_age_dead_critters heals the living critters before the dead_bodies_age check (fallout2-ce#848); the aging type is already 0-initialized in CE |
| 108 | Fix for the removal of party member's corpse when loading the map | `BugFixes.cpp:4518` | port | game | partyFixMultipleMembers keeps dead critters (fallout2-ce#847) |
| 109 | Fix for unexplored areas being revealed on the automap when entering a map | `BugFixes.cpp:4521` | **no** | game | objectSetLocation marks tiles seen while entering a map / loading (unexplored automap areas revealed) |
| 110 | Fix for the overflow of the automap tables when the number of maps in maps.txt is more than 160 also fix "out of bounds" bug when printing the automap list | `BugFixes.cpp:4524` | not checked | mods | automap tables with more than 160 maps in maps.txt |
| 111 | Fix for a duplicate obj_dude script being created when loading a saved game | `BugFixes.cpp:4530` | unclear | game | duplicate obj_dude script on load: CE's _obj_load_dude clears/sets the dude script; map_load_file part not compared |
| 112 | Fix for the start procedure not being called correctly if the required standard script procedure is missing | `BugFixes.cpp:4537` | yes | scripts | CE note in scriptExecProc |
| 113 | Fix the argument value of dialogue_reaction function | `BugFixes.cpp:4541` | **no** | scripts | opGameDialogReaction passes the raw value (sfall maps fidget 1-3/4/5+ to good/neutral/bad) |
| 114 | Fix for NPC stuck in a loop of picking up items in combat and the incorrect message being displayed when the NPC cannot pick up an item due to not enough space in the inventory | `BugFixes.cpp:4544` | port | game | objectPickup: an NPC in combat picks up regardless of weight, its own message when it can't (fallout2-ce#860) |
| 115 | Fix for anim_move_to_tile_ engine function ignoring the distance argument for the player | `BugFixes.cpp:4550` | port | game | the player's walk to a free tile stops at its distance (fallout2-ce#852) |
| 116 | Fix for the player's movement in combat being interrupted when trying to use objects with Bonus Move APs available | `BugFixes.cpp:4554` | port | game | walks to use objects and ladders count the free move points (fallout2-ce#852) |
| 117 | Fix for Scout perk being taken into account when setting the visibility of locations with mark_area_known function also fix the incorrect coordinates for small/medium location circles that the engine uses to highlight their sub-tiles and fix visited tiles on the world map being darkened again when a location is added next to them | `BugFixes.cpp:4564` | not checked | game | mark_area_known and the Scout perk / location circle coordinates |
| 118 | Fix the position of the destination marker for small/medium location circles | `BugFixes.cpp:4570` | not checked | game | destination marker position for small/medium circles (world map; our touch world map draws its own marker) |
| 119 | Fix to prevent using number keys to enter unvisited areas on a town map | `BugFixes.cpp:4573` | yes | game | SFALL note in wmTownMapFunc (number keys) |
| 120 | Fix for the "car outta gas" location being inaccessible when it is inside a town circle | `BugFixes.cpp:4579` | yes | game | wmMatchWorldPosToArea checks the car area first |
| 121 | Fix for combat not ending automatically when there are no hostile critters | `BugFixes.cpp:4583` | yes | game | _combat_should_end matches sfall's check (note there) |
| 122 | Fix for the car being lost when entering a location via the Town/World button and then leaving on foot (sets GVAR_CAR_PLACED_TILE (633) to -1 on exit to the world map) | `BugFixes.cpp:4587` | yes | game | SFALL note in wmWorldMapFunc (car placed tile) |
| 123 | Fix for the "Move_on_Car" engine variable not being reset when entering a location via the Town/World button | `BugFixes.cpp:4593` | not checked | game | Move_on_Car not reset when entering via Town/World button |
| 124 | Fix the placement of multihex critters in the player's party when entering a map or elevation | `BugFixes.cpp:4599` | port | game | _partyMemberSyncPosition: multihex members behind/in front of the dude with free tiles around (fallout2-ce#862) |
| 125 | Fix for critter_add/rm_trait functions ignoring the "amount" argument Note: pass negative amount values to critter_rm_trait to remove all ranks of the perk (vanilla behavior) | `BugFixes.cpp:4602` | **no** | scripts | opCritterAddTrait/RemoveTrait add or remove one rank, ignoring the amount |
| 126 | Fix to prevent corpses from blocking line of fire | `BugFixes.cpp:4607` | yes | game | SFALL notes in _obj_shoot_blocking_at |
| 127 | Fix for party member's equipped weapon being placed in the incorrect item slot after leveling up | `BugFixes.cpp:4614` | yes | game | SFALL note in _partyMemberCopyLevelInfo |
| 128 | Fix the playback of the speech sound file for the death screen | `BugFixes.cpp:4617` | yes | game | SFALL note in showDeath |
| 129 | Fix for trying to loot corpses with the "NoSteal" flag | `BugFixes.cpp:4620` | yes | game | SFALL note in actionLootCritter |
| 130 | Fix the music volume when entering the dialog | `BugFixes.cpp:4625` | yes | game | SFALL note in _gdialogInitFromScript |
| 131 | Fix for the barter button on the dialog window not animating until after leaving the barter screen | `BugFixes.cpp:4628` | not checked | original screens | barter button animation in the dialog window |
| 132 | Fix for the player's money not being displayed in the dialog window after leaving the barter/combat control interface | `BugFixes.cpp:4631` | yes | original screens | SFALL note in gameDialogTicker |
| 133 | Fix crash or animation glitch of the critter in combat when an explosion from explosives and the AI attack animation are performed simultaneously Note: all events in combat will occur before the AI (party member) attack | `BugFixes.cpp:4639` | not checked | game | explosion events run after the combat sequence (combat_hook) |
| 134 | Fix for the "Fill_W" flag in worldmap.txt not uncovering all tiles to the left edge of the world map | `BugFixes.cpp:4644` | not checked | game | Fill_W in worldmap.txt (left edge) |
| 135 | Fix the code in combat_is_shot_blocked_ to correctly get the next tile from a multihex object instead of the previous object or source tile Note: this bug does not cause any noticeable error in the function | `BugFixes.cpp:4649` | yes | game | SFALL note in _combat_is_shot_blocked |
| 136 | Fix for NPC stuck in an animation loop in combat when trying to move close to a multihex critter this prevents moving to the multihex critter when the critters are close together | `BugFixes.cpp:4662` | not checked | game | NPC animation loop moving next to a multihex critter (distance check in _ai_move_steps_closer) |
| 137 | Fix to prevent the execution of critter_p_proc and game events when playing movies (same as when the dialog is active) | `BugFixes.cpp:4680` | yes | game | SFALL note in _doBkProcesses |
| 138 | Fix to prevent the player from leaving the map when the death animation causes the player to cross an exit grid (e.g. fire dance or knockback animation) | `BugFixes.cpp:4683` | partly | game | CE has its own fire dance exit grid fix (actions.cc); the knockback/death move part not compared |
| 139 | Fix to limit the maximum distance for the knockback animation | `BugFixes.cpp:4688` | yes | game | SFALL note in actionKnockdown |
| 140 | Fix for combat_is_shot_blocked_ engine function not taking the flags of critters in the line of fire into account when calculating the hit chance penalty of ranged attacks in determine_to_hit_func_ engine function | `BugFixes.cpp:4691` | yes | game | SFALL note in _combat_is_shot_blocked |
| 141 | Fix broken Print() script function | `BugFixes.cpp:4696` | yes | scripts | SFALL note in opPrint |
| 142 | Fix for the flags of non-door objects being set/unset when using obj_close/open functions | `BugFixes.cpp:4699` | yes | scripts | SFALL notes in _check_door_state |
| 143 | Fix for the "Leave" event procedure of the window region not being triggered when the cursor moves to a non-scripted window | `BugFixes.cpp:4703` | not checked | scripts | window region Leave event (sfall script windows) |
| 144 | Fix for the window with the "DontMoveTop" flag not being redrawn after the show function call if it is not the topmost one | `BugFixes.cpp:4707` | yes | scripts | SFALL note in windowShow |
| 145 | Fix for the script attached to an object not being initialized properly upon object creation | `BugFixes.cpp:4710` | sfall option, off (`Misc/CreateObjectSidFix=0`) | scripts | sfall CreateObjectSidFix=0 (off by default) |
| 146 | Fix the error handling in create_object_sid function to prevent a crash when the proto is missing | `BugFixes.cpp:4713` | yes | scripts | SFALL note in opCreateObject (missing proto) |
| 147 | Fix to allow creating an object with no script correctly when passing 0 as the script index number (also prevent a crash) | `BugFixes.cpp:4715` | **no** | scripts | opCreateObject: script index 0 isn't "no script" |
| 148 | Fix to prevent the main menu music from stopping when entering the load game screen | `BugFixes.cpp:4718` | not checked | original screens | main menu music stops entering the load screen (touch build has its own main menu) |
| 149 | Fix for the main menu music not stopping when replaying the intro | `BugFixes.cpp:4720` | not checked | original screens | main menu music when replaying the intro |
| 150 | Fix incorrect value of the limit number of floating messages | `BugFixes.cpp:4723` | yes | game | SFALL note in textObjectAdd |
| 151 | Fix for being unable to plant items on non-biped critters with the "Barter" flag set (e.g. Skynet and Goris) | `BugFixes.cpp:4726` | yes | game | SFALL note in itemAttemptAdd |
| 152 | Fix for being able to use the "Push" action on members of the player's team in combat when they are knocked down | `BugFixes.cpp:4729` | **no** | game | actionCheckPush: a knocked-down team member can be pushed in combat (critterIsActive doesn't check knocked down) |
| 153 | Fix for float_msg function not setting the purple or black text color correctly (was always grey) | `BugFixes.cpp:4732` | yes | scripts | opFloatMessage has distinct black and purple colors |
| 154 | Fix for incorrect death endings being shown when some endings in the list are not available | `BugFixes.cpp:4738` | not checked | game | death endings when some aren't available |
| 155 | Fix for gaining two levels at once when leveling up from level 97 | `BugFixes.cpp:4741` | yes | game | pcGetExperienceForLevel bounds by the maximum level |
| 156 | Fix for xp being reset to 0 when selecting Here and Now perk at the maximum player level | `BugFixes.cpp:4744` | yes | game | perkAddEffect: Here and Now at the maximum level gives 0 xp |
| 157 | Fix to prevent integer overflow for the number of items in a stack in the inventory If the number of items in a stack is less than 1, it is considered an integer overflow | `BugFixes.cpp:4747` | not checked | game | stack count overflow (item_add_force/remove_mult/caps) |
| 158 | Fix for clickability issue of the "Use Inventory Item On" action when the selected item overlaps an object | `BugFixes.cpp:4766` | not checked | original screens | "Use Inventory Item On" clickability over objects (mouse) |
| 159 | Fix for using_skill function returning garbage values when the arguments are not the player and SKILL_SNEAK | `BugFixes.cpp:4770` | yes | scripts | opUsingSkill initializes the result (NOTE there) |
| 160 | Fix for object_fix_weapon_ammo_ engine function not checking "misc" type items | `BugFixes.cpp:4773` | **no** | game | _object_fix_weapon_ammo checks the object type MISC instead of the item type |
| 161 | Fix to prevent the windows of Tag! and Mutate! perks from reappearing when there are still unused perks | `BugFixes.cpp:4777` | not checked | original screens | Tag!/Mutate! windows reappearing |
| 162 | Fix to prevent the game from hanging when reloading a weapon overloaded with ammo via the interface bar | `BugFixes.cpp:4782` | not checked | game | reloading a weapon overloaded with ammo via the interface bar hangs |
| 163 | Fix for the incorrect message being displayed when attempting to repair a dead robot | `BugFixes.cpp:4786` | yes | game | skillUse uses message 601 for a dead robot |
| 164 | Fix to prevent out-of-bounds selection in the file list when loading a character file | `BugFixes.cpp:4789` | not checked | original screens | character file list out of bounds |
| 165 | Fix for the duplicate click sound for the "Done" button in the "Move Items" and "Set Timer" windows | `BugFixes.cpp:4792` | not checked | original screens | duplicate click sound in Move Items / Set Timer |
| 166 | Fix crash when a critter with a powered melee/unarmed weapon runs out of ammo and there is ammo nearby | `BugFixes.cpp:4795` | not checked | game | crash: powered melee/unarmed weapon out of ammo with ammo nearby |
| 167 | Fix crash when an encounter between two groups fighting each other fails to spawn one group | `BugFixes.cpp:4798` | not checked | game | crash: encounter of two fighting groups when one fails to spawn |
| 168 | Fix incorrect upper limit in mouse_set_sensitivity_ engine function | `BugFixes.cpp:4801` | n/a | platform | mouse sensitivity limit (touch build) |
| 169 | Fix for getting stuck on an empty map when the encounter table has no available entries | `BugFixes.cpp:4805` | yes | game | CE note in wmRndEncounterPick (empty encounter table) |
| 170 | Fix crash when calling proto_data with an invalid data member value | `BugFixes.cpp:4809` | yes | scripts | opGetProtoData pushes 0 for unknown members |
| 171 | Fix potential index out of bounds error in wmMapIdxToName_ engine function | `BugFixes.cpp:4812` | yes | game | wmMapIdxToName checks the index |
| 172 | Fix for the morning starting at 6:01 instead of 6:00 while traveling on the world map | `BugFixes.cpp:4816` | yes | game | CE note in wmRndEncounterOccurred (day starts at 6:00) |
| 173 | Fix typo in debug output from gsound_load_sound_ engine function | `BugFixes.cpp:4819` | n/a | debug | typo in a debug message |
| 174 | Fix memory leaks related to party members during map transitions | `BugFixes.cpp:4822` | not checked | game | party member memory leaks during map transitions |
| 175 | Fix memory leak involving global variables on game load | `BugFixes.cpp:4829` | yes | game | gameReset resets sfall globals (SFALL notes) |
| 176 | Fix for the cursor getting stuck in view scrolling mode upon entering an encounter | `BugFixes.cpp:4835` | n/a | platform | cursor stuck in view scrolling mode (mouse) |
| 177 | Fix the visibility check in tile_is_visible function The original code forms a broad cross-shaped visibility region spanning the entire map width | `BugFixes.cpp:4838` | yes | scripts | tileIsVisible uses the visible map rect (CE's own) |
| 178 | Fix to prevent overflow when the AI calculates distance for its actions | `BugFixes.cpp:4842` | yes | game | tileDistanceBetween is bounded and validates tiles |
| 179 | Fix missing combat xp and NPCs not reloading weapons when ending combat via elevation change with 0 AP left | `BugFixes.cpp:4845` | yes | game | _combat_over gives xp and reloads for NONE and END_COMBAT (same as sfall's <= 1) |
| 180 | Fix for the entire stack of flares being lit instead of just one when using the stack on scenery or a critter | `BugFixes.cpp:4848` | yes | game | CE note in _obj_use_flare (one flare off a stack) |
| 181 | Critical hit table fixes (`OverrideCriticalTable=2`, the default) | `Criticals.cpp:282` | port | game | CE applies sfall's 2020 set at start (criticalsInit, OverrideCriticalTable=2); sfall's later corrections (right arm messages 2023-12, super mutants 2024-02) ported, see sfall-fixes-carried.md |
| 182 | Fix/tweak for party control | `CritterPoison.cpp:127` | n/a | mods | poison/radiation tweak for sfall's party control |
| 183 | Fix to prevent crashes when there is a '%' character in the printed message | `DebugEditor.cpp:552` | n/a | debug | '%' in debug messages |
| 184 | Fix the format of some debug messages | `DebugEditor.cpp:563` | n/a | debug | debug message format |
| 185 | Fix crash if the filename contains a '%' character (relevant to SFX files) xfopen_ - remove sprintf_ function calls that do nothing (probably just checking the filename for the '%' formatting char?) | `FileSystem.cpp:795` | yes? | game | xfileOpen builds paths without sprintf of the file name |
| 186 | Fix file seeking in uncompressed database files | `FileSystem.cpp:800` | not checked | game | seeking in uncompressed .dat entries |
| 187 | Fixes missing console critical hit messages when PC is attacked. (combat_get_loc_name_) | `HeroAppearance.cpp:1516` | n/a | mods | PC critical messages with Hero Appearance mod critters |
| 188 | Fix images for up/down buttons | `Interface.cpp:901` | sfall option, off (`Misc/WorldMapCitiesListFix=0`) | original screens | sfall WorldMapCitiesListFix=0 (off by default) |
| 189 | Fix for slightly misaligned buttons in the pipboy | `Interface.cpp:1250` | not checked | original screens | Pip-Boy button alignment |
| 190 | Fix for slightly misaligned buttons in the character screen | `Interface.cpp:1254` | not checked | original screens | character screen button alignment |
| 191 | Fix for slightly misaligned buttons in the barter screens | `Interface.cpp:1259` | not checked | original screens | barter screen button alignment |
| 192 | Fix for minor visual glitch when examining items in the inventory (display_stats_, inven_obj_examine_func_) | `Interface.cpp:1269` | not checked | original screens | inventory examine visual glitch |
| 193 | Fix for minor visual glitch when selecting perks that modify SPECIAL stats | `Interface.cpp:1273` | not checked | original screens | perks modifying SPECIAL visual glitch |
| 194 | Fix for minor visual glitch when cycling through information cards (DrawInfoWin_, folder_scroll_) | `Interface.cpp:1276` | not checked | original screens | information cards visual glitch |
| 195 | Fix for minor visual glitch when adjusting SPECIAL stats during character creation | `Interface.cpp:1280` | not checked | original screens | SPECIAL adjust visual glitch |
| 196 | Fix missing sounds for the SPECIAL stat +/- buttons in the character creation screen | `Interface.cpp:1283` | not checked | original screens | SPECIAL +/- button sounds in character creation |
| 197 | Fix for interface windows with 'Transparent', 'Hidden' and 'ScriptWindow' flags Transparent/Hidden - will not toggle the mouse cursor when the cursor hovers over a transparent/hidden window ScriptWindow - prevents the player from moving when clicking on the window if the 'Transparent' flag is not set | `Interface.cpp:1577` | n/a | platform | mouse cursor over transparent/script windows |
| 198 | Fix crash when the player equips a weapon overloaded with ammo (ammo bar overflow) | `Interface.cpp:1586` | yes | original screens | _intface_update_ammo_lights clamps the ratio |
| 199 | Fix the +/- keys not updating the brightness slider when used on the Preferences screen | `Interface.cpp:1599` | not checked | original screens | +/- keys and the brightness slider |
| 200 | Fix for invenWieldFunc_ (used by wield_obj_critter) to be able to put non-weapon/armor items into active slot | `Inventory.cpp:963` | yes? | scripts | inventoryEquipFunc has no weapon-only restriction (armor goes to the armor slot, anything else to a hand) |
| 201 | Fix getting distance from source to target when using skills Note: this will cause the party member to perform First Aid/Doctor skills when you use them on the player, but only if the player is standing next to the party member. Because the related engine function is not fully implemented, enabling this option without a global script that overrides First Aid/Doctor functions has very limited usefulness | `MiscPatches.cpp:790` | sfall option, off (`Misc/PartyMemberSkillFix=0`) | game | sfall PartyMemberSkillFix=0 (off by default) |
| 202 | Fix the ID range check for item objects with IDs in the negative range Special ID values are assigned in the negative range | `Objects.cpp:387` | not checked | game | negative item IDs in _partyMemberItemSave |
| 203 | Fix mapper bug by reassigning object IDs to critters (for unvisited maps) | `Objects.cpp:393` | not checked | game | object IDs of critters on unvisited maps (mapper bug) and queued events |
| 204 | Fix crash when the quest list is too long | `QuestList.cpp:56` | not checked | original screens | crash with a too long quest list (Pip-Boy) |
| 205 | Fix map lighting from Night Vision perk when loading a saved game | `ScriptExtender.cpp:528` | not checked | game | Night Vision lighting after loading a game |
| 206 | Fix for missing lipsync when switching from a talking head without lipsync FRMs to one with them | `TalkingHeads.cpp:305` | sfall option, off (`Graphics/Use32BitHeadGraphics=0`) | original screens | sfall Use32BitHeadGraphics (off by default) |
| 207 | Fix the starting position of the player's marker on the world map when starting a new game also initialize the value of the current area for METARULE_CURRENT_TOWN metarule function | `Worldmap.cpp:277` | yes | game | SFALL note in _main_load_new (world map marker) |
