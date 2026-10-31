// The game's audio on the audio thread (browser.js routeAudioOutput): blocks
// mixed on the main thread are queued and played from here, so an output that
// takes audio in bursts of any size takes it from the queue. Reports how much
// is queued to the main thread, which keeps the queue filled.
class GameOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.offset = 0;
    this.queued = 0;
    this.received = 0;
    this.underruns = 0;
    this.starving = false;
    this.unreported = 0;
    this.port.onmessage = ({data}) => {
      this.blocks.push(data);
      this.queued += data[0].length;
      this.received += data[0].length;
    };
  }

  process(inputs, [output]) {
    const frames = output[0].length;
    let written = 0;
    while (written < frames && this.blocks.length) {
      const block = this.blocks[0], count = Math.min(frames - written, block[0].length - this.offset);
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].set(block[Math.min(channel, block.length - 1)].subarray(this.offset, this.offset + count), written);
      }
      written += count;
      this.offset += count;
      this.queued -= count;
      if (this.offset === block[0].length) { this.blocks.shift(); this.offset = 0; }
    }
    // The rest of the quantum stays silent. Before the first block it is not
    // an underrun: the game has not started playing yet.
    const starving = written < frames && this.received > 0, began = starving && !this.starving;
    if (began) this.underruns++;
    this.starving = starving;
    this.unreported += frames;
    if (this.unreported >= 1024 || began) {
      this.port.postMessage({queued:this.queued, received:this.received, underruns:this.underruns});
      this.unreported = 0;
    }
    return true;
  }
}

registerProcessor('fallout2-output', GameOutput);
