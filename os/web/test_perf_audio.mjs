import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// The analysis used by the performance probe (perf/audio-analysis.js).
const source = await readFile(new URL('./perf/audio-analysis.js', import.meta.url), 'utf8');
const createAudioAnalysis = vm.runInNewContext(source + ';createAudioAnalysis');
const RATE = 44100;

function noise(seconds, seed = 1) {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    samples[i] = ((seed >>> 8) / 0x1000000 - 0.5) * 0.6;
  }
  return samples;
}

function analyse(samples, phaseAt = () => 'play') {
  const analysis = createAudioAnalysis(RATE);
  for (let at = 0; at < samples.length; at += 2048) analysis.push(samples.slice(at, at + 2048), phaseAt(at));
  return analysis.result();
}

test('a stretch of earlier output played again is found at any offset, with its lag and length', () => {
  const samples = noise(6);
  const lag = 57301, from = 3 * RATE + 777, length = RATE / 2;
  samples.copyWithin(from, from - lag, from - lag + length);
  const result = analyse(samples, at => at >= 3 * RATE ? 'after-saves' : 'idle');
  assert.equal(result.repeats.length, 1);
  const [repeat] = result.repeats;
  assert.equal(repeat.phase, 'after-saves');
  assert.ok(Math.abs(repeat.lagSeconds - lag / RATE) < 1e-9);
  assert.ok(Math.abs(repeat.seconds - length / RATE) < 0.01, String(repeat.seconds));
  assert.ok(Math.abs(repeat.atSeconds - from / RATE) < 0.01, String(repeat.atSeconds));
});

test('fresh sound has no repeats, and silence is counted but never matched', () => {
  assert.equal(analyse(noise(4, 7)).repeats.length, 0);
  const quiet = new Float32Array(3 * RATE);
  quiet.set(noise(1, 3), RATE);
  const result = analyse(quiet);
  assert.equal(result.repeats.length, 0);
  assert.equal(result.silentBlocks, Math.floor(RATE / 2048) * 2);
});
