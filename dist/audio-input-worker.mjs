import { createInputAnalysis } from './audio-input.mjs';

let analysis;
self.onmessage = ({ data }) => {
  if (data.type === 'initialize') {
    analysis = createInputAnalysis({
      ...data,
      onSignal: (signal) => self.postMessage({ type: 'signal', signal }),
      onNote: (event) => self.postMessage({ type: 'note', event }),
    });
  } else {
    analysis.push(data.samples, data.firstSampleFrame);
    self.postMessage({ type: 'ready' });
  }
};
