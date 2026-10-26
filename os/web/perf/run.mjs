#!/usr/bin/env node
// Runs the engine's webperf autotest in the installed web app and writes a
// report: save/load times, storage transactions, main-thread stalls, a CPU
// profile of the saves and loads, and the audio output's gaps and repeats.
//
// Android: Chrome on a phone connected with USB debugging (adb):
//   node os/web/perf/run.mjs --origin https://<the app's address>
// Any Chrome started with --remote-debugging-port:
//   node os/web/perf/run.mjs --cdp http://127.0.0.1:9222 --origin http://localhost:8090
// The app must be open with the game installed. See README.md.
import {spawn, execFileSync} from 'node:child_process';
import {createWriteStream, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = new URL('.', import.meta.url);
const ROOT = new URL('../../../', import.meta.url);
const options = parseArguments(process.argv.slice(2));

function parseArguments(args) {
  const result = {port:9222, profile:true, timeoutMinutes:15};
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split('=', 2);
    const value = () => inline ?? args[++i];
    if (key === '--origin') result.origin = value().replace(/\/$/, '');
    else if (key === '--cdp') result.cdp = value().replace(/\/$/, '');
    else if (key === '--device') result.device = value();
    else if (key === '--out') result.out = value();
    else if (key === '--port') result.port = Number(value());
    else if (key === '--no-profile') result.profile = false;
    else if (key === '--timeout-minutes') result.timeoutMinutes = Number(value());
    else { console.error('Unknown argument: ' + args[i]); process.exit(2); }
  }
  return result;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function adbPath() {
  for (const candidate of [process.env.ADB, join(homedir(), 'Library/Android/sdk/platform-tools/adb'), 'adb']) {
    if (!candidate) continue;
    try { execFileSync(candidate, ['version'], {stdio:'ignore'}); return candidate; } catch { /* next */ }
  }
  throw new Error('adb not found: install Android platform-tools or set ADB=/path/to/adb');
}

function adb(...args) {
  return execFileSync(options.adb, [...(options.device ? ['-s', options.device] : []), ...args], {encoding:'utf8'}).trim();
}

// One DevTools protocol connection to a page.
class Session {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 1; this.pending = new Map(); this.listeners = new Map();
    this.socket.onmessage = ({data}) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
      } else this.listeners.get(message.method)?.forEach(fn => fn(message.params));
    };
    this.opened = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
  }
  send(method, params = {}) {
    const id = this.next++;
    this.socket.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  async evaluate(expression, {gesture = false} = {}) {
    const result = await this.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true, userGesture:gesture});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function findPage() {
  const pages = (await (await fetch(options.cdp + '/json/list')).json()).filter(target => target.type === 'page');
  const app = pages.filter(target => options.origin ? target.url.startsWith(options.origin + '/')
    : /\/(index|files)\.html(\?|$)/.test(target.url));
  if (app.length !== 1) {
    console.error('Open pages:\n' + pages.map(target => '  ' + target.url).join('\n'));
    throw new Error(app.length ? 'Several app pages are open: close all but one' : 'Open the installed app (its launcher) first' + (options.origin ? '' : ', or pass --origin'));
  }
  if (!options.origin) options.origin = new URL(app[0].url).origin + new URL('./', app[0].url).pathname.replace(/\/$/, '');
  return app[0];
}

async function waitFor(check, {timeout, every = 500, waiting}) {
  const until = Date.now() + timeout;
  let said = false;
  for (;;) {
    // A page reloading under the check (an app update) is not ready yet.
    const value = await check().catch(() => null);
    if (value) return value;
    if (waiting && !said) { console.log(waiting); said = true; }
    if (Date.now() > until) throw new Error('Timed out: ' + (waiting || 'waiting'));
    await sleep(every);
  }
}

function summarizeProfile(profile, top = 20) {
  const self = new Map(), intervalMs = (profile.endTime - profile.startTime) / 1000 / Math.max(1, profile.samples?.length || 1);
  for (const node of profile.nodes) {
    const frame = node.callFrame;
    const name = (frame.functionName || '(anonymous)') + (frame.url ? ' ' + frame.url.split('/').pop() + ':' + (frame.lineNumber + 1) : '');
    self.set(name, (self.get(name) || 0) + (node.hitCount || 0) * intervalMs);
  }
  // Idle is waiting (storage, timers): the rest is what the CPU did.
  const idle = self.get('(idle)') || 0;
  self.delete('(idle)');
  const busy = [...self.values()].reduce((sum, ms) => sum + ms, 0);
  return {idleMs:idle, busyMs:busy, top:[...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, ms]) => ({name, ms, percent:busy ? ms / busy * 100 : 0}))};
}

function markdown(report, extra) {
  const lines = [], fixed = (value, digits = 0) => value == null ? '–' : Number(value).toFixed(digits);
  lines.push('# Web performance run', '', `${extra.when} · ${extra.device} · build ${report.env.build} (${report.env.version})`, '',
    `Exit status ${report.exitStatus}. Browser: ${report.env.userAgent}`, '');
  const rounds = [...report.log.matchAll(/round (\d+) in slot (\d+): save (\d+) ms[^,]*, overwrite (\d+) ms[^,]*, load (\d+) ms[^,]*, delete (\d+) ms/g)];
  const continued = report.timeline.find(item => item.name === 'continue');
  lines.push('## Saves and loads (engine time, ms)', '', '| Round | Save | Save over | Load | Delete |', '|---|---|---|---|---|');
  for (const m of rounds) lines.push(`| ${m[1]} (slot ${m[2]}) | ${m[3]} | ${m[4]} | ${m[5]} | ${m[6]} |`);
  if (continued) lines.push('', `Continue of the newest save, to the map: ${fixed(continued.ms)} ms (includes the menu's fade).`);
  lines.push('', '## Per phase', '', '| Phase | ms | RW tx | RW ms (max) | RO tx | RO ms (max) | SHA-256 | Long tasks ms (max) | Audio late / callbacks | Max gap ms |',
    '|---|---|---|---|---|---|---|---|---|---|');
  for (const item of report.timeline) {
    const p = report.phases[item.name];
    if (!p) continue;
    lines.push(`| ${item.name} | ${fixed(item.ms)} | ${p.readwrite.count} | ${fixed(p.readwrite.ms)} (${fixed(p.readwrite.maxMs)}) | ${p.readonly.count} | ${fixed(p.readonly.ms)} (${fixed(p.readonly.maxMs)}) | ${p.digest.count} / ${fixed(p.digest.bytes / 1024)} KiB / ${fixed(p.digest.ms)} ms | ${p.longTasks.count}: ${fixed(p.longTasks.ms)} (${fixed(p.longTasks.maxMs)}) | ${p.audio.late} / ${p.audio.callbacks} | ${fixed(p.audio.maxGapMs)} |`);
  }
  lines.push('', 'RW/RO: IndexedDB transactions started in the phase, their summed duration and the longest one. Transaction time overlaps; it is not wall time.');
  const calls = report.timeline.filter(item => Object.keys(report.phases[item.name]?.store ?? {}).length);
  if (calls.length) {
    lines.push('', '## User storage calls per phase', '', '| Phase | Calls |', '|---|---|');
    for (const item of calls) {
      const counts = Object.entries(report.phases[item.name].store).sort((a, b) => b[1] - a[1]);
      lines.push(`| ${item.name} | ${counts.map(([name, count]) => `${name} ${count}`).join(', ')} |`);
    }
  }
  const audio = report.audio;
  lines.push('', '## Audio output', '');
  if (!audio) lines.push('No audio analysed (the game produced no audio callbacks).');
  else {
    lines.push(`${audio.blocks} blocks analysed, ${audio.silentBlocks} silent, sample rate ${audio.sampleRate}.`, '');
    if (audio.repeats.length) {
      lines.push('Exact repeats of earlier output (a stream replaying old data):', '', '| Phase | At s | Repeats audio from s ago | Length s |', '|---|---|---|---|');
      for (const r of audio.repeats) lines.push(`| ${r.phase} | ${fixed(r.atSeconds, 2)} | ${fixed(r.lagSeconds, 3)} | ${fixed(r.seconds, 3)} |`);
    } else lines.push('No exact repeats of earlier output.');
  }
  if (extra.logcat != null) lines.push('', `Android log: ${extra.logcat} audio-related lines (logcat-audio.txt).`);
  if (extra.profile) {
    const {idleMs, busyMs} = extra.profile;
    lines.push('', '## CPU profile of the saves and loads (self time)', '',
      `CPU busy ${fixed(busyMs)} ms, idle (waiting) ${fixed(idleMs)} ms. Shares below are of the busy time.`, '',
      '| ms | % | Function |', '|---|---|---|');
    for (const row of extra.profile.top) lines.push(`| ${fixed(row.ms)} | ${fixed(row.percent, 1)} | ${row.name.replace(/\|/g, '\\|')} |`);
    lines.push('', 'Open profile.cpuprofile in Chrome DevTools (Performance) for the call trees.');
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const when = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = options.out || fileURLToPath(new URL('out/web/perf-runs/' + when + '/', ROOT));
  mkdirSync(out, {recursive:true});
  let device = 'desktop Chrome', logcat = null;
  if (!options.cdp) {
    options.adb = adbPath();
    const devices = adb('devices').split('\n').slice(1).filter(line => /\tdevice$/.test(line));
    if (!options.device && devices.length !== 1) throw new Error(devices.length ? 'Several devices: pass --device <serial>' : 'No phone: connect it with USB debugging allowed (adb devices)');
    device = adb('shell', 'getprop', 'ro.product.model') + ', Android ' + adb('shell', 'getprop', 'ro.build.version.release');
    adb('forward', 'tcp:' + options.port, 'localabstract:chrome_devtools_remote');
    options.cdp = 'http://127.0.0.1:' + options.port;
  }
  console.log('Device: ' + device);
  const page = await findPage();
  console.log('App: ' + options.origin);
  const session = new Session(page.webSocketDebuggerUrl);
  await session.opened;
  const consoleLog = createWriteStream(join(out, 'console.txt'));
  session.on('Runtime.consoleAPICalled', ({type, args}) => consoleLog.write(type + ': ' + args.map(arg => arg.value ?? arg.description ?? '').join(' ') + '\n'));
  session.on('Runtime.exceptionThrown', ({exceptionDetails}) => consoleLog.write('exception: ' + (exceptionDetails.exception?.description || exceptionDetails.text) + '\n'));
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  const source = 'const createAudioAnalysisSource = ' + JSON.stringify(readFileSync(new URL('audio-analysis.js', HERE), 'utf8')) + ';\n'
    + readFileSync(new URL('probe.js', HERE), 'utf8');
  const {identifier} = await session.send('Page.addScriptToEvaluateOnNewDocument', {source});
  try {
    await session.send('Page.navigate', {url:options.origin + '/index.html'});
    await waitFor(() => session.evaluate(`!!window.__webPerf && document.readyState === 'complete'`), {timeout:60000});
    // A new build reloads an idle launcher once it is installed: Play must
    // not be pressed on the page that is about to go away.
    const ready = await waitFor(() => session.evaluate(`(async () => {
      if (location.pathname.endsWith('/files.html')) return 'no-game';
      const play = document.getElementById('play');
      if (!play || play.hidden || play.disabled) return null;
      const registration = await navigator.serviceWorker?.getRegistration();
      await registration?.update().catch(() => {});
      return registration?.installing || registration?.waiting ? null : 'ready';
    })()`), {timeout:5 * 60000, waiting:'Waiting for the launcher\'s Play button (turn the phone to landscape; an app update may reload it first)…'});
    if (ready === 'no-game') throw new Error('The app has no game installed at this address');
    if (options.adb) {
      adb('logcat', '-c');
      logcat = spawn(options.adb, [...(options.device ? ['-s', options.device] : []), 'logcat', '-v', 'threadtime'], {stdio:['ignore', 'pipe', 'ignore']});
      logcat.stdout.pipe(createWriteStream(join(out, 'logcat.txt')));
    }
    console.log('Starting the game with the webperf autotest…');
    await session.evaluate(`document.getElementById('play').click()`, {gesture:true});
    let profiling = false, profile = null, lastPhase = '';
    const deadline = Date.now() + options.timeoutMinutes * 60000;
    for (;;) {
      const state = await session.evaluate('window.__webPerf.state()');
      if (state.phase !== lastPhase) { console.log('  phase: ' + state.phase); lastPhase = state.phase; }
      if (options.profile && !profiling && !profile && state.marks.includes('walk')) {
        await session.send('Profiler.enable');
        await session.send('Profiler.setSamplingInterval', {interval:1000});
        await session.send('Profiler.start');
        profiling = true;
      }
      if (profiling && state.marks.includes('after-saves')) {
        profile = (await session.send('Profiler.stop')).profile;
        profiling = false;
        writeFileSync(join(out, 'profile.cpuprofile'), JSON.stringify(profile));
      }
      if (state.done) break;
      if (Date.now() > deadline) throw new Error('The autotest did not finish in time; its log so far is in autotest-log.txt');
      await sleep(250);
    }
    if (profiling) profile = (await session.send('Profiler.stop')).profile;
    const report = await session.evaluate('window.__webPerf.report()');
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(out, 'autotest-log.txt'), report.log);
    let audioLines = null;
    if (logcat) {
      logcat.kill(); await sleep(300);
      const lines = readFileSync(join(out, 'logcat.txt'), 'utf8').split('\n').filter(line => /audio|aaudio|underrun|xrun|glitch/i.test(line));
      writeFileSync(join(out, 'logcat-audio.txt'), lines.join('\n') + '\n');
      audioLines = lines.length;
    }
    writeFileSync(join(out, 'report.md'), markdown(report, {when, device, logcat:audioLines, profile:profile && summarizeProfile(profile)}));
    console.log((report.exitStatus === 0 ? 'Done' : 'The autotest failed (exit ' + report.exitStatus + ')') + ': ' + join(out, 'report.md'));
    process.exitCode = report.exitStatus === 0 ? 0 : 1;
  } finally {
    logcat?.kill();
    try {
      writeFileSync(join(out, 'autotest-log.txt'), await session.evaluate('window.__webPerf?.log() ?? ""'));
    } catch { /* The report already holds it. */ }
    await session.send('Page.removeScriptToEvaluateOnNewDocument', {identifier}).catch(() => {});
    await session.send('Page.navigate', {url:options.origin + '/index.html'}).catch(() => {});
    session.close(); consoleLog.end();
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
