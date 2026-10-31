import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGameAudio} from './browser.js';

function loadWorklet() {
  let Processor;
  const scope = {
    registerProcessor:(name, value) => { assert.equal(name, 'fallout2-output'); Processor = value; },
    AudioWorkletProcessor:class { constructor() { this.port = {messages:[], postMessage(message) { this.messages.push(message); }}; } },
  };
  new Function(...Object.keys(scope), readFileSync(new URL('./audio-worklet.js', import.meta.url), 'utf8'))(...Object.values(scope));
  return new Processor();
}
const block = (frames, start) => [0, 1].map(channel => Float32Array.from({length:frames}, (_, i) => start + i + channel / 2));
const quantum = processor => {
  const output = [new Float32Array(128), new Float32Array(128)];
  processor.process([], [output]);
  return output;
};

test('the audio thread plays queued blocks in order across quanta and reports underruns once', () => {
  const processor = loadWorklet();
  // Before the game's first block, silence is not an underrun.
  assert.equal(quantum(processor)[0][0], 0);
  processor.port.onmessage({data:block(200, 0)});
  processor.port.onmessage({data:block(200, 200)});
  const first = quantum(processor), second = quantum(processor);
  assert.deepEqual([first[0][0], first[0][127], second[0][0], second[1][0]], [0, 127, 128, 128.5]);
  assert.equal(processor.queued, 144);
  assert.equal(quantum(processor)[0][127], 383);
  const fourth = quantum(processor);
  assert.deepEqual([fourth[0][15], fourth[0][16], processor.underruns], [399, 0, 1]);
  quantum(processor);
  assert.equal(processor.underruns, 1);
  assert.deepEqual(processor.port.messages.at(-1), {queued:0, received:400, underruns:1});
});

function environment({worklet = true, state = 'running'} = {}) {
  const posted = [], log = [];
  class Node {
    constructor(context, name, options) {
      this.options = options;
      this.port = {postMessage:(planes, transfer) => { assert.equal(transfer.length, 2); posted.push(planes); }};
    }
    connect(target) { log.push(['worklet connected', target]); }
  }
  class Context {
    state = state; sampleRate = 48000; destination = 'speaker'; baseLatency = 0;
    audioWorklet = worklet ? {addModule:url => { log.push(['module', url.endsWith('/audio-worklet.js')]); return Promise.resolve(); }} : undefined;
    resume() { return Promise.resolve(); }
    createScriptProcessor(bufferSize, inputs, channels) {
      log.push(['processor', bufferSize, channels]);
      return {bufferSize, onaudioprocess:null, disconnect:() => log.push(['processor disconnected'])};
    }
  }
  return {posted, log, environment:{AudioContext:Context, AudioWorkletNode:Node, navigator:{}, document:{hidden:false}}};
}
// What SDL2 does with the context it is given (SDL_emscriptenaudio.c).
function openSdlDevice(sdl2) {
  let calls = 0;
  const processor = sdl2.audioContext.createScriptProcessor(2048, 0, 2);
  processor.onaudioprocess = event => {
    calls++;
    for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel++) event.outputBuffer.getChannelData(channel).fill(calls);
  };
  return {processor, calls:() => calls};
}

test('SDL blocks fill a queue on the audio thread instead of the ScriptProcessor', async () => {
  const {posted, log, environment:page} = environment();
  const audio = createGameAudio(page), sdl2 = audio.start();
  const device = openSdlDevice(sdl2);
  await new Promise(resolve => setTimeout(resolve));
  const output = sdl2.output;
  assert.ok(output);
  assert.deepEqual(log.map(entry => entry[0]), ['module', 'processor', 'processor disconnected', 'worklet connected']);
  assert.equal(device.processor.onaudioprocess, null);
  assert.deepEqual(output.node.options, {numberOfInputs:0, outputChannelCount:[2]});
  // Filled to two blocks at once, each block one SDL callback.
  assert.equal(device.calls(), 2);
  assert.deepEqual(posted.map(planes => [planes[0].length, planes[0][0], planes[1][0]]), [[2048, 1, 1], [2048, 2, 2]]);
  // Blocks in flight count as queued; the queue is topped up to its target.
  output.node.port.onmessage({data:{queued:1024, received:2048, underruns:0}});
  assert.equal(device.calls(), 3);
  // An underrun makes the queue deeper, up to eight blocks.
  output.node.port.onmessage({data:{queued:0, received:6144, underruns:1}});
  assert.equal(output.target, 5120);
  assert.equal(device.calls(), 6);
  for (let n = 2; n < 20; n++) output.node.port.onmessage({data:{queued:0, received:0, underruns:n}});
  assert.equal(output.target, 8 * 2048);
  assert.deepEqual(audio.status().queue, {frames:16384, underruns:19});
});

test('the queue starts at the output latency plus a block and returns to it when calm', async () => {
  const {environment:page} = environment();
  const clock = {time:0};
  const realNow = performance.now;
  performance.now = () => clock.time;
  try {
    class Bluetooth extends page.AudioContext { baseLatency = 0.1125; }
    const sdl2 = createGameAudio({...page, AudioContext:Bluetooth}).start();
    openSdlDevice(sdl2);
    await new Promise(resolve => setTimeout(resolve));
    const output = sdl2.output, report = underruns => output.node.port.onmessage({data:{queued:1 << 20, received:0, underruns}});
    assert.equal(output.target, 5400 + 2048);
    report(1); report(2);
    assert.equal(output.target, 7448 + 2048);
    clock.time += 4000; report(2);
    assert.equal(output.target, 9496);
    for (let n = 0; n < 10; n++) { clock.time += 5001; report(2); }
    assert.equal(output.target, 7448);
  } finally { performance.now = realNow; }
});

test('a suspended context leaves filling to the first report; without AudioWorklet SDL plays as before', async () => {
  const suspended = environment({state:'suspended'});
  const sdl2 = createGameAudio(suspended.environment).start();
  const device = openSdlDevice(sdl2);
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(device.calls(), 0);
  sdl2.output.node.port.onmessage({data:{queued:0, received:0, underruns:0}});
  assert.equal(device.calls(), 2);

  const plain = environment({worklet:false});
  const fallback = createGameAudio(plain.environment).start();
  const native = openSdlDevice(fallback);
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(fallback.output, undefined);
  assert.equal(typeof native.processor.onaudioprocess, 'function');
  assert.deepEqual(plain.log.map(entry => entry[0]), ['processor']);
});
