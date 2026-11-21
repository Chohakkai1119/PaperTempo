class PaperTempoCapture extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.blockSize = processorOptions.blockSize;
    this.block = new Float32Array(this.blockSize);
    this.used = 0;
    this.inFlight = 0;
    this.port.onmessage = () => { this.inFlight = Math.max(0, this.inFlight - 1); };
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples?.length) {
      this.used = 0;
      return true;
    }
    for (let index = 0; index < samples.length; index += 1) {
      if (this.used === 0) this.firstFrame = currentFrame + index;
      this.block[this.used++] = samples[index];
      if (this.used !== this.blockSize) continue;
      if (this.inFlight < 5) {
        this.port.postMessage({ samples: this.block, firstSampleFrame: this.firstFrame }, [this.block.buffer]);
        this.block = new Float32Array(this.blockSize);
        this.inFlight += 1;
      }
      this.used = 0;
    }
    return true;
  }
}
registerProcessor('papertempo-capture', PaperTempoCapture);
