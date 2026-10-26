# Permanent local storage: stages 3–5

Resources, user data and the future application cache have separate owners.
There is no service worker yet. Stage 4 connects durable checkpoints to engine
save/settings success; physical device acceptance is described in saves-test.md.

## Resource format

`resource-store.js` owns IndexedDB `fallout2-device-check-v1`, **database version 2**.
The historical name deliberately preserves the installed stage-2 data on the
same origin. Logical format 1 declares minReader/minWriter 1. An unsupported
database or logical format fails without resetting the user's data.

| Store | Contents |
| --- | --- |
| state | Format declaration, active/previous generation IDs, collection marker |
| generations | Staging or completed manifests: paths/sizes, manifest SHA-256, measurements |
| refs | `[generation, canonical path, block index]` -> SHA-256 and exact block size |
| chunks | SHA-256 -> immutable bytes, at most 256 KiB |
| meta / blocks | Legacy v1 data, emptied only by successful migration or explicit resource clear |

Paths are NFC, relative, slash-separated and case insensitive. Reject traversal,
drive/absolute/control paths, file/directory collisions and duplicate aliases.
Required nonempty master.dat/critter.dat remain part of every full manifest.

Writes require a staging generation. Activation checks the complete reference
layout and chunk existence, seals the file manifest and switches the active ID
in one transaction. Activation reads chunk keys, **not all payloads into RAM**.
Read/write transactions request strict durability; quota or abort errors reject.

Unchanged chunks are shared across generations, including large DATs. Collection
keeps active and one previous completed generation, removes abandoned staging,
then marks referenced hashes and deletes only unreferenced chunks. A persistent
dirty marker avoids scanning all references on every cold open; interruption
leaves collection retryable. It never touches the user filesystem.

## Safe ZIP replacement

Stage 5 uses `zip-import.js` and the pinned, vendored zip.js 2.24.0 inside a
dedicated worker. Inspecting a ZIP produces a review plan without replacing the
active generation. The plan pins the installation ID; it expires if another
client changes that installation. A worker-held Blob is disposed on rejection,
cancel, another archive selection or page shutdown. No resource lease is held
while the user reviews a plan; installation reacquires exclusive ownership.

The parser accepts Store/Deflate and ZIP64, strict UTF-8 or legacy CP866 names.
It rejects encryption, links/special files, invalid paths, NFC/case aliases,
file/directory collisions and malformed local/central metadata. A unique game
at the shallowest root wins, matching Android. Engine ce.dat, SAVEGAME, session
map state and known platform/temporary files are excluded. This is a full game
replacement, not an incremental mod merge or mod compatibility check.

Limits: 12 GiB archive, 10 GiB declared unpacked data, 50,000 entries,
16 MiB directory metadata/read allocation, 240 UTF-8 bytes/32 components per
selected game path. Actual output lengths and CRC are checked while extracting.
All selected entries must finish successfully before activation. Directory
inspection alone does not verify their CRC or prove valid Fallout DAT contents.

Extraction groups 256 KiB blocks into at most 1 MiB/64-block batches, including
blocks from small files. Each batch is hashed before one strict transaction;
only missing content hashes are inserted. These are application buffer limits,
not a measurement of peak browser memory or browser-internal disk overhead.
The conservative storage estimate reserves 110% of selected bytes + 16 MiB,
even when deduplication might need much less. It is not an exact quota guarantee;
real transaction quota errors also abort and preserve the old active generation.

Cancellation is allowed through extraction and final batch flush. An explicit
commit barrier then ends cancellation before atomic activation. Cleanup after
that point is retryable and cannot turn a committed installation into a reported
failure. Failed cleanup on reopen does not block reading a validated active
manifest. Abandoned staging remains inactive and is collected on a later open.
Neither replacement nor cancellation writes the separate user database.

The technical report records transaction counts, hashing/write time, new/reused
bytes, small/large entry timings and bounded progress samples. Small-file timing
includes any shared batch flush it triggers; it is not isolated disk profiling.
These measurements can distinguish bottlenecks on a phone without inferring
Redmi behavior from a Mac simulation. See [import-test.md](import-test.md).

## Migration and ownership

Every store handle holds an exclusive Web Lock. The historical lock name is
also retained, so old stage-2 sessions cannot overlap an upgrade. A second game,
importer or cleaner receives a close-other-window error. Release happens on
explicit close/pagehide, and the browser releases locks after process termination.
BFCache restoration reloads the local launcher before accessing a closed handle.

Upgrade adds stores, without deleting the v1 payload. Migration verifies old
block hashes and atomically moves each batch (default eight blocks, 2 MiB) to
chunks/refs while deleting the corresponding old rows. Committed references are
the checkpoint; unfinished old rows are resumed after interruption. Only the
completed manifest becomes active. Installation ID and original timestamp survive.
No second complete DAT or ZIP extraction is required. Browser internal temporary
disk use and peak Safari RAM are not inferred from the batch size.

An old writer opening DB version 1 gets VersionError after upgrade. Blocked
upgrades ask the user to close old windows. A corrupted migration fails rather
than activating bad data; explicit resource clear uses maintenance mode and can
remove such a failed installation. A new app cannot automatically downgrade
unknown future formats. Original files remain available in the user's ZIP.

## Reading and the writable view

GameFS reads ranges through Asyncify and checks each loaded block's length/hash.
Its LRU limit is 64 MiB. A large fd_read copies successive blocks into the WASM
destination before eviction; it does not preload the entire request into JS.
Missing/corrupt storage returns EIO (or a valid partial read), never fake zeros.

`/game` is a writable session view. Initial config copies are bounded (2 MiB
per file, 8 MiB total); other resources are lazy nodes. Truncating/replacing or
unlinking a node changes only this view, never the resource DB. Unsupported
in-place writes into an unmaterialized resource fail. Actual engine working
automap and config files are ordinary writable nodes. Installed loose prototype
files may be overwritten/deleted in the view and are restored from resources
on the next engine launch.

`working-files.js` restores the IDBFS-compatible store at
`/fallout2-ce-mobile-userdata` before the engine starts, using a separate
database of that name (SDK layout version 21). Application marker 1 upgrades
to 2 at a whole checkpoint; unsupported formats are preserved and rejected.

The working mount has no auto-sync: Asyncify fd_sync would otherwise call
mount.syncfs during unfinished catalog writes. `user-filesystem.js` retains the
pinned IDBFS restore/layout and explicitly checkpoints changed files, directories
and removals in one strict readwrite transaction after the full user operation.
Neither FS.syncfs nor the SDK is patched. Inode/revision tracking handles writes
with identical timestamps. Every request error aborts, and completion is awaited.
pagehide closes the owner and aborts active writes; deferred writes cannot start
after releasing the resource lease. Normal exit removes listeners for old engines.

| Kind | Engine examples | Lifetime / destination |
| --- | --- | --- |
| Installed resources | DAT, scripts, art, loose PRO, original configs | Immutable resource DB; source for a fresh view |
| Save slots/catalog | SAVEGAME slots, previews, ce.sav, sfallgv.sav, slotdat.ini, staging/backup/metadata | User IDBFS/savegame; all aliases use one filesystem for rename |
| Settings | fallout2.cfg, ddraw.ini, data/config/game.cfg, game#patch.cfg | Writable view; captured in the same checkpoint; restored mirror takes priority over installed defaults |
| Working state | MAPS/*.SAV, MAPS/AUTOMAP.DB, working PROTO, generated mod order | Current engine session; saved copies inside a slot are user data |
| Temporary/debug | config .tmp, .bak, logs, debug worldmap output | Session only; never import as settings/save state |
| Exports | character .gcd/.bio, screenshots and character text reports | Session output; explicit export UX still pending |

SAVEGAME is linked to the user mount at the root and configured master/critter
patch directories. Existing saved settings are restored before resolving those
aliases. Root config files are copied, not symlinked: atomic temp-file/rename
updates must not replace a symlink and silently break persistence. C++ checkpoints
follow full slot/catalog/records/compatibility operations or explicit settings
Apply. User-root port records store the original text metadata format.
An error restores the durable user view and catalog; a later settings checkpoint
cannot persist a failed slot. No per-file autosave or unload save is used.

Normal development `?dev=1` sessions keep temporary files and never mount the
real user store or write the original Mac game folder.

## Verification and phone acceptance

Run Node 24+ tests after npm ci. Python discovery also runs a tiny real WASM
fixture using the production GameFS, IDBFS and mountGame; the SDK is required.
This uses synthetic data, not a Mac gameplay/phone-performance simulation.

On the **same address and Home Screen installation** as the old imported game:

1. Close other game windows; open the existing icon while online. Allow migration
   to finish. Do not press resource clear or choose a new ZIP.
2. Run local read and copy the report: test=fallout2-stage3, databaseVersion=2,
   format=1; the installation ID should match the previous report.
3. Launch the game, start a new game and reach the first playable location;
   move/open inventory. Return to main menu and Exit to the launcher.
4. Fully close/reopen the app, repeat local read. With the technical page open,
   disable networking and repeat read, then restore networking.

Common storage acceptance passed on Redmi 15C / Android 16 / Yandex Browser
26.8.7.49.00: DB v2/format 1, game launch and resource retention after reopening,
24 verified reads (6 MiB). This permits proceeding to stage 4; it is not a
separate Google Chrome test. The user also confirmed finding the existing game
without another ZIP and waiting for conversion: physical migration is accepted
on this Android browser; no pre-migration raw manifest was supplied. The complete RPU run and
v1 migration on a physical iPhone remain pending, grouped with later iPhone
checks before beta rather than required after every implementation stage.
Stage 4 passed the save/settings device test on Redmi 15C in Chrome PWA
(five slots, 19 settings files, records, successful real loads/relaunches);
cold offline app loading is stage 8. Current temporary
tunnel URLs may change between sessions: a different origin has a different DB.
Use the installed icon's original origin to test migration. A fresh origin can
only test a fresh import and must not be reported as successful v1 migration.

Stage5 was accepted on Redmi15C / Chrome PWA (5009c4e6): user-confirmed bad ZIP,
cancellation/process termination and replacement with preserved save/settings;
before/after reports show unchanged five slots/19 settings/records and verified
range probes, with a new active generation. The replacement reused all blocks.
Its slow small-file tail remains unisolated; timed SHA/write account for only
3.66% of extraction. This is not a fresh-import performance comparison. iPhone
regression is pending as a grouped check. See import-test.md for acceptance.

## Stage 6: mod composition and save exchange

`zip-import.js` accepts either a full installation or a prepared complete mod
set over an existing installation. It preserves master.dat/critter.dat,
patch000.dat and original music paths for mods-only replacement, plus the old
fallout2.cfg when none is provided. Everything else absent from the selected
mod set is removed in the new composition. `resource-store.inherit` copies
reference metadata under the same lease/strict transaction; DAT payloads are
not copied or decompressed. The source must still be the active generation.
Activation validates the combined inherited/new reference layout. Existing
resource/user format versions do not change.

Preflight reports the configured language, DAT mod names, loose logic presence,
file changes, retained base count and embedded saves. Mod versions and game
compatibility are not inferred from ZIP filenames. Embedded saves are offered
as a separate explicit operation after resource activation, scoped to the
selected game root. Failing that operation does not overwrite existing saves.

The mounted view repairs absolute/traversing PC system/music paths in
fallout2.cfg. New system/language values take priority; other saved player
settings are merged. `port/settings-sources.json` records hashes of original
config templates at a checkpoint. A saved mod config is restored only if its
source template is unchanged; removed/changed config templates use new mod
defaults. Legacy installations without this provenance retain their settings
on an ordinary launch; the first explicit replacement uses new mod defaults.
The resource bytes themselves are not rewritten by this mount operation.

`save-exchange.js` reads/writes the existing IDBFS v21 FILE_DATA layout without
adding stores. Save import holds the resource writer lease during inspection
and review, bounds decoded payloads to128 MiB total/32 MiB per file, verifies
CRC/headers, skips native FNV-identity duplicates and selects free manual slots
outside the quick-save range (including the sfall fallback). Orphan occupied
slot folders are not overwritten. All slot files, directories, format marker
and five-field native records commit in one strict transaction. Cancellation
before commit, quota and async request errors preserve the old rows. Unknown
user schema/format versions fail without reset. A closed worker cannot leave
part of that transaction committed.

Exports support selected whole slots and preserve native SAVEGAME/SLOTnn files
and fallout2-saves.txt metadata, including quick flags and known compositions.
PC saves without metadata stay unknown and use their header chronology, not a
fabricated creation timestamp. Imported quick saves become ordinary added saves,
matching Android's add mode. Export uses bounded Store ZIP entries with headers
compatible with Java/Android/ordinary PC ZIP tools. No destructive replace-all
save mode is exposed. Large libraries can be exported as several selected sets;
a single over-limit slot/file remains unsupported.

The in-game web Files actions request an orderly engine exit and only then open
the file manager. No manager writes alongside a live engine. Android keeps its
existing lifecycle; only its import-screen font selection changes (Classic by
default, saved [touch] font=1 selects PT Mono). Both fonts/licenses are local.
See rpu-saves-test.md for physical acceptance; current automated fixtures do not
prove loading arbitrary real RPU saves or every mod version on a phone.
