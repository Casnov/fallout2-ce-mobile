import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextInput, createGameAudio, fieldInCanvas, fitCanvas, createAudioTiming, createGameViewport,
  createGameWindow, WINDOW_ACTIVE, CANCEL_TOUCHES, VIEWPORT_CHANGED, WINDOW_INTERRUPTED} from './browser.js';

class Input extends EventTarget {
  hidden = true; value = ''; style = {}; selectionStart = 0; selectionEnd = 0;
  form = new EventTarget();
  focused = false;
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  emit(type, properties = {}) {
    const event = new Event(type, {cancelable:true});
    Object.assign(event, properties);
    this.dispatchEvent(event);
    return event;
  }
}
const points = text => Array.from(text, ch => ch.codePointAt(0));

test('fullscreen, browser chrome, portrait and keyboard resizing retain one aspect ratio', () => {
  for (const [width,height] of [[852,393], [852,350], [393,852], [852,190]]) {
    const fit = fitCanvas(width,height,852/393);
    assert.ok(fit.left >= 0 && fit.top >= 0);
    assert.ok(fit.width <= width && fit.height <= height);
    assert.ok(Math.abs(fit.width / fit.height - 852/393) < 1e-9);
    const field = fieldInCanvas({width:fit.width*3,height:fit.height*3,rect:fit},
      [fit.width*3,fit.height*3], [30,30,90,90]);
    assert.ok(Math.abs(field.width-field.height) < 1e-9);
    assert.ok(Math.abs(field.width-30) < 1e-9);
  }
});
const canvas = {width:2400, height:1080,
  getBoundingClientRect:() => ({left:0, top:0, width:800, height:360})};
function editor() {
  const input = new Input();
  const bridge = createTextInput(input, canvas);
  const update = text => bridge.update(points(text), [1066,480], [100,30,400,44], 18, 31);
  bridge.begin(); update('Вася');
  return {input, bridge, update};
}

test('native text replaces the field: selection, paste, deletion, empty value and game charset feedback', () => {
  const {input, bridge, update} = editor();
  assert.equal(input.value, 'Вася');
  assert.equal(input.focused, true);
  input.value = 'Вася😀'; input.emit('input');
  // An engine frame must not overwrite input not yet consumed by the game.
  update('Вася'); assert.equal(input.value, 'Вася😀');
  assert.deepEqual(bridge.take(), points('Вася😀'));
  update('Вася'); assert.equal(input.value, 'Вася');
  input.value = ''; input.emit('input');
  assert.deepEqual(bridge.take(), []);
  update(''); assert.equal(input.value, '');
  assert.equal(bridge.take(), null);
  bridge.end(); assert.equal(input.hidden, true); assert.equal(input.focused, false);
  bridge.begin(); update('Другой'); assert.equal(input.value, 'Другой');
});

test('IME composition is committed once and Enter waits for pending input', () => {
  const {input, bridge, update} = editor();
  input.emit('compositionstart'); input.value = '日本'; input.emit('input');
  update('Вася'); assert.equal(input.value, '日本');
  assert.equal(bridge.take(), null);
  input.emit('keydown', {key:'Enter', isComposing:true});
  assert.equal(bridge.done(), false);
  input.emit('compositionend');
  input.emit('keydown', {key:'Enter', isComposing:false});
  assert.equal(bridge.done(), false);
  assert.deepEqual(bridge.take(), points('日本'));
  assert.equal(bridge.done(), true); assert.equal(bridge.done(), false);
});

test('DOM field maps through renderer letterboxing and backing-store scale', () => {
  const rect = {left:0, top:0, width:900, height:400};
  const field = fieldInCanvas({width:2700,height:1200,rect}, [960,480], [0,0,100,100]);
  assert.equal(field.left, 50);
  assert.equal(field.top, 0);
  assert.ok(Math.abs(field.width - field.height) < 1e-9);
  assert.ok(Math.abs(field.width - 100 * 400 / 480) < 1e-9);
  const changed = fieldInCanvas({width:1800,height:800,rect}, [960,480], [0,0,100,100]);
  for (const key of Object.keys(field)) assert.ok(Math.abs(changed[key] - field[key]) < 1e-9);
});

test('one SDL AudioContext resumes synchronously on Play and after interruption', async () => {
  let creates = 0, resumes = 0, closes = 0;
  class Context {
    state = 'suspended'; sampleRate = 48000;
    constructor() { creates++; }
    resume() { resumes++; this.state = 'running'; return Promise.resolve(); }
    close() { closes++; this.state = 'closed'; return Promise.resolve(); }
  }
  const environment = {AudioContext:Context, navigator:{audioSession:{}}, document:{hidden:false}};
  const audio = createGameAudio(environment);
  const sdl = audio.start();
  assert.equal(creates, 1); assert.equal(resumes, 1);
  assert.equal(environment.navigator.audioSession.type, 'playback');
  assert.equal(sdl.audioContext.state, 'running');
  audio.resume(); assert.equal(resumes, 1);
  sdl.audioContext.state = 'interrupted';
  environment.document.hidden = true; audio.resume(); assert.equal(resumes, 1);
  environment.document.hidden = false; audio.resume(); assert.equal(resumes, 2);
  audio.stop(); assert.equal(closes, 1);
  audio.resume(); assert.equal(resumes, 2);
});

test('optional Audio Session rejection does not prevent SDL context creation', () => {
  const environment = {document:{hidden:false}, navigator:{audioSession:{
    set type(_) { throw new Error('unsupported'); }}},
    AudioContext:class {state='running'; close() { return Promise.resolve(); }} };
  const audio = createGameAudio(environment);
  assert.ok(audio.start().audioContext);
  assert.match(audio.status().error, /unsupported/);
});

test('exchange keeps the SDL audio context suspended despite overlay gestures and visibility events',async()=>{
  let resumes=0;
  class Context {
    state='suspended';
    resume(){this.state='running';resumes++;return Promise.resolve();}
    suspend(){this.state='suspended';return Promise.resolve();}
  }
  const audio=createGameAudio({AudioContext:Context,navigator:{},document:{hidden:false}});
  audio.start();await audio.pause();audio.resume();audio.resume();
  assert.equal(audio.status().state,'suspended');assert.equal(resumes,1);
  audio.unpause();assert.equal(audio.status().state,'running');assert.equal(resumes,2);
});

test('audio timing preserves callback/output and excludes deliberate background gaps', () => {
  let clock = 0, foreground = true, calledThis = null;
  const original = function(event) { calledThis = this; event.samples[0] = 0.25; clock += 3; };
  const node = {bufferSize:2048, onaudioprocess:original};
  const probe = createAudioTiming({now:() => clock, active:() => foreground});
  probe.attach(node);
  probe.attach(node); // Attaching twice must not wrap or execute twice.
  const event = {samples:[0]};
  node.onaudioprocess(event);
  clock = 46; node.onaudioprocess(event);
  assert.equal(event.samples[0], 0.25);
  assert.equal(calledThis, node);
  assert.deepEqual(probe.status(), {callbacks:2, maxGapMs:46, maxWorkMs:3, bufferSize:2048,
    recent:{callbacks:2, maxGapMs:46, maxWorkMs:3, late:0}});
  probe.resetGap(); clock = 10000; node.onaudioprocess(event);
  assert.equal(probe.status().maxGapMs, 46);
  foreground = false; clock = 20000; node.onaudioprocess(event);
  foreground = true; clock = 30000; node.onaudioprocess(event);
  assert.equal(probe.status().maxGapMs, 46);
  assert.equal(probe.status().callbacks, 4);
  probe.stop(); assert.equal(node.onaudioprocess, original);
  probe.attach(node);
  const replacement = () => {};
  node.onaudioprocess = replacement; // SDL shutdown may install its own handler.
  probe.stop(); assert.equal(node.onaudioprocess, replacement);
});


test('mobile keyboard overlays the game through opening, closing and rotation', () => {
  const environment = new EventTarget();
  Object.assign(environment, {innerWidth:900, innerHeight:400, matchMedia:() => ({matches:true})});
  const css = {};
  const gameCanvas = {style:{setProperty:(key,value) => { css[key] = value; }}};
  const viewport = createGameViewport(gameCanvas, environment);
  viewport.configure(1080,480);
  const initial = {...css};
  const resize = (width,height) => {
    Object.assign(environment, {innerWidth:width, innerHeight:height});
    environment.dispatchEvent(new Event('resize'));
  };
  // Lock before DOM focus can synchronously resize the browser viewport.
  const input = new Input();
  input.focus = () => { resize(900,180); };
  const bridge = createTextInput(input, {...canvas, style:gameCanvas.style}, viewport);
  bridge.begin(); bridge.update(points('Hero'), [1080,480], [100,30,400,44], 18, 31);
  assert.deepEqual(css, initial);
  bridge.end(); resize(900,260); assert.deepEqual(css, initial);
  resize(900,400); assert.deepEqual(css, initial);
  resize(1000,400); assert.equal(css['--canvas-left'], '50px');
  viewport.setEditing(true); resize(1000,180);
  resize(400,900); assert.equal(css['--canvas-width'], '400px');
  resize(1000,180); assert.equal(css['--canvas-height'], '400px');
  assert.equal(css['--canvas-left'], '50px');
  resize(400,900);
  viewport.setEditing(false);
  resize(900,400); assert.deepEqual(css, initial);
});

function windowFixture() {
  const environment = new EventTarget(), page = new Input(), surface = new Input();
  page.hidden = false; page.hasFocus = () => true;
  Object.assign(environment, {document:page, devicePixelRatio:3});
  let rect = {left:0,top:0,width:900,height:400}, blocked = false;
  surface.getBoundingClientRect = () => rect;
  const window = createGameWindow(surface,{environment,isBlocked:() => blocked});
  const send = (type) => environment.dispatchEvent(new Event(type));
  return {environment,page,surface,window,send,resize(next) { rect = next; send('resize'); },
    block(value) { blocked = value; }};
}

test('canceled touches are consumed once, including a queued ordinary SDL finger-up', () => {
  const {surface,window} = windowFixture();
  assert.equal(window.poll(),WINDOW_ACTIVE);
  surface.emit('touchstart',{touches:[{},{}]});
  surface.emit('touchcancel');
  surface.emit('touchend',{touches:[]});
  assert.equal(window.poll(),WINDOW_ACTIVE | CANCEL_TOUCHES);
  assert.equal(window.poll(),WINDOW_ACTIVE);
});

test('visibility, focus and blocking overlays suspend native input without requiring a new game', () => {
  const {page,window,send,block} = windowFixture();
  page.hidden = true; page.emit('visibilitychange');
  page.emit('pointerdown'); // A hidden document cannot reactivate the game.
  assert.equal(window.poll(),CANCEL_TOUCHES | WINDOW_INTERRUPTED);
  page.hidden = false; page.emit('visibilitychange');
  assert.equal(window.poll(),WINDOW_ACTIVE | CANCEL_TOUCHES);
  send('blur'); assert.equal(window.poll(),CANCEL_TOUCHES | WINDOW_INTERRUPTED);
  send('focus'); assert.equal(window.poll(),WINDOW_ACTIVE | CANCEL_TOUCHES);
  send('blur'); window.poll();
  page.emit('touchstart'); assert.equal(window.poll(),WINDOW_ACTIVE);
  block(true); assert.equal(window.poll(),0);
  send('focus'); assert.equal(window.poll(),CANCEL_TOUCHES);
  block(false); assert.equal(window.poll(),WINDOW_ACTIVE);
});

test('a full background/return cycle between native polls retains the interruption', () => {
  const {page,window,send} = windowFixture();
  page.hidden = true; page.emit('visibilitychange');
  page.hidden = false; page.emit('visibilitychange');
  assert.equal(window.poll(),WINDOW_ACTIVE | CANCEL_TOUCHES | WINDOW_INTERRUPTED);
  assert.equal(window.poll(),WINDOW_ACTIVE);
  send('blur'); send('focus');
  assert.equal(window.poll(),WINDOW_ACTIVE | CANCEL_TOUCHES | WINDOW_INTERRUPTED);
  assert.equal(window.poll(),WINDOW_ACTIVE);
});

test('canvas geometry changes cancel a live gesture; keyboard-only resize preserves it', () => {
  const {surface,window,environment,resize,send} = windowFixture();
  surface.emit('touchstart',{touches:[{}]});
  send('resize'); assert.equal(window.poll(),WINDOW_ACTIVE);
  resize({left:0,top:0,width:400,height:180});
  assert.equal(window.poll(),WINDOW_ACTIVE | CANCEL_TOUCHES | VIEWPORT_CHANGED);
  assert.equal(window.poll(),WINDOW_ACTIVE);
  environment.devicePixelRatio = 2; send('resize');
  assert.equal(window.poll(),WINDOW_ACTIVE | CANCEL_TOUCHES | VIEWPORT_CHANGED);
  // A 180-degree rotation can swap safe areas without changing dimensions.
  send('orientationchange');
  assert.equal(window.poll(),WINDOW_ACTIVE | CANCEL_TOUCHES | VIEWPORT_CHANGED);
});

test('iOS audio interruption recovery reuses the unlocked context and respects background/exchange pause', async () => {
  let resumes = 0, creates = 0;
  class Context extends EventTarget {
    state = 'suspended';
    constructor() { super(); creates++; }
    set(state) { this.state = state; this.dispatchEvent(new Event('statechange')); }
    resume() { resumes++; this.set('running'); return Promise.resolve(); }
    suspend() { this.set('suspended'); return Promise.resolve(); }
    close() { this.set('closed'); return Promise.resolve(); }
  }
  const page = {hidden:false};
  const audio = createGameAudio({AudioContext:Context,navigator:{},document:page});
  const context = audio.start().audioContext;
  context.set('interrupted'); context.set('suspended');
  assert.equal(resumes,2); assert.equal(creates,1);
  context.set('interrupted'); page.hidden = true; context.set('suspended');
  assert.equal(resumes,2);
  page.hidden = false; audio.resume(); assert.equal(resumes,3);
  await audio.pause(); context.set('interrupted'); context.set('suspended');
  assert.equal(resumes,3);
  audio.unpause(); assert.equal(resumes,4);
  audio.stop(); context.set('interrupted'); context.set('closed');
  assert.equal(resumes,4);
});

test('desktop text editing continues to follow window resize', () => {
  const environment = new EventTarget();
  Object.assign(environment, {innerWidth:900, innerHeight:400, matchMedia:() => ({matches:false})});
  const css = {};
  const viewport = createGameViewport({style:{setProperty:(key,value) => { css[key] = value; }}}, environment);
  viewport.configure(1080,480); viewport.setEditing(true);
  environment.innerHeight = 200; environment.dispatchEvent(new Event('resize'));
  assert.equal(css['--canvas-height'], '200px');
});

test('audio diagnostics age out loading stalls and count recent missed deadlines', () => {
  let clock = 0;
  const node = {bufferSize:2048, onaudioprocess() { clock += 2; }};
  const probe = createAudioTiming({now:() => clock});
  probe.attach(node);
  const event = {outputBuffer:{sampleRate:48000}};
  node.onaudioprocess(event);
  clock = 2000; node.onaudioprocess(event);
  clock = 2043; node.onaudioprocess(event);
  assert.equal(probe.status().recent.late, 1);
  assert.equal(probe.status().maxGapMs, 2000);
  probe.resetGap(); clock = 10000; node.onaudioprocess(event);
  clock = 10043; node.onaudioprocess(event);
  assert.deepEqual(probe.status().recent, {callbacks:2, maxGapMs:43, maxWorkMs:2, late:0});
  clock = 16000;
  assert.equal(probe.status().recent.callbacks, 0);
  assert.equal(probe.status().maxGapMs, 2000);
});


test('Android IME submit accepts the final text and immediately dismisses the keyboard without keydown', () => {
  const {input, bridge} = editor();
  // Some IMEs supply the final value with submit, without a normal Enter or
  // a preceding input event. Do not lose the last word or reload the page.
  input.value = 'Славик';
  const submit = new Event('submit', {cancelable:true});
  input.form.dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);
  assert.equal(input.focused, false);
  assert.equal(bridge.done(), false);
  assert.deepEqual(bridge.take(), points('Славик'));
  assert.equal(bridge.done(), true);
  assert.equal(bridge.done(), false);
});

test('soft keyboard line-break actions and hardware Enter finish once after pending text', () => {
  for (const [type, properties] of [
    ['beforeinput', {inputType:'insertLineBreak'}],
    ['beforeinput', {inputType:'insertParagraph'}],
    ['keydown', {key:'Enter', keyCode:13}],
  ]) {
    const {input, bridge} = editor();
    const event = input.emit(type, properties);
    assert.equal(event.defaultPrevented, true);
    assert.equal(input.focused, false);
    assert.equal(bridge.done(), false);
    assert.deepEqual(bridge.take(), points('Вася'));
    assert.equal(bridge.done(), true);
    assert.equal(bridge.done(), false);
  }
});

test('IME candidate confirmation and Android Back blur do not accept a game dialog', () => {
  const {input, bridge} = editor();
  input.emit('compositionstart');
  const candidate = input.emit('keydown', {key:'Enter', isComposing:true});
  assert.equal(candidate.defaultPrevented, false);
  input.form.dispatchEvent(new Event('submit', {cancelable:true}));
  assert.equal(bridge.done(), false);
  assert.equal(input.focused, true);
  input.emit('compositionend'); bridge.take();
  input.emit('keydown', {key:'Enter', keyCode:229});
  assert.equal(bridge.done(), false);
  input.blur(); input.emit('blur');
  assert.equal(bridge.done(), false);
  bridge.end();
  input.form.dispatchEvent(new Event('submit', {cancelable:true}));
  assert.equal(bridge.take(), null);
  assert.equal(bridge.done(), false);
});
