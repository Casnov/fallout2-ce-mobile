// Finds exact repeats of earlier sound in the game's audio output, which is
// what a music stream replaying its old ring buffer produces, and counts
// silent blocks. Runs in the probe's worker (probe.js) and in its tests.
// Repeats are found at any sample offset: windows of the output are hashed
// on a grid, and every new window is looked up with a rolling hash, then
// compared sample for sample.
function createAudioAnalysis(sampleRate, {windowSize = 64, grid = 64, historySeconds = 12, minRepeatSeconds = 0.05} = {}) {
  const capacity = Math.ceil(historySeconds * sampleRate);
  const minRun = Math.round(minRepeatSeconds * sampleRate);
  const bits = new Int32Array(capacity);
  const loud = new Uint8Array(capacity);
  const starts = new Map();
  const base = 0x01000193;
  // base^(window - 1): the weight of a window's oldest sample.
  let power = 1;
  for (let i = 1; i < windowSize; i++) power = Math.imul(power, base);
  let total = 0, hash = 0, loudCount = 0, blocks = 0, silentBlocks = 0, phase = '';
  let run = null;
  const repeats = [];
  const same = (a, b) => {
    for (let i = 0; i < windowSize; i++) if (bits[(a + i) % capacity] !== bits[(b + i) % capacity]) return false;
    return true;
  };
  const long = value => value && value.last - value.first + windowSize >= minRun;
  const describe = value => ({phase:value.phase, atSeconds:value.first / sampleRate,
    lagSeconds:value.lag / sampleRate, seconds:(value.last - value.first + windowSize) / sampleRate});
  const finish = () => {
    if (long(run)) repeats.push(describe(run));
    run = null;
  };
  const prune = () => {
    for (const [key, start] of starts) if (start < total - capacity) starts.delete(key);
  };
  return {
    push(samples, blockPhase = '') {
      phase = blockPhase;
      blocks++;
      let peak = 0;
      for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
      if (peak < 1e-4) silentBlocks++;
      const view = new Int32Array(samples.buffer, samples.byteOffset, samples.length);
      for (let i = 0; i < view.length; i++) {
        const slot = total % capacity;
        if (total >= windowSize) {
          const old = (total - windowSize) % capacity;
          hash = (hash - Math.imul(bits[old], power)) | 0;
          loudCount -= loud[old];
        }
        bits[slot] = view[i];
        loud[slot] = Math.abs(samples[i]) > 1e-3 ? 1 : 0;
        hash = (Math.imul(hash, base) + view[i]) | 0;
        loudCount += loud[slot];
        total++;
        if (total < windowSize) continue;
        const start = total - windowSize;
        // Silence and near silence repeat by nature: neither indexed nor matched.
        if (loudCount < windowSize / 2) { if (run && start - run.last > grid) finish(); continue; }
        const earlier = starts.get(hash);
        if (earlier !== undefined && earlier >= total - capacity && earlier + windowSize <= start && same(earlier, start)) {
          const lag = start - earlier;
          if (run && run.lag === lag && start - run.last <= grid) run.last = start;
          else { finish(); run = {lag, first:start, last:start, phase}; }
        } else if (run && start - run.last > grid) finish();
        if (start % grid === 0) starts.set(hash, start);
      }
      if (starts.size > 2 * capacity / grid) prune();
    },
    result() {
      return {sampleRate, blocks, silentBlocks, repeats:long(run) ? [...repeats, describe(run)] : repeats.slice()};
    },
  };
}
