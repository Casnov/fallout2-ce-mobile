# Performance run on a phone

`run.mjs` drives the installed web app over the Chrome DevTools protocol and
writes a report of where saves, loads and the audio spend their time. Nothing
here is part of the app: the probe is injected into the page only for the run.

What a run does, through the engine's `webperf` autotest (`src/dev_autotest.cc`):

1. Continues the player's newest save from the main menu.
2. Stays 20 s on the map with its music, walks a few hexes.
3. Three rounds of: save to a free manual slot, save over it, load it,
   delete it. The player's own saves are never written; the slot is free
   before and deleted after.
4. Stays 20 s more on the map (audio after saving), then exits to the launcher.

Measured per phase: engine time of each save/load, IndexedDB transactions
(count, summed and longest duration), calls of the user store's methods, SHA-256 work, long main-thread tasks,
audio callbacks that came late and the longest gap, and in the audio output
itself silent blocks and exact repeats of earlier sound (a stream replaying old
data). A CPU profile covers the saves and loads. On Android the system log is
kept too (`logcat-audio.txt` has its audio lines).

## Phone (Android, Chrome)

Once: Settings → About phone → tap the build number to enable developer
options, then Developer options → USB debugging. On MIUI/HyperOS also enable
"USB debugging (Security settings)" if offered. Connect the cable and allow
this computer on the phone.

1. Open the installed app on the phone (its launcher), landscape, with the
   game installed and at least one save.
2. On the Mac:

   ```sh
   node os/web/perf/run.mjs --origin https://<the app's address>
   ```

The run takes about two minutes. Keep the phone unlocked and the app in front.
The report is `out/web/perf-runs/<time>/report.md`, next to `report.json`,
`autotest-log.txt`, `profile.cpuprofile` (open in Chrome DevTools), `console.txt`
and `logcat.txt`.

The address must be the one the game was imported at: browser storage
belongs to an address. The app there must be a build with the `webperf`
autotest. Options: `--device <serial>` with several phones, `--no-profile`,
`--timeout-minutes <n>`, `--out <dir>`.

## Desktop Chrome

Start Chrome with `--remote-debugging-port=9222` and a separate
`--user-data-dir`, install the game there through the app, then:

```sh
node os/web/perf/run.mjs --cdp http://127.0.0.1:9222 --origin http://localhost:8090
```

Desktop numbers only show the shape of the work (how many transactions, where
the CPU goes); phone storage and audio timing differ a lot.
