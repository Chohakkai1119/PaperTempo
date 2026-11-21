import { createInputAnalysis, INPUT_BLOCK_MS } from './audio-input.mjs';
import { resolveInputProfile } from './input-profiles.mjs';

export async function listMicrophones() {
  const devices = await globalThis.navigator?.mediaDevices?.enumerateDevices?.();
  return (devices ?? []).filter(({ kind }) => kind === 'audioinput');
}

export async function microphonePermission() {
  try {
    return (await globalThis.navigator?.permissions?.query({ name: 'microphone' }))?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function deviceSettings(track) {
  const { deviceId, sampleRate, channelCount, echoCancellation, noiseSuppression, autoGainControl, latency, sampleSize } =
    track.getSettings?.() ?? {};
  return { deviceId, sampleRate, channelCount, echoCancellation, noiseSuppression, autoGainControl, latency, sampleSize };
}

export async function openMicrophone({ deviceId, profile = resolveInputProfile('general') } = {}) {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!mediaDevices?.getUserMedia || !AudioContext) {
    throw new Error('Microphone access requires a supported browser and HTTPS or localhost.');
  }
  const context = new AudioContext();
  let stream;
  let source;
  let worklet;
  let analyser;
  let worker;
  let timer;
  let stopped = false;
  let onState;
  let lastCapture = 0;
  let waiting = 0;
  let clockOffset = 0;
  let mode = 'Analyser fallback';
  const readClock = () => {
    const before = performance.now();
    const audioTime = context.currentTime;
    clockOffset = (before + (performance.now() - before) / 2) - audioTime * 1000;
  };
  const frameTime = (frame) => clockOffset + frame * 1000 / context.sampleRate;

  function status() {
    const track = stream.getAudioTracks()[0];
    const settings = deviceSettings(track);
    return {
      deviceLabel: track.label, settings, sampleRate: context.sampleRate,
      trackState: track.readyState, muted: track.muted, enabled: track.enabled,
      streamActive: stream.active, contextState: context.state, mode,
      captureStalled: performance.now() - lastCapture > 500,
    };
  }

  const stateChanged = () => {
    if (stopped) return;
    if (context.state === 'running' && performance.now() - lastCapture > 500) readClock();
    onState?.(status());
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (worklet) {
      worklet.port.close();
      worklet.disconnect();
    }
    if (analyser) analyser.disconnect();
    source?.disconnect();
    worker?.terminate();
    context.removeEventListener('statechange', stateChanged);
    for (const track of stream?.getTracks() ?? []) {
      for (const event of ['mute', 'unmute', 'ended']) track.removeEventListener(event, stateChanged);
      track.stop();
    }
    void context.close().catch(() => {});
  };

  try {
    // Start resume in the user gesture, but request permission even if resume is
    // waiting for the browser. Keep the getUserMedia operation independently observable.
    const resume = context.resume().then(() => null, (error) => error);
    const supported = mediaDevices.getSupportedConstraints?.() ?? {};
    const music = Object.fromEntries(['echoCancellation', 'noiseSuppression', 'autoGainControl']
      .filter((key) => supported[key]).map((key) => [key, { ideal: false }]));
    if (supported.channelCount) music.channelCount = { ideal: 1 };
    // Use an exact ID only for an explicit selection. A silent fallback to a
    // different microphone would make device diagnostics misleading.
    if (deviceId) music.deviceId = { exact: deviceId };
    stream = await mediaDevices.getUserMedia({ audio: music });
    const resumeError = await resume;
    if (resumeError) throw resumeError;
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('The selected input returned no audio track.');
    source = context.createMediaStreamSource(stream);
    const blockSize = Math.round(context.sampleRate * INPUT_BLOCK_MS / 1000);
    if (context.audioWorklet && globalThis.AudioWorkletNode) {
      try {
        await context.audioWorklet.addModule(new URL('./audio-capture-worklet.mjs', import.meta.url));
        worklet = new AudioWorkletNode(context, 'papertempo-capture', {
          outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
          processorOptions: { blockSize },
        });
        mode = 'AudioWorklet';
      } catch {
        // The analyser provides capture in browsers without working AudioWorklets.
      }
    }
    for (const event of ['mute', 'unmute', 'ended']) track.addEventListener(event, stateChanged);
    context.addEventListener('statechange', stateChanged);
    readClock();

    return {
      context, status, stop,
      monitor(onSignal, onNote, onCaptureState) {
        onState = onCaptureState;
        lastCapture = performance.now();
        const signal = (reading) => {
          if (!stopped) onSignal(reading.pitches[0] ?? null, reading.rms, {
            ...reading, ...status(), at: frameTime(reading.frame),
          });
        };
        const note = (event) => {
          if (stopped || track.muted || !track.enabled || track.readyState !== 'live' || context.state !== 'running') return;
          const onsetMs = frameTime(event.frame);
          onNote({ ...event, onsetMs, at: onsetMs });
        };
        let local;
        function enableLocalAnalysis() {
          local = createInputAnalysis({ sampleRate: context.sampleRate, profile, onSignal: signal, onNote: note });
        }
        if (globalThis.Worker) {
          try {
            worker = new Worker(new URL('./audio-input-worker.mjs', import.meta.url), { type: 'module' });
            worker.onmessage = ({ data }) => {
              if (data.type === 'signal') signal(data.signal);
              if (data.type === 'note') note(data.event);
              if (data.type === 'ready') waiting -= 1;
            };
            worker.onerror = () => {
              if (stopped) return;
              worker.terminate();
              worker = null;
              enableLocalAnalysis();
            };
            worker.postMessage({ type: 'initialize', sampleRate: context.sampleRate, profile });
          } catch {
            worker?.terminate();
            worker = null;
          }
        }
        if (!worker) enableLocalAnalysis();

        function feed(samples, firstSampleFrame) {
          if (stopped) return;
          lastCapture = performance.now();
          if (!worker) local.push(samples, firstSampleFrame);
          else if (waiting < 5) {
            waiting += 1;
            worker.postMessage({ samples, firstSampleFrame }, [samples.buffer]);
          }
        }
        if (worklet) {
          worklet.port.onmessage = ({ data }) => {
            worklet.port.postMessage(null);
            feed(data.samples, data.firstSampleFrame);
          };
          worklet.onprocessorerror = fallBackToAnalyser;
          // The worklet writes no output. Connecting its silent output keeps
          // the graph responding in engines that only pull connected nodes.
          source.connect(worklet);
          worklet.connect(context.destination);
        }

        let lastFrame = Math.round(context.currentTime * context.sampleRate);
        let window;
        function attachAnalyser() {
          analyser = context.createAnalyser();
          analyser.fftSize = 4096;
          window = new Float32Array(analyser.fftSize);
          source.connect(analyser);
          mode = 'Analyser fallback';
        }
        function fallBackToAnalyser() {
          if (stopped || !worklet) return;
          worklet.port.close();
          source.disconnect(worklet);
          worklet.disconnect();
          worklet = null;
          lastFrame = Math.round(context.currentTime * context.sampleRate);
          attachAnalyser();
        }
        if (!worklet) attachAnalyser();
        const analyserPoll = () => {
          if (!analyser || context.state !== 'running') return;
          // Read each sample once, using the AudioContext render-frame count to
          // join consecutive analyser snapshots. Mark overruns as discontinuities.
          const end = Math.round(context.currentTime * context.sampleRate);
          const count = Math.min(end - lastFrame, window.length);
          if (count <= 0) return;
          analyser.getFloatTimeDomainData(window);
          lastFrame = end;
          feed(window.slice(-count), end - count);
        };
        let lastStateCheck = 0;
        timer = setInterval(() => {
          analyserPoll();
          if (performance.now() - lastStateCheck >= 250) {
            lastStateCheck = performance.now();
            stateChanged();
          }
        }, INPUT_BLOCK_MS);
        stateChanged();
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
