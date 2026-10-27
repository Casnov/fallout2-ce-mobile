// Injected by run.mjs before the launcher's own scripts; never part of the
// app. Starts the engine's webperf autotest with the game and measures, per
// phase (the autotest's marks): IndexedDB transactions, user storage calls,
// SHA-256 work, long main-thread tasks, the timing of audio callbacks, what
// the browser actually played (a tap on the audio thread) and the audio output. run.mjs reads window.__webPerf over the DevTools protocol. Expects
// createAudioAnalysisSource (audio-analysis.js) and PLAY_MOVIES.
(() => {
  const ARGS = ['--dev-autotest=/tmp/webperf', '--dev-autotest-scenario=webperf', ...(PLAY_MOVIES ? [] : ['--dev-skip-opening-movies'])];
  const LOG = '/tmp/webperf/log.txt';
  const marks = [], phases = new Map();
  let phase = 'start', module = null, exitStatus = null, finalLog = '', audioInfo = null;
  const bucket = (name = phase) => {
    if (!phases.has(name)) {
      phases.set(name, {
        readwrite:{count:0, ms:0, maxMs:0, strict:0, failed:0},
        readonly:{count:0, ms:0, maxMs:0, strict:0, failed:0},
        digest:{count:0, bytes:0, ms:0},
        longTasks:{count:0, ms:0, maxMs:0},
        store:{},
        // Gaps between audio callbacks, in buffer periods; a gap over two
        // periods can no longer be hidden by the browser's double buffering.
        gaps:{over1_5:0, over2:0, over3:0, over2InLongTask:0},
        playout:null,
        output:null,
        audio:{callbacks:0, maxGapMs:0, workMs:0, maxWorkMs:0},
      });
    }
    return phases.get(name);
  };
  // Repeated phases (three rounds of saves) are counted apart: save, save#2…
  const mark = name => {
    const seen = marks.filter(item => item.mark === name).length;
    phase = seen ? name + '#' + (seen + 1) : name;
    marks.push({name:phase, mark:name, at:performance.now(), counters:counters()});
    bucket();
  };
  // Boot, and the opening movies when the run plays them, until the first mark.
  marks.push({name:'start', mark:'start', at:performance.now(), counters:{playout:null, output:null}});
  bucket();

  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(stores, mode, options) {
    const tx = transaction.call(this, stores, mode, options);
    const stats = bucket()[tx.mode === 'readonly' ? 'readonly' : 'readwrite'];
    const start = performance.now();
    const done = failed => {
      const ms = performance.now() - start;
      stats.count++; stats.ms += ms; stats.maxMs = Math.max(stats.maxMs, ms);
      if (tx.durability === 'strict') stats.strict++;
      if (failed) stats.failed++;
    };
    tx.addEventListener('complete', () => done(false));
    tx.addEventListener('abort', () => done(true));
    return tx;
  };

  const digest = SubtleCrypto.prototype.digest;
  SubtleCrypto.prototype.digest = function(algorithm, data) {
    const stats = bucket().digest, start = performance.now();
    return digest.call(this, algorithm, data).then(value => {
      stats.count++; stats.bytes += data.byteLength; stats.ms += performance.now() - start;
      return value;
    });
  };

  const longTasks = [], bigGaps = [];
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const stats = bucket().longTasks;
        stats.count++; stats.ms += entry.duration; stats.maxMs = Math.max(stats.maxMs, entry.duration);
        longTasks.push([entry.startTime, entry.startTime + entry.duration]);
      }
    }).observe({type:'longtask'});
  } catch { /* Not every browser reports long tasks. */ }
  // A long task is reported after it ends: match the gaps when reporting.
  const matchGaps = () => {
    for (const gap of bigGaps.splice(0)) {
      if (longTasks.some(([start, end]) => start < gap.end && end > gap.start)) phases.get(gap.phase).gaps.over2InLongTask++;
    }
  };

  // Cumulative counters taken at every mark, per phase in the report:
  // Chrome's own playback statistics (where available) and the output tap.
  let context = null, output = null;
  const playout = () => {
    const stats = context?.playbackStats ?? context?.playoutStats;
    if (!stats) return null;
    const value = {};
    for (const key in stats) if (typeof stats[key] === 'number') value[key] = stats[key];
    return value;
  };
  const counters = () => ({playout:playout(), output:output && {...output}});

  // What the ScriptProcessor actually handed to the output, seen on the audio
  // thread. When its event runs late, Chrome plays the buffer from two
  // periods ago again (a stale block: an exact repeat at that lag) or zeroes
  // it while the previous event still runs (a dropout: exactly one block of
  // silence inside sound, unlike pauses in the sound itself). Both are
  // audible; neither shows in the event handler's own data.
  const TAP = `registerProcessor('webperf-output-tap', class extends AudioWorkletProcessor {
    constructor({processorOptions}) {
      super();
      this.period = processorOptions.period;
      this.lag = 2 * this.period;
      this.history = new Float32Array(this.lag + 128);
      this.at = 0; this.seen = 0; this.zeroRun = 0; this.lastSounding = false; this.inStale = false; this.sent = 0;
      this.counts = {soundingSeconds:0, staleBlocks:0, staleSeconds:0, dropouts:0};
    }
    process(inputs, outputs) {
      const input = inputs[0][0];
      if (!input) return true;
      const n = input.length, size = this.history.length;
      let sounding = false, zero = true;
      for (let i = 0; i < n; i++) { const x = input[i]; if (x !== 0) zero = false; if (x > 1e-4 || x < -1e-4) { sounding = true; break; } }
      let stale = false;
      if (sounding) {
        this.counts.soundingSeconds += n / sampleRate;
        if (this.seen >= this.lag) {
          stale = true;
          for (let i = 0; i < n && stale; i++) stale = input[i] === this.history[(this.at + i + size - this.lag) % size];
        }
      }
      if (stale) { this.counts.staleSeconds += n / sampleRate; if (!this.inStale) this.counts.staleBlocks++; }
      this.inStale = stale;
      if (zero) this.zeroRun += n;
      else {
        // Whole 128-frame quanta: a zeroed block, perhaps with a silent quantum
        // of the sound itself at either side.
        if (sounding && this.lastSounding && this.zeroRun >= this.period && this.zeroRun <= this.period + 256) this.counts.dropouts++;
        this.zeroRun = 0; this.lastSounding = sounding;
      }
      for (let i = 0; i < n; i++) this.history[(this.at + i) % size] = input[i];
      this.at = (this.at + n) % size; this.seen += n;
      if (currentTime - this.sent >= 0.25) { this.port.postMessage(this.counts); this.sent = currentTime; }
      return true;
    }
  });`;
  async function tapOutput(node) {
    try {
      await context.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], {type:'text/javascript'})));
      const tap = new AudioWorkletNode(context, 'webperf-output-tap', {processorOptions:{period:node.bufferSize}});
      tap.port.onmessage = ({data}) => { output = data; };
      node.connect(tap);
      tap.connect(context.destination); // Silent: keeps the tap pulled.
    } catch (error) { console.warn('webperf: no output tap', error); }
  }

  // Audio blocks are analysed in a worker, away from the audio callback.
  const worker = new Worker(URL.createObjectURL(new Blob([createAudioAnalysisSource + `
    let analysis = null;
    onmessage = ({data}) => {
      if (data.type === 'start') analysis = createAudioAnalysis(data.sampleRate);
      else if (data.type === 'block') analysis?.push(data.samples, data.phase);
      else postMessage(analysis?.result() ?? null);
    };`], {type:'text/javascript'})));
  const watchAudio = setInterval(() => {
    const node = module?.SDL2?.audio?.scriptProcessorNode;
    if (!node || typeof node.onaudioprocess !== 'function') return;
    clearInterval(watchAudio);
    context = node.context;
    const original = node.onaudioprocess;
    const periodMs = node.bufferSize / context.sampleRate * 1000;
    audioInfo = {sampleRate:context.sampleRate, bufferSize:node.bufferSize, baseLatency:context.baseLatency ?? null};
    worker.postMessage({type:'start', sampleRate:context.sampleRate});
    tapOutput(node);
    let last = null;
    node.onaudioprocess = function(event) {
      const start = performance.now();
      try { return original.call(this, event); }
      finally {
        const stats = bucket().audio, work = performance.now() - start;
        if (last !== null && !document.hidden) {
          const gap = start - last, gaps = bucket().gaps;
          stats.maxGapMs = Math.max(stats.maxGapMs, gap);
          if (gap > periodMs * 1.5) gaps.over1_5++;
          if (gap > periodMs * 2) { gaps.over2++; bigGaps.push({phase, start:last, end:start}); }
          if (gap > periodMs * 3) gaps.over3++;
        }
        last = start;
        stats.callbacks++; stats.workMs += work; stats.maxWorkMs = Math.max(stats.maxWorkMs, work);
        const samples = event.outputBuffer.getChannelData(0).slice();
        worker.postMessage({type:'block', samples, phase}, [samples.buffer]);
      }
    };
  }, 250);

  // Calls of the user store's methods, nested ones included (read inside
  // seal): which storage operations the transactions come from. A save
  // exchange reopens the store, so a new store object is wrapped again.
  const wrapped = new WeakSet();
  setInterval(() => {
    const store = module?.UserIO?.backend?.store;
    if (!store || wrapped.has(store)) return;
    wrapped.add(store);
    for (const [name, method] of Object.entries(store)) {
      if (typeof method !== 'function' || name === 'close') continue;
      store[name] = function(...args) {
        const calls = bucket().store;
        calls[name] = (calls[name] || 0) + 1;
        return method.apply(this, args);
      };
    }
  }, 250);

  const readLog = () => {
    try { return module.FS.readFile(LOG, {encoding:'utf8'}); } catch { return finalLog; }
  };
  // fallout2-ce.js defines createFallout2 with `var`: the setter receives it.
  let factory = null;
  Object.defineProperty(window, 'createFallout2', {
    configurable:true,
    set(value) { factory = value; },
    get() {
      return factory && (options => {
        const exit = options.onExit;
        options.webPerfMark = mark;
        options.onExit = status => { finalLog = readLog(); exitStatus = status; exit?.(status); };
        return factory(options).then(value => {
          module = value;
          const callMain = value.callMain;
          value.callMain = args => callMain.call(value, [...args, ...ARGS]);
          return value;
        });
      });
    },
  });

  window.__webPerf = {
    state:() => ({started:module !== null, phase, marks:marks.map(item => item.name), done:exitStatus !== null, exitStatus}),
    log:readLog,
    async report() {
      matchGaps();
      const end = counters();
      const delta = (from, to) => from && to ? Object.fromEntries(Object.keys(to).map(key => [key, to[key] - (from[key] ?? 0)])) : null;
      marks.forEach((item, index) => {
        const next = marks[index + 1]?.counters ?? end;
        const stats = phases.get(item.name);
        stats.playout = delta(item.counters.playout, next.playout);
        // The tap starts with the audio: a phase before it counts from zero.
        stats.output = delta(item.counters.output ?? (next.output && {}), next.output);
      });
      const audio = await new Promise(resolve => {
        worker.onmessage = ({data}) => resolve(data);
        worker.postMessage({type:'result'});
        setTimeout(() => resolve(null), 5000);
      });
      const timeline = marks.map((item, index) => ({name:item.name, at:item.at,
        ms:(marks[index + 1]?.at ?? performance.now()) - item.at}));
      return {
        env:{userAgent:navigator.userAgent, cores:navigator.hardwareConcurrency ?? null,
          memoryGb:navigator.deviceMemory ?? null, audio:audioInfo,
          build:document.body.dataset.webBuild ?? null, version:document.body.dataset.version ?? null},
        timeline, phases:Object.fromEntries(phases), audio, exitStatus, log:readLog(),
      };
    },
  };
})();
