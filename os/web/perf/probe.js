// Injected by run.mjs before the launcher's own scripts; never part of the
// app. Starts the engine's webperf autotest with the game and measures, per
// phase (the autotest's marks): IndexedDB transactions, user storage calls,
// SHA-256 work, long main-thread tasks and the audio output. run.mjs reads window.__webPerf over
// the DevTools protocol. Expects createAudioAnalysisSource (audio-analysis.js).
(() => {
  const ARGS = ['--dev-autotest=/tmp/webperf', '--dev-autotest-scenario=webperf', '--dev-skip-opening-movies'];
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
        audio:{callbacks:0, late:0, maxGapMs:0, workMs:0, maxWorkMs:0},
      });
    }
    return phases.get(name);
  };
  // Repeated phases (three rounds of saves) are counted apart: save, save#2…
  const mark = name => {
    const seen = marks.filter(item => item.mark === name).length;
    phase = seen ? name + '#' + (seen + 1) : name;
    marks.push({name:phase, mark:name, at:performance.now()});
    bucket();
  };
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

  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const stats = bucket().longTasks;
        stats.count++; stats.ms += entry.duration; stats.maxMs = Math.max(stats.maxMs, entry.duration);
      }
    }).observe({type:'longtask'});
  } catch { /* Not every browser reports long tasks. */ }

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
    const context = node.context, original = node.onaudioprocess;
    const periodMs = node.bufferSize / context.sampleRate * 1000;
    audioInfo = {sampleRate:context.sampleRate, bufferSize:node.bufferSize, baseLatency:context.baseLatency ?? null};
    worker.postMessage({type:'start', sampleRate:context.sampleRate});
    let last = null;
    node.onaudioprocess = function(event) {
      const start = performance.now();
      try { return original.call(this, event); }
      finally {
        const stats = bucket().audio, work = performance.now() - start;
        if (last !== null && !document.hidden) {
          const gap = start - last;
          stats.maxGapMs = Math.max(stats.maxGapMs, gap);
          if (gap > periodMs * 1.5) stats.late++;
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
