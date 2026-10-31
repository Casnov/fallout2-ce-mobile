// DOM owns keyboard focus and audio permission; the engine reads state on its
// own frame, without re-entering an Asyncify-suspended WASM stack from events.
export function fitCanvas(width, height, aspect) {
  const w = Math.min(width, height * aspect);
  const h = w / aspect;
  return {left:(width - w) / 2, top:(height - h) / 2, width:w, height:h};
}

export function createGameViewport(canvas, environment = globalThis) {
  let aspect = null;
  let editing = false, beforeKeyboard = null;
  const update = () => {
    if (!aspect) return;
    const width = environment.innerWidth, height = environment.innerHeight;
    // Fallback for browsers which resize the layout viewport despite the
    // interactive-widget preference. Keep the game behind the keyboard, also
    // during its closing animation. A width change still permits rotation.
    const sameOrientation = beforeKeyboard && Math.abs(width - beforeKeyboard.width) <= 4;
    if (beforeKeyboard && !editing && (!sameOrientation || height >= beforeKeyboard.height - 4)) beforeKeyboard = null;
    // Keep the original landscape snapshot while rotating with an open IME.
    // Portrait uses its own dimensions; returning to landscape reuses the
    // unobscured surface instead of fitting the game above the keyboard.
    const locked = sameOrientation ? beforeKeyboard : null;
    const rect = fitCanvas(locked?.width ?? width, locked?.height ?? height, aspect);
    for (const key of ['left', 'top', 'width', 'height']) {
      canvas.style.setProperty('--canvas-' + key, rect[key] + 'px');
    }
  };
  environment.addEventListener('resize', update);
  return {
    configure(width, height) { aspect = width / height; update(); },
    setEditing(value) {
      if (value && !editing && environment.matchMedia?.('(pointer:coarse)').matches) {
        beforeKeyboard ??= {width:environment.innerWidth, height:environment.innerHeight};
      }
      editing = value;
      update();
    },
  };
}

// This bridge records interruptions only. All gestures still travel through
// SDL into the same native MUI/map recognizers as Android. Native code polls
// it on its own stack; DOM listeners never call a suspended WASM function.
export const WINDOW_ACTIVE = 1, CANCEL_TOUCHES = 2, VIEWPORT_CHANGED = 4, WINDOW_INTERRUPTED = 8;
export function createGameWindow(canvas,{environment = globalThis,isBlocked = () => false} = {}) {
  const page = environment.document;
  let focused = page.hasFocus?.() ?? true, pending = 0;
  const geometry = () => {
    const r = canvas.getBoundingClientRect();
    return [r.left,r.top,r.width,r.height,environment.devicePixelRatio || 1];
  };
  let previous = geometry();
  const cancel = () => { pending |= CANCEL_TOUCHES; };
  const resize = () => {
    const next = geometry();
    if (next.some((value,index) => value !== previous[index])) {
      pending |= VIEWPORT_CHANGED;
      // Include already-released taps waiting in SDL/MUI queues: their old
      // coordinates must not activate a widget after its layout has moved.
      cancel();
      previous = next;
    }
  };
  canvas.addEventListener('touchcancel',cancel,{passive:true});
  environment.addEventListener('blur',() => { focused = false; pending |= WINDOW_INTERRUPTED; cancel(); });
  environment.addEventListener('focus',() => { focused = true; cancel(); });
  environment.addEventListener('resize',resize);
  environment.addEventListener('orientationchange',() => { cancel(); pending |= VIEWPORT_CHANGED; });
  page.addEventListener('visibilitychange',() => {
    focused = !page.hidden && (page.hasFocus?.() ?? true); cancel();
    // iOS can freeze JS before the native loop observes hiding. Preserve the
    // interruption even if the whole away/return cycle occurs between polls.
    if (page.hidden) pending |= WINDOW_INTERRUPTED;
  });
  // Some mobile web views omit a focus event when returning from system UI.
  // An ordinary interaction on the visible page is also proof of focus.
  for (const type of ['pointerdown','touchstart','keydown']) page.addEventListener(type,() => {
    if (!page.hidden) focused = true;
  },{capture:true,passive:true});
  return {poll() {
    const flags = pending; pending = 0;
    return flags | (!page.hidden && focused && !isBlocked() ? WINDOW_ACTIVE : 0);
  }};
}

export function fieldInCanvas(canvas, logical, field) {
  const scale = Math.min(canvas.width / logical[0], canvas.height / logical[1]);
  const x = (canvas.width - logical[0] * scale) / 2;
  const y = (canvas.height - logical[1] * scale) / 2;
  const sx = canvas.rect.width / canvas.width;
  const sy = canvas.rect.height / canvas.height;
  return {left:canvas.rect.left + (x + field[0] * scale) * sx,
    top:canvas.rect.top + (y + field[1] * scale) * sy,
    width:field[2] * scale * sx, height:field[3] * scale * sy,
    scale:scale * sy};
}

export function createTextInput(input, canvas, viewport) {
  let active = false, dirty = false, composing = false, finished = false;
  const finish = event => {
    // A form must never navigate, but an IME's candidate-confirming key or
    // beforeinput must keep its native behavior until composition completes.
    if (event.type === 'submit') event.preventDefault();
    if (!active || composing || event.isComposing) return;
    event.preventDefault();
    // An Android IME may submit the form without a usable Enter keydown.
    // Consume the final DOM value before the engine closes its text dialog.
    dirty = finished = true;
    input.blur();
  };
  input.form?.addEventListener('submit', finish);
  // Keep native editing, selection, paste and IME. Stop SDL's document-level
  // keyboard listeners from also inserting/removing the same characters.
  for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'compositionstart', 'compositionupdate', 'compositionend', 'touchstart', 'touchend']) {
    input.addEventListener(type, event => event.stopPropagation());
  }
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; dirty = true; });
  input.addEventListener('input', () => { dirty = true; });
  input.addEventListener('beforeinput', event => {
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') finish(event);
  });
  input.addEventListener('keydown', event => {
    // 229 can be the IME's candidate-confirming Enter, including Safari's
    // compositionend/keydown ordering. It must not also confirm the dialog.
    if (event.key === 'Enter' && event.keyCode !== 229) finish(event);
  });
  return {
    begin() {
      if (!active) {
        viewport?.setEditing(true);
        active = true; dirty = composing = finished = false;
      }
    },
    end() {
      active = false;
      dirty = composing = finished = false;
      input.hidden = true;
      input.blur();
      input.value = '';
      viewport?.setEditing(false);
    },
    take() {
      if (!active || !dirty || composing) return null;
      dirty = false;
      return Array.from(input.value, ch => ch.codePointAt(0));
    },
    done() {
      if (composing || dirty) return false;
      const result = finished;
      finished = false;
      return result;
    },
    update(value, logical, field, fontSize, maxLength) {
      if (!active) return;
      const first = input.hidden;
      const position = fieldInCanvas({width:canvas.width, height:canvas.height,
        rect:canvas.getBoundingClientRect()}, logical, field);
      for (const key of ['left', 'top', 'width', 'height']) input.style[key] = position[key] + 'px';
      input.style.fontSize = Math.max(16, fontSize * position.scale) + 'px';
      input.maxLength = maxLength;
      if (!dirty && !composing) {
        const next = String.fromCodePoint(...value);
        if (input.value !== next) {
          const start = input.selectionStart, end = input.selectionEnd;
          input.value = next;
          if (!first) input.setSelectionRange(Math.min(start, next.length), Math.min(end, next.length));
        }
      }
      input.hidden = false;
      // Some mobile browsers reject programmatic focus outside the original
      // gesture. The visible input sits exactly over the game's field, so a
      // direct tap always provides the required gesture, including after blur.
      if (first) input.focus({preventScroll:true});
    },
  };
}

// SDL2 plays through a ScriptProcessor, filled on the main thread one block at
// a time. An output that takes audio in bursts of another size (Bluetooth,
// many Android phones) reaches a block before it is written and plays stale
// samples, a few times a second. Where AudioWorklet exists, SDL's block
// callback fills a queue that the audio thread plays from instead
// (audio-worklet.js). The result, shaped like the ScriptProcessor for timing
// probes (onaudioprocess, bufferSize, context), becomes sdl2.output.
function routeAudioOutput(context, sdl2, environment) {
  const create = context.createScriptProcessor, Node = environment.AudioWorkletNode;
  if (!context.audioWorklet || typeof create !== 'function' || !Node) return;
  const ready = context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url).href)
    .then(() => true, () => false);
  context.createScriptProcessor = function(bufferSize, inputs, channels) {
    const processor = create.call(this, bufferSize, inputs, channels);
    // SDL sets the handler and connects the node right after creating it;
    // until the worklet is ready, the ScriptProcessor plays as before.
    ready.then(loaded => {
      if (loaded && typeof processor.onaudioprocess === 'function') sdl2.output = queueOutput(context, processor, channels, Node);
    });
    return processor;
  };
}

function queueOutput(context, processor, channels, Node, now = () => performance.now()) {
  const frames = processor.bufferSize, node = new Node(context, 'fallout2-output', {numberOfInputs:0, outputChannelCount:[channels]});
  // The output's own latency covers the bursts it takes audio in; one block
  // more covers a late main thread.
  const base = Math.max(2 * frames, Math.round((context.baseLatency || 0) * context.sampleRate) + frames);
  const output = {node, context, bufferSize:frames, onaudioprocess:processor.onaudioprocess, target:base, underruns:0};
  let queued = 0, sent = 0, calm = now();
  const fill = () => {
    while (queued < output.target) {
      const planes = Array.from({length:channels}, () => new Float32Array(frames));
      output.onaudioprocess({outputBuffer:{numberOfChannels:channels, length:frames, sampleRate:context.sampleRate,
        getChannelData:channel => planes[channel]}});
      node.port.postMessage(planes, planes.map(plane => plane.buffer));
      queued += frames; sent += frames;
    }
  };
  node.port.onmessage = ({data}) => {
    // Blocks still in flight to the audio thread count as queued.
    queued = data.queued + sent - data.received;
    // Each underrun deepens the queue; after 5 calm seconds it returns
    // towards the base, so stalls while loading leave no lasting latency.
    if (data.underruns > output.underruns) {
      output.underruns = data.underruns;
      output.target = Math.min(8 * frames, output.target + frames / 2);
      calm = now();
    } else if (output.target > base && now() - calm > 5000) {
      output.target = Math.max(base, output.target - frames / 4);
      calm = now();
    }
    fill();
  };
  processor.onaudioprocess = null;
  processor.disconnect();
  node.connect(context.destination);
  // A suspended context keeps SDL's own silence timer running the game; the
  // worklet's first report after it starts playing fills the queue.
  if (context.state === 'running') fill();
  return output;
}

export function createGameAudio(environment = globalThis) {
  let context = null, sdl2 = null;
  let lastError = null;
  let paused = false;
  const resume = () => {
    if (paused || !context || context.state === 'closed' || environment.document.hidden) return;
    if (context.state !== 'running') {
      context.resume().catch(error => { lastError = String(error); });
    }
  };
  return {
    // Call synchronously from Play, before fetching/compiling the module.
    start() {
      try {
        const Constructor = environment.AudioContext || environment.webkitAudioContext;
        if (!Constructor) return {};
        // Optional API: a rejected session preference must not disable sound.
        try {
          if (environment.navigator.audioSession) environment.navigator.audioSession.type = 'playback';
        } catch (error) { lastError = String(error); }
        context = new Constructor({latencyHint:'interactive'});
        const created = context;
        let previous = created.state;
        created.addEventListener?.('statechange',() => {
          const state = created.state, interrupted = previous === 'interrupted';
          previous = state;
          // iOS may end a system audio interruption in suspended state while
          // the page stays visible. Reuse the already-unlocked context once;
          // user gestures remain the fallback if the browser rejects resume.
          if (created === context && interrupted && state === 'suspended') resume();
        });
        resume();
        // SDL2 uses this exact context instead of creating a locked second one.
        sdl2 = {audioContext:context};
        // Optional: without the queued output SDL's ScriptProcessor plays.
        try { routeAudioOutput(context, sdl2, environment); } catch (error) { lastError = String(error); }
        return sdl2;
      } catch (error) { lastError = String(error); return {}; }
    },
    resume,
    async pause() {
      paused = true;
      if (context && context.state !== 'closed') await context.suspend();
    },
    unpause() { paused = false; resume(); },
    status:() => ({state:context?.state || 'unavailable', sampleRate:context?.sampleRate,
      baseLatency:context?.baseLatency, outputLatency:context?.outputLatency, error:lastError,
      queue:sdl2?.output ? {frames:sdl2.output.target, underruns:sdl2.output.underruns} : null}),
    stop() { if (context && context.state !== 'closed') context.close().catch(() => {}); },
  };
}

// Optional local test instrumentation. Observe SDL's existing callback without
// modifying samples, scheduling audio, or installing a second audio graph.
export function createAudioTiming({now = () => performance.now(), active = () => true} = {}) {
  let node = null, original = null, wrapper = null, lastStart = null;
  let callbacks = 0, maxGapMs = 0, maxWorkMs = 0;
  let recent = [];
  const prune = time => { while (recent.length && recent[0].time < time - 5000) recent.shift(); };
  const detach = () => {
    if (node && node.onaudioprocess === wrapper) node.onaudioprocess = original;
    node = original = wrapper = null;
    lastStart = null;
  };
  return {
    attach(next) {
      if (next === node) return;
      detach();
      if (!next || typeof next.onaudioprocess !== 'function') return;
      node = next;
      original = node.onaudioprocess;
      wrapper = function(event) {
        const measure = active();
        const start = now();
        const gap = measure && lastStart !== null ? start - lastStart : 0;
        if (measure) maxGapMs = Math.max(maxGapMs, gap);
        lastStart = measure ? start : null;
        try {
          return original.call(this, event);
        } finally {
          if (measure) {
            callbacks++;
            const work = now() - start;
            maxWorkMs = Math.max(maxWorkMs, work);
            const rate = event.outputBuffer?.sampleRate;
            const period = rate ? node.bufferSize / rate * 1000 : null;
            recent.push({time:start, gap, work, late:period !== null && gap > period * 1.5});
            prune(start);
          }
        }
      };
      node.onaudioprocess = wrapper;
    },
    status:() => {
      prune(now());
      return {callbacks, maxGapMs, maxWorkMs, bufferSize:node?.bufferSize || null,
        recent:{callbacks:recent.length, maxGapMs:Math.max(0, ...recent.map(x => x.gap)),
          maxWorkMs:Math.max(0, ...recent.map(x => x.work)), late:recent.filter(x => x.late).length}};
    },
    resetGap() { lastStart = null; recent = []; },
    stop:detach,
  };
}
