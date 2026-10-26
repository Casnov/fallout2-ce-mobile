import {developmentFiles, mountGame} from './filesystem.js';
import {createTextInput, createGameAudio, createGameViewport, createAudioTiming, createGameWindow} from './browser.js';
import {localFiles} from './resource-store.js';
import {createFilesView} from './files-view.js';
import {createSaveSession} from './save-session.js';
import {createSaveDownloads} from './save-download.js';
import {startAppCache} from './app-cache.js';

const ru = navigator.language.toLowerCase().startsWith('ru');
const text = ru ? {
  title:'Fallout 2', loading:'Загружаю…', checking:'Проверяю файлы игры…', play:'Начать игру', retry:'Попробовать снова',
  updating:'Обновляю приложение…',
  repair:'Файлы игры',
  rotate:'Поверните устройство горизонтально', unsupported:'Этот браузер не поддерживает WebAssembly.',
  error:'Не удалось запустить игру.',
  build:'Проверочная сборка:',
  devNote:'Тестовый запуск с Mac. Держите Mac включённым и оставайтесь в одной сети Wi-Fi. Прогресс исчезнет после перезагрузки страницы.',
} : {
  title:'Fallout 2', loading:'Loading…', checking:'Checking game files…', play:'Play', retry:'Try again',
  updating:'Updating the app…',
  repair:'Game files',
  rotate:'Turn the device to landscape', unsupported:'This browser does not support WebAssembly.', error:'The game could not start.',
  build:'Test build:',
  devNote:'Test session from your Mac. Keep it awake and stay on the same Wi-Fi. Progress disappears on page reload.',
};
const $ = id => document.getElementById(id);
const viewport = createGameViewport($('canvas'));
const gameWindow = createGameWindow($('canvas'),{isBlocked:() => !$('rotate').hidden || !$('save-exchange').hidden});
const textInput = createTextInput($('text-input'), $('canvas'), viewport);
const audio = createGameAudio();
const exchangeView = createFilesView($('save-exchange'),{shadow:true});
const downloadSaves = createSaveDownloads();
$('save-exchange').setAttribute('aria-label',ru ? 'Сохранения' : 'Saves');
// SDL's document listeners must not receive touches/keys used in the overlay.
for (const type of ['pointerdown','pointerup','pointermove','touchstart','touchmove','touchend','touchcancel','keydown','keyup','wheel']) {
  $('save-exchange').addEventListener(type,event => event.stopPropagation());
}
let audioTiming = null;
let diagnosticsTimer = null;
$('text-input').setAttribute('aria-label', ru ? 'Текст игры' : 'Game text');
document.documentElement.lang = ru ? 'ru' : 'en';
$('title').textContent = text.title;
$('repair').textContent = text.repair;
$('message').textContent = text.checking;
$('play').textContent = text.play;
$('retry').textContent = text.retry;
$('rotate').textContent = text.rotate;
let source = null;
let starting = false;
let running = false;
let updating = false;
let filesMode = null;
const appCache = startAppCache({idle:() => !!source && !starting && !running,
  onApplying:value => { updating = value; rotatePrompt(); }});

function rotatePrompt() {
  const portrait = innerHeight > innerWidth && matchMedia('(pointer:coarse)').matches;
  $('rotate').hidden = !(running && portrait);
  if (source && !starting && !running && !document.body.classList.contains('error')) {
    $('play').disabled = portrait || updating;
    $('message').textContent = updating ? text.updating : portrait ? text.rotate : '';
    $('message').hidden = !updating && !portrait;
  }
}
function error(message, detail) {
  console.error(message, detail || '');
  textInput.end();
  audio.stop();
  audioTiming?.stop();
  clearInterval(diagnosticsTimer);
  $('diagnostics').hidden = true;
  document.body.classList.remove('playing');
  document.body.classList.add('error');
  $('message').textContent = message;
  $('message').hidden = false;
  $('progress').hidden = true;
  $('play').hidden = true;
  $('retry').hidden = false;
  $('repair').hidden = false;
  running = false;
  rotatePrompt();
}

async function exited(status) {
  // This runs outside the finished WASM stack. Restore the already-loaded
  // document, including when the network is off; a reload could strand a PWA
  // on a black canvas until its HTML/JS becomes reachable again.
  textInput.end();
  audioTiming?.stop();
  audioTiming = null;
  clearInterval(diagnosticsTimer);
  diagnosticsTimer = null;
  audio.stop();
  running = starting = false;
  delete window.falloutDev;
  $('diagnostics').hidden = true;
  document.body.classList.remove('playing');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (status !== 0) { error(text.error, 'Engine exit status: ' + status); return; }
  document.body.classList.remove('error');
  $('progress').hidden = true;
  $('retry').hidden = true;
  $('repair').hidden = true;
  $('play').hidden = !source;
  rotatePrompt();
  if (filesMode !== null) {
    const mode = filesMode; filesMode = null;
    await source?.close();
    location.href = './files.html?mode=' + encodeURIComponent(mode);
    return;
  }
  appCache.check();
}

async function prepare() {
  await exchangeView.ready;
  if (typeof WebAssembly !== 'object') throw new Error(text.unsupported);
  const response = await fetch(new URL('./build-info.json', import.meta.url), {cache:'no-store'});
  if (!response.ok) throw new Error('Cannot load build-info.json.');
  const build = await response.json();
  document.body.dataset.version = build.version;
  document.body.dataset.webBuild = build.buildId || build.files['fallout2-ce.wasm'].sha256.slice(0, 8);
  $('build-tag').textContent = document.body.dataset.webBuild;
  source = await developmentFiles() || await localFiles();
  if (!source) { location.replace('./files.html'); return; }
  $('play').hidden = !source;
  $('dev-note').textContent = text.devNote;
  $('dev-note').hidden = source.kind === 'local';
  rotatePrompt();
  appCache.check();
}

async function play() {
  if (starting || running || updating || !source) return;
  if (innerHeight > innerWidth && matchMedia('(pointer:coarse)').matches) return;
  starting = true;
  $('storage-warning').hidden = true;
  $('play').disabled = true;
  $('message').textContent = text.loading;
  $('message').hidden = false;
  $('progress').hidden = false;
  let engine;
  try {
    // Both permission-sensitive actions happen in the original click, before
    // any asynchronous setup. SDL will share this already unlocked context.
    const SDL2 = audio.start();
    let fullscreen;
    try {
      fullscreen = document.documentElement.requestFullscreen?.({navigationUI:'hide'}).catch(() => {});
    } catch { /* Fullscreen is optional, e.g. in an iOS Home Screen app. */ }
    const module = engine = await globalThis.createFallout2({
      canvas:$('canvas'), noInitialRun:true, webMouseAsTouch:source.mouseAsTouch,
      SDL2, webTextInput:textInput, webViewport:viewport,webWindow:gameWindow,
      webOpenFiles:mode => { filesMode = mode; },
      locateFile:name => new URL('./' + name, import.meta.url).href,
      print:message => console.log(message), printErr:message => console.warn(message),
      onAbort:reason => { engine?.webUserFiles?.close(); error(text.error, reason); },
      onExit:status => queueMicrotask(() => {
        // The manager acquires both writer leases. Await their release instead
        // of racing a new page against the engine's asynchronous shutdown.
        Promise.resolve(engine?.webUserFiles?.close()).then(() => exited(status))
          .catch(exception => error(text.error, exception));
      }),
      onUserWriteSuccess:() => { $('storage-warning').hidden = true; },
      onUserWriteFailure:failure => {
        $('storage-warning').hidden = false;
        $('storage-warning').textContent = failure.fatal
          ? (ru ? 'Запись отключена после ошибки хранилища. Полностью закрой и открой игру.'
            : 'Writing is disabled after a storage error. Close and reopen the game.')
          : failure.kind === 'QuotaExceededError'
            ? (ru ? 'Не удалось сохранить: недостаточно места. Освободи место и повтори.'
              : 'Could not save: storage is full. Free some space and try again.')
            : (ru ? 'Не удалось записать сохранение или настройки. Повтори попытку.'
              : 'Could not write the save or settings. Please try again.');
      },
    });
    await mountGame(module, source);
    module.webExchangeSaves = source.kind === 'local' ? createSaveSession({
      host:$('save-exchange'),root:exchangeView.root,canvas:$('canvas'),user:module.webUserFiles,
      source,audio,textInput,buildId:document.body.dataset.webBuild,download:downloadSaves,
    }) : async () => { throw new Error('Save exchange requires locally installed game files'); };
    // Explicit test URLs only; the ordinary installed launcher has no debug API.
    const parameters = new URLSearchParams(location.search);
    const inspect = source && ['dev','stats'].some(key => parameters.has(key));
    if (inspect) window.falloutDev = {module, stats:() => module.GameFS.stats(),
      audio:audio.status, geometry:() => ({viewport:[innerWidth, innerHeight],
        canvas:[$('canvas').width, $('canvas').height],
        css:[$('canvas').getBoundingClientRect().width, $('canvas').getBoundingClientRect().height],
        dpr:devicePixelRatio, renderer:module.webRendererInfo})};
    if (inspect && parameters.get('stats') === '1') {
      // Only this explicit dev session gets frame timing. Root configs live in
      // writable MEMFS; the Mac's source config is never changed.
      const config = '/game/fallout2.cfg';
      const previous = module.FS.analyzePath(config).exists ? module.FS.readFile(config) : new Uint8Array();
      const suffix = new TextEncoder().encode('\n[debug]\nperf_log=1\n');
      const measuredConfig = new Uint8Array(previous.length + suffix.length);
      measuredConfig.set(previous);
      measuredConfig.set(suffix, previous.length);
      module.FS.writeFile(config, measuredConfig);
      audioTiming = createAudioTiming({active:() => !document.hidden && audio.status().state === 'running'});
      SDL2.audioContext?.addEventListener('statechange', () => audioTiming?.resetGap());
      window.falloutDev.audioTiming = audioTiming.status;
      window.falloutDev.frameTiming = () => module.webFrameTiming;
      diagnosticsTimer = setInterval(() => {
        audioTiming.attach(module.SDL2?.audio?.scriptProcessorNode);
        const timing = audioTiming.status();
        const state = audio.status();
        const frame = module.webFrameTiming;
        $('diagnostics').hidden = false;
        $('diagnostics').textContent = `${text.build} ${document.body.dataset.webBuild}\n`
          + `Audio: ${state.state}, ${state.sampleRate || '?'} Hz, ${timing.bufferSize || '?'} frames\n`
          + `5s gap: ${timing.recent.maxGapMs.toFixed(1)} ms; work: ${timing.recent.maxWorkMs.toFixed(1)} ms; late: ${timing.recent.late}\n`
          + `All gap: ${timing.maxGapMs.toFixed(1)} ms; work: ${timing.maxWorkMs.toFixed(1)} ms`
          + (frame ? `\nFrame: ${frame.fps.toFixed(0)} fps; UI/present: ${frame.uiMs.toFixed(1)}/${frame.presentMs.toFixed(1)} ms` : '');
      }, 1000);
    }
    await fullscreen;
    document.body.classList.add('playing');
    // Measure the final fullscreen canvas, after layout has applied its CSS.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    $('canvas').focus();
    running = true;
    rotatePrompt();
    module.callMain([]);
  } catch (exception) {
    engine?.webUserFiles?.close();
    error(text.error, exception);
  } finally {
    starting = false;
  }
}

for (const type of ['touchstart', 'touchmove', 'touchend']) {
  $('canvas').addEventListener(type, event => event.preventDefault(), {passive:false});
}
$('canvas').addEventListener('contextmenu', event => event.preventDefault());
$('canvas').addEventListener('gesturestart', event => event.preventDefault(), {passive:false});
$('play').addEventListener('click', play);
$('retry').addEventListener('click', () => location.reload());
window.addEventListener('resize', rotatePrompt);
for (const type of ['pointerdown', 'touchend', 'keydown']) {
  document.addEventListener(type, audio.resume, {capture:true, passive:true});
}
document.addEventListener('visibilitychange', () => {
  audioTiming?.resetGap();
  if (!document.hidden) audio.resume();
});
window.addEventListener('pageshow', event => {
  if (event.persisted && source?.kind === 'local') { location.reload(); return; }
  audioTiming?.resetGap();
  audio.resume();
});
prepare().catch(exception => error(text.error, exception));
