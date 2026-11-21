import { listMicrophones, microphonePermission } from './microphone.mjs';
import { midiName } from './score.mjs';

const messages = {
  quiet: 'Input is too quiet relative to the background.',
  'building-window': 'Receiving sound. Collecting samples.',
  'waiting-for-onset': 'Pitch detected. Waiting for a stable onset.',
  accepted: 'Listening. Pitch accepted.',
};

const db = (value) => value > 0 ? `${Math.round(20 * Math.log10(value))} dBFS` : '−∞ dBFS';

export function captureProblem(status) {
  if (!status) return null;
  if (!status.streamActive || status.trackState === 'ended') return 'Microphone disconnected. Select an input and try again.';
  if (status.muted || !status.enabled) return 'Microphone is muted.';
  if (status.contextState !== 'running') return 'The browser has paused microphone analysis.';
  if (status.captureStalled) return 'No audio samples are reaching the app.';
  return null;
}

export function createMicrophoneDiagnostics({ byId, text }) {
  const select = byId('microphone-device');
  const meter = byId('input-meter');
  let lastDraw = -Infinity;
  let lastSignal = -Infinity;
  let lastReading = null;
  let refreshId = 0;
  const refreshDevices = async () => {
    const request = ++refreshId;
    const permission = await microphonePermission();
    if (request !== refreshId) return;
    if (permission !== 'unknown' || !lastReading) text('capture-permission', permission);
    try {
      const devices = await listMicrophones();
      if (request !== refreshId) return;
      const selected = select.value;
      const options = devices.filter(({ deviceId }) => deviceId && deviceId !== 'default')
        .map(({ label, deviceId }, index) => new Option(label || `Microphone ${index + 1}`, deviceId));
      // Retain a disconnected selection so reopening produces a visible error.
      if (selected && !options.some(({ value }) => value === selected)) {
        options.push(new Option('Previously selected microphone (unavailable)', selected));
      }
      select.replaceChildren(new Option('System default', ''), ...options);
      select.value = selected;
    } catch {
      // Some browsers cannot enumerate devices until a stream is open.
    }
  };

  function status(status) {
    const { settings, sampleRate, trackState, streamActive, contextState, muted, mode, enabled } = status;
    text('capture-device', status.deviceLabel || 'Browser did not provide a label');
    text('capture-permission', 'granted');
    text('capture-track', `${streamActive ? 'active stream' : 'inactive stream'} · ${trackState}${muted || !enabled ? ', muted' : ''} · audio context ${contextState}`);
    const state = (key) => settings[key] === undefined ? 'unknown' : settings[key] ? 'on' : 'off';
    const bits = settings.sampleSize ? ` · ${settings.sampleSize}-bit` : '';
    const latency = settings.latency === undefined ? '' : ` · ${Math.round(settings.latency * 1000)} ms reported latency`;
    text('capture-settings', `${settings.sampleRate ?? '?'} Hz · ${settings.channelCount ?? '?'} channels${bits}${latency} · echo cancellation ${state('echoCancellation')} · noise suppression ${state('noiseSuppression')} · auto gain ${state('autoGainControl')}`);
    text('capture-engine', `${sampleRate} Hz · ${mode}`);
    const problem = captureProblem(status);
    if (problem) {
      text('capture-message', problem);
      meter.value = 0;
    } else if (!lastReading) text('capture-message', 'Microphone open. Play a sustained note.');
  }

  function reading(data, now) {
    lastReading = data;
    if (data.signal) lastSignal = now;
    if (now - lastDraw < 100) return;
    lastDraw = now;
    const problem = captureProblem(data);
    // Peak drives the meter on a logarithmic scale so quiet sound is visible.
    meter.value = problem ? 0 : Math.max(0, (60 + 20 * Math.log10(Math.max(data.peak, 1e-8))) / 60);
    text('capture-levels', `${db(data.rms)} / ${db(data.peak)} / ${db(data.noiseFloor)}`);
    text('capture-pitches', data.pitches.length ? data.pitches.map(({ midi, frequencyHz, cents, confidence }) =>
      `${midiName(midi)} · ${frequencyHz.toFixed(1)} Hz · ${Math.round(cents)}¢ · ${Math.round(confidence * 100)}%`).join(' / ') : '—');
    let message = messages[data.reason];
    if (!message) message = data.pitches.length > 1 ? 'Multiple pitches detected.' : 'Receiving sound. No stable pitch detected.';
    if (data.pitches.length > 1 && data.accepted) message = 'Multiple pitches detected and accepted.';
    if (now - lastSignal > 500) message = 'No measurable audio. Check the selected input and microphone gain.';
    text('capture-message', problem ?? (data.clipping ? `Input clipping. ${message}` : message));
  }

  function stop(message = 'Microphone off', permission) {
    lastReading = null;
    lastDraw = -Infinity;
    lastSignal = -Infinity;
    meter.value = 0;
    if (permission) text('capture-permission', permission);
    text('capture-track', 'closed');
    text('capture-message', message);
  }

  globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
  void refreshDevices();
  return { reading, status, stop, refreshDevices, select };
}
