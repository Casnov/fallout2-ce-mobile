# Mobile web build

This is the port's normal wasm32/Asyncify target. It builds the current
working tree directly, including the mobile UI, with no source copy or
private patch. `web-dist` packages the engine, a newly generated `ce.dat`,
launcher, local fonts/licenses, and `build-info.json` with one version and
asset sizes/SHA-256 hashes. Original Fallout files are never packaged.

Local ZIP installation and Home Screen launch work in the technical check.
Durable save/settings completion passed physical acceptance on Redmi 15C in
Chrome PWA; the iPhone regression remains grouped for later.
The format-3 save implementation is a separate candidate pending the early
iPhone large-file handoff check. Cold offline startup and safe updates remain
subsequent work. See [save-storage.md](save-storage.md). The development game adapter reads a local folder through the
local development server; changes and saves in this session exist only in WASM
memory and disappear on reload. It does not read or alter the folder's saves.

Current device work prioritizes iPhone/Safari and Home Screen use. Android web
compatibility is secondary: Redmi audio crackle and the Yandex Keyboard's
Enter/Done action remain known, deferred issues. Google Keyboard completion was
confirmed on a phone; desktop browser checks do not establish a fix for either
Android issue. These issues do not block implementing local installation, saves
and offline startup for iPhone.

## Build

On macOS/Linux: Python 3.10+, CMake, Ninja and Emscripten **4.0.4**. The
compiler version is pinned in `emscripten-version.txt` and checked by the
build command. A native compiler builds the existing `ce-dat-tool` first.

With the SDK installed:

```sh
python3 os/web/build.py --emsdk /absolute/path/to/emsdk
```

Or activate the SDK in your shell and run `python3 os/web/build.py`.
Output: `out/web/dist/`. This is the complete static app directory.
Release uses `-O2` for compilation and linking, including optimization of the
Asyncify-instrumented module; `-O1` is only suitable for faster iteration.
The command runs the native tool build, web configure/build and package
verification. A failed packaging operation leaves the previous bundle intact.

Install the SDK from its official source if needed:

```sh
git clone --depth 1 https://github.com/emscripten-core/emsdk.git out/web/emsdk
python3 out/web/emsdk/emsdk.py install 4.0.4
python3 out/web/emsdk/emsdk.py activate 4.0.4
```

Use Python 3.10+ for these commands too. macOS's `/usr/bin/python3` can be
older; select an already installed newer interpreter explicitly.

Options:

- `--dat-tool /path/to/ce-dat-tool`: reuse a native tool instead of building it.
- `--app-version VERSION`: set the same version in About and build-info;
  the default is `git describe --tags --always --dirty`, or `development`
  for a source archive without Git metadata.
- `--jobs 4`, `--build-dir PATH`, `--output PATH`.
- `--diagnostics`: enable the engine's touch/action diagnostics.

The supported build uses Emscripten's official CMake toolchain via `emcmake`.
`OPTION_WASM_64` and `OPTION_WASM_JSPI` are rejected: the current file-read
bridge requires wasm32 and Asyncify. Resource cache: 256 KiB blocks, 64 MiB
LRU, inherited as initial measurement values from the prototype.

## Run locally

Serve the app alone:

```sh
python3 os/web/serve.py
```

For a playable development session, provide your own existing game folder,
optionally with RPU already installed:

```sh
python3 os/web/serve.py --game /absolute/path/to/your/Fallout2
```

Open the printed URL. `?dev=1` explicitly enables the local development
adapter; `&mouse=1` lets a mouse act as a finger for desktop debugging.
Real mobile touch is the default input path. A phone-like viewport can be
selected in browser developer tools. By default the server binds only to 127.0.0.1.

The game folder is never copied into `dist` or modified by the server.
Reads use HTTP byte ranges on demand; the whole DAT is not loaded into RAM.
The folder's `ce.dat` and SAVEGAME are excluded; the app uses its own
freshly packed `ce.dat`. This development path needs the local server and
does not demonstrate offline play. The future installed resource backend
will implement the same range-reader contract using local browser storage.

For a phone on the same Wi-Fi, use `--lan`. On a Mac this chooses the Wi-Fi
interface's private IPv4 address. Each LAN session gets a new random URL
path; share that complete URL only with the tester. The server refuses
public and wildcard bind addresses and rejects unrelated Host headers.
LAN mode defaults to real touch; append `&mouse=1` only for a desktop check.
Start in landscape on a phone. The launcher blocks starting in portrait.

```sh
/usr/bin/python3 os/web/serve.py --lan --game /absolute/path/to/your/Fallout2 --port 18765
```

The server alone supports Python 3.9+ (including the system Python on this
Mac); the build still needs Python 3.10+. `--listen 192.168.1.10` explicitly
selects a private address instead of auto-detection. The Mac must stay awake.
Stop with Ctrl+C. `--verbose` logs each resource request; by default only
errors are logged. No router port forwarding, public tunnel or device
certificate is needed. This HTTP test checks the engine and touch input;
HTTPS, Home Screen behavior and offline startup are separate checks.
See [the iPhone test instructions](iphone-test.md).

`--port 8091` selects another port. `--base-path /preview/` exercises hosting
under a project subdirectory; all app asset paths are relative. Runtime
inspection on the explicit dev path: `window.falloutDev.stats()` and
`window.falloutDev.module.FS`. No original game path is written into the bundle.

The development build also exposes `falloutDev.audio()` (context state and
latency) and `falloutDev.geometry()` (CSS/backing-store and SDL dimensions).
Play unlocks one AudioContext synchronously and shares it with SDL. The web
audio buffer is 2048 frames to tolerate more main-thread jitter; sustained
mobile audio performance still needs device testing.
For a local phone audio test, add `&stats=1` to the dev URL. An optional
non-interactive overlay shows context state, sample rate, buffer size,
callback gap, callback work time and late callbacks over the last five seconds,
plus lifetime maxima. A late callback is an interval over 1.5 buffer periods. It observes the existing
SDL callback without changing PCM or routing; it is off on the normal URL.
The stats session also enables the existing per-second engine frame monitor
in its temporary MEMFS config. The overlay shows FPS and UI/present times;
`falloutDev.frameTiming()` exposes the frame measurements and `perf.log` stays
in the browser. Timing is available as `falloutDev.audioTiming()` when enabled. Callback gaps
are diagnostic observations, not hardware underrun counters.
These observations stay in the browser; the read-only server does not collect
phone audio telemetry. The launcher displays a short hash covering all packaged
assets, so frontend-only changes also distinguish phone test bundles.
The web mixer feeds SDL small PCM blocks rather than individual frames; the
native mixer is unchanged. This reduces conversion overhead but cannot prevent
all main-thread stalls in the current ScriptProcessor backend.

Character names and mobile save descriptions use a native HTML text field
over the game's field. Selection, paste, deletion and composition remain
browser-native; the engine still validates the game's charset and length.
The single-line field belongs to an HTML form: a native IME Done/Enter submit
accepts the final DOM value, dismisses the keyboard and finishes the game field.
Hardware Enter and beforeinput line-break actions use the same bridge. IME
candidate confirmation and merely dismissing the keyboard do not accept text.
If automatic keyboard focus is refused on iOS, tap the visible field itself.
The viewport requests keyboard overlay. On coarse-pointer devices, a fallback
keeps the pre-keyboard canvas dimensions until the keyboard closes; desktop
resizing and device rotation remain available.
Legacy game/mod dialogs are not covered by this MUI field integration yet.
After startup, canvas keeps the game's aspect ratio and fits the available
viewport uniformly. Browser chrome/orientation changes can add black bars;
they must not stretch squares or shift the touch targets. A fresh launch in
landscape/fullscreen chooses its logical resolution for that viewport.

## Checks and CI

```sh
python3 -m unittest discover -s os/web -p 'test_*.py'
node --test os/web/test_*.mjs
python3 os/web/package.py --verify out/web/dist
```

The HTTP checks use tiny synthetic resources and cover ranges, invalid
ranges, HEAD/MIME, subdirectory hosting and isolation of saves/symlinks/paths.
LAN checks cover bind/Host restrictions, session paths, unsupported writes
and keeping the browser adapter opt-in on private hosts.
An isolated C++ check verifies that slow browser frames still yield for
painting/input while the native frame limiter keeps its existing behavior.
A host SDL2 check compares the production web mixer with independent whole-file
SDL conversion: PCM/resampling, loops, short effects, seeking, pause, volume and
bounded block feeding. It needs a C++ compiler and `sdl2-config` (CI installs
`libsdl2-dev`; otherwise this check is reported as skipped).
A narrow WASM/Asyncify check compiles the production web exit helper with a
deliberately held runtime and verifies atexit/onExit after asynchronous main.
It needs the installed SDK, Node and Python 3.10+; CI runs it after the build
(`python os/web/test_lifecycle.py`). It does not simulate phone performance.
The package verifier checks required assets, hashes, sizes, the WASM header
and absence of extra files/original DATs.

The existing web workflow now builds and uploads the whole static app as
an artifact. It does not publish or deploy it. CI contains no original
game files or real user saves.

The launcher uses the Android import screen's colors and panel structure
with **Fallout Classic Dialog** as the default font and PT Mono as a glyph
fallback. Full import states and matching the native Android import font
are handled with the later import implementation.

## Local resource storage and HTTPS check

`python3 os/web/https-test.py` starts a verified static-only loopback server
and an installed Cloudflare Quick Tunnel. It exposes no `--game` endpoints.
Open the printed `/device-check.html` on the phone and add it to the Home
Screen **before** importing the local ZIP. Full instructions:
[iphone-storage-test.md](iphone-storage-test.md).

The technical page streams Store/Deflate ZIP/ZIP64 in a dedicated module worker
using vendored zip.js 2.24.0 (BSD-3-Clause). Resources live in their own IndexedDB;
a completed manifest becomes active only after CRC-checked extraction. Cancel,
quota failure and interruption do not activate partial data. Local range reads
verify each block's SHA-256. Database v2 uses content-addressed chunks, references,
completed manifests and a transactional active pointer. The v1 device-check DB
upgrades in place in resumable batches; its historical name is retained. Old
writers cannot open v2. One exclusive Web Lock owns a game or storage operation.
See [storage.md](storage.md) for the format, file lifetimes and device acceptance.

The normal launcher and `index.html?device-check=1` mount completed local resources through the
same range-reader contract as the LAN adapter. Original files never cross the
HTTPS tunnel. Engine-owned ce.dat still comes from the matching app bundle;
the writable game view cannot modify the stored resource chunks. The format-3 candidate uses a separate block store and a lazy writable VFS,
including paged directory metadata. A native checkpoint publishes the complete
slot, records and settings atomically before returning save success. Normal engine fsync does not persist unfinished
catalog state; SDK and FS.syncfs are not patched. See [saves-test.md](saves-test.md)
for device acceptance. Cold offline app loading still needs the later
service-worker/update work. No service worker or automatic telemetry is installed.

After the game's main returns, the web wrapper explicitly finishes the runtime
with `emscripten_force_exit`, so pending asynchronous callbacks cannot defer
atexit/onExit. The frontend restores the existing launcher and stops text input,
audio and diagnostics without a page reload or a network request. A new Play
creates a fresh engine instance and restores committed user files. Normal exit
removes the old user-store listener; page shutdown aborts uncommitted writes.

Storage tests need `npm ci --prefix os/web --ignore-scripts` first (fake-indexeddb
is a pinned development dependency only) and Node 24+ with Web Locks. They exercise the actual importer
with ZIP64/Store/Deflate, corruption, cancellation, quota errors, incomplete
recovery and invalid paths. They do not establish iPhone performance or OS
storage persistence. The physical iPhone report for 0935bb30 confirmed the full
RPU ZIP import, Home Screen launch and local reads after closing/reopening the
app. The user also confirmed local reads with the network disabled in 0935bb30
and the exit fix on the physical iPhone in 8554dc12. The second report retained
the same installed generation without another ZIP import. Stage 2 feasibility
is accepted; peak Safari RAM remains unmeasured, and cold offline application
loading is not implemented by this experiment.

Stage 3 common storage acceptance was reported on Redmi 15C / Android 16 /
Yandex Browser 26.8.7.49.00, build acf386ed: DB v2/format 1, successful game
launch, Exit, close/reopen and verified local reads without another ZIP after
reopening. This permits stage 4; the iPhone regression remains grouped for later.
The report's stored import duration is not the duration of this short test or
of the v1 migration. The user subsequently confirmed finding the old installation
without selecting ZIP and waiting for conversion; migration is accepted on this
Android browser. No previous Redmi raw manifest was supplied for comparison.

Stage 4 user format is 2 (the resource format remains 1/database v2). Format 1
user data upgrades without clearing saves; unknown future formats fail closed.
The controlled user checkpoint uses IDBFS's pinned layout/restore helpers with
an atomic strict-durability transaction and inode revisions for equal-time writes.
Quota/request/abort errors restore the last durable user view before any retry.
Failed settings Apply is surfaced and rolls back live preferences. Device reports
include only committed user metadata (counts/format/records), not save contents.
Tests compile the actual catalog/storage/records/web bridge and webExit in WASM;
full game UI acceptance remains on the available phone, not simulated on Mac.

The stage-4 Chrome PWA report (build 6a02d761) confirmed secure/standalone/
persisted=true, user format 2, five saved slots, 19 settings files and records.
The user confirmed manual/automatic quick saves and settings after relaunches.
This was a fresh Chrome installation after deleting the Yandex version, not a
migration between browsers. Its read=null does not establish a separate resource
SHA range probe; save loading was confirmed by the user. Stage 4 is accepted
on Android; cold offline app startup remains stage 8.

Stage 5 adds a reviewed full-ZIP replacement through the same technical page.
`zip-import.js` validates the directory and available-space estimate first,
then stages a separate generation with bounded 1 MiB/64-block transactions.
CRC/actual lengths must pass before the atomic active-manifest switch. Cancel,
quota failure and interrupted staging preserve the old installation and user
store. CP866/UTF-8, ZIP64, malformed ZIPs, actual transaction rollback, stale
plans and the worker protocol are covered by the Node tests. A tiny synthetic
bad-CRC fixture is explicitly packaged for physical phone testing; it contains
no original game data and must never activate. See [import-test.md](import-test.md)
and [storage.md](storage.md). Physical stage-5 acceptance passed on Redmi 15C / Chrome PWA, build5009c4e6:
bad ZIP rejection, cancellation and app termination during staging, replacement
and existing save/settings loading were confirmed by the user. Before/after
reports retain five slots/19 settings files/records, verified range reads and
show the new active generation with all resource blocks reused. iPhone regression
remains grouped for later; cold offline app startup remains stage8.

Stage6 adds `files.html`, the production file manager in the Android import
panel style, with Fallout Classic Dialog and the saved PT Mono alternative.
It supports a full game ZIP or a prepared full mod set over the installed base,
a review before replacement, retained DAT/music references, removed obsolete
mods, and a separate embedded-save import. Config templates preserve player
settings while using new system/language/mod defaults after a mod update.

Save exchange uses SAVEGAME/SLOTnn and fallout2-saves.txt, matching Android.
The format-3 candidate exports all slots into one disk-backed ZIP/ZIP64, streams
imports into staging, and provides native-style add/explicit replace/backup
steps. The old 128 MiB selection implementation is retained only as a historical
test fixture and is not packaged. Migration is resumable and preserves legacy
rows through validation and a successful native checkpoint. Implementation,
budgets and evidence: [save-storage.md](save-storage.md). Physical iPhone large
ZIP handoff is still pending: [large-saves-test.md](large-saves-test.md).

The ordinary launcher is now a compact Fallout2/Play screen. Resource inspection
runs before showing Play; missing resources route to the importer. Play retains
synchronous audio unlock/fullscreen requests before asynchronous engine setup.
File management remains in the game's Settings; resource errors provide a
recovery link. The optional technical page stays available during development.
PWA installation is not required: ordinary browser tabs use the same launch path.
Stage 7 reuses native touch/MUI behavior and adds browser interruption handling;
implementation and acceptance scope: [mobile-behavior.md](mobile-behavior.md).
The manifest now starts at index.html with unchanged id/scope/origin. Existing
installed icons may keep the earlier debug URL until the browser refreshes their
manifest; no site-data reset/reinstallation is required. The constrained flex
layout keeps Play visible in short landscape viewports. Layout validation uses
tiny synthetic resources in a separate localhost origin without running a game.
