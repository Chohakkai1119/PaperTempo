# PaperTempo audio recognition evaluation

The reference implementation is the JavaScript detector at `086f974`. Its fixed RMS gate was 0.008, with pitch search nominally from 55 Hz to 1800 Hz. The baseline required three consistent estimates and subtracted about 32 ms from analyser polling timestamps. On the same PCM input, it emitted no notes for either quiet phone-channel simulation, even though both files contained audible-band energy. The new pipeline reports signal and level independently of pitch and accepts both simulated C4 inputs. That confirms a recognition failure mode in the old DSP. The physical phone and computer that motivated the change were unavailable for testing, so the original device route, OS settings and microphone processing remain unverified.

## Data and scoring

`scripts/audio-fixtures.mjs` deterministically generates 21 clips at 48 kHz. These cover five instruments, low and high notes, flute sustain, violin vibrato, successive and repeated notes, quiet and reverberant cases, substantial overlap between harmonic series, correct and substituted major and minor chords, omitted notes, and staggered guitar attacks. Source recordings and per-file licence links are in [instrument credits](../dist/assets/instruments/CREDITS.txt). The cafe conversation is a CC0 excerpt with separate [attribution](../tests/fixtures/NOTICE.md). Source notes were trimmed and normalized upstream for playback, then mixed and sometimes pitch-shifted here for repeatable analysis. The tests use the resulting waveforms as PCM, independent of the score matcher. The two phone-channel cases use software bandwidth limiting, mild distortion, attenuation, noise and artificial reflections.

The note labels come from each fixture's construction schedule. The benchmark samples stable windows beginning 110 ms after nominal note onset and ending 28 ms before note release. Event scoring matches each detected MIDI pitch to one same-pitch reference within the stated tolerance. The ±50 ms event tolerance is used in music transcription evaluation. The ±160 ms measurement illustrates recovery from delay and is independent of the app's grading windows. Acoustic attacks in recorded notes may start later than the clip splice, so the timing measurements include any source attack lag. Wrong octaves are counted among false detections when an unmatched estimate is an octave multiple from an unmatched reference in the window. Reported absolute onset errors are for matched events. [mir_eval transcription documentation](https://mir-eval.readthedocs.io/stable/api/transcription.html)

## Measured pitch and onset performance

The following results use Node.js 24.22.1 on the local arm64 Mac and an identical PCM fixture collection for all comparisons. These fixtures were also used during tuning, so these measurements describe engineering regression cases.

| Stable windows | Precision | Recall | F1 | Wrong octave detections | Median absolute cents |
| --- | ---: | ---: | ---: | ---: | ---: |
| Monophonic baseline | .920 | .715 | .805 | 19 | — |
| Monophonic corrected CMNDF | .935 | .895 | .915 | 18 | 2.83 |
| Monophonic MPM/NSDF | .920 | .885 | .902 | 22 | 2.55 |
| Monophonic pYIN | .916 | .944 | .930 | 13 | 0.64 |
| Polyphonic baseline | .438 | .057 | .101 | 27 | — |
| Polyphonic FFT and periodicity | .809 | .723 | .763 | 30 | 5.37 |

| ±50 ms detected events | Precision | Recall | F1 | Median absolute error | 95th-percentile absolute error |
| --- | ---: | ---: | ---: | ---: | ---: |
| Monophonic baseline | .577 | .556 | .566 | 26.3 ms | 46.3 ms |
| Monophonic new pipeline | .581 | .667 | .621 | 8.0 ms | 34.0 ms |
| Monophonic Basic Pitch | .295 | .963 | .452 | 7.0 ms | 30.2 ms |
| Polyphonic baseline | .000 | .000 | .000 | — | — |
| Polyphonic new pipeline | .652 | .652 | .652 | 10.5 ms | 35.8 ms |
| Polyphonic Basic Pitch | .319 | .957 | .478 | 18.6 ms | 41.8 ms |

At ±160 ms, monophonic event F1 rose from .755 to .897 and polyphonic event F1 rose from .071 to .826. The cutoff recovered 26 of 27 monophonic reference notes and 19 of 23 polyphonic reference notes. For detected monophonic matches at ±160 ms, the median error fell from 27.3 ms to 19.7 ms, while the 95th percentile increased from 79.3 ms to 126.6 ms. The three quiet recorded repeat attacks produced zero baseline events and three correct new events, of which two were inside ±50 ms. The scripted C4/D4/E4 phrase produced three separate onsets for both versions. The new pipeline emitted no notes for the cafe conversation, digital silence and seeded broadband noise in the monophonic configuration.

The recorded-note major, minor, omitted-tone and substitution mixtures all produced the correct sets in settled FFT test windows. The emitted pitch sets were also exact for those four recorded-note mixtures. Estimated attacks spread by 8 ms in the major mixture and 11 ms in the substituted mixture. Both fit the 65 ms piano grouping window. The five-tone nylon and steel strums recovered four and three distinct correct pitches respectively. The low piano octave pair produced spurious extras. Dense strums and close onsets require separate validation from settled pitch estimates.

The regression target for melody fixtures is at least the baseline .805 stable F1 and .566 event F1 at ±50 ms, with the quiet C4 and three quiet repeats recovered by the PCM pipeline. The polyphonic regressions require exact sets for the settled major/minor, substituted and omitted-tone fixtures. The measured FFT polyphonic F1 of .763 and event F1 of .652 provide reference points for future tuning on these clips.

## Algorithm choice and runtime

- **Corrected YIN-style CMNDF** uses DC removal, an averaged decimation step, a cumulative mean-normalized difference function, and fractional-lag interpolation. The app chooses this path for melody-only passages. It had better measured monophonic F1 than the tested NSDF variant. [YIN paper](https://pubmed.ncbi.nlm.nih.gov/12002874/)
- **MPM-style NSDF** uses the same PCM with energy-normalized periodicity and relative peak selection. It yielded a slightly lower median cents deviation with lower recall. Its corroborating periodicity estimate helps support missing fundamentals in the spectral path. [McLeod and Wyvill publications](https://www.cs.otago.ac.nz/graphics/Geoff/tartini/papers.html)
- **pYIN** models several pitch candidates and their probabilities over time. The offline librosa 0.11.0 implementation yielded the best settled monophonic recall here. Warm runs took about 109–384 ms per 0.67–2.06 s clip. The Viterbi decoding comparison observes a whole clip and does not measure a causal streaming implementation. [pYIN paper](https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf), [librosa API](https://librosa.org/doc/0.11.0/generated/librosa.pyin.html)
- **Hann-window FFT and harmonic residual analysis** locates interpolated spectral peaks, ranks hypotheses using actual peak amplitude and harmonic evidence, then discounts partials explained by accepted lower fundamentals. A candidate below the preferred range can pass with stronger evidence. Score metadata can widen the preferred range and enable polyphony. The detector constructs candidates from captured samples.
- **Spotify Basic Pitch TypeScript 1.0.1** was evaluated in headless Brave with WebGL against the same clips using the published note extraction thresholds. Model assets were 916,929 bytes and the bundled comparison script was 1,139,658 bytes minified. The 21-case run loaded the model locally in 15.5 ms. First inference took 352 ms on that run and 8.36 s on an earlier cold run. Subsequent 0.67–2.06 s clips took 39–503 ms apiece. Reported retained TensorFlow tensor bytes grew to 47.8 MB across repeated calls, which does not measure total browser memory. The public evaluator uses roughly two-second model windows and generated more extras than the spectral pipeline at ±160 ms. Its polyphonic ±50 ms event recall was substantially higher. It remains an external comparator. The application includes no model or package dependency. [Basic Pitch TypeScript source and Apache-2.0 licence](https://github.com/spotify/basic-pitch-ts), [research paper](https://arxiv.org/abs/2203.09893)

Node measured a median block processing cost of 0.100 ms and p95 of 0.440 ms for the new PCM engine, compared with 0.352 ms and 0.372 ms for the old tracker and estimator loop. The old and new block intervals were 13 and 12 ms. The fixture replay had zero PCM sequence discontinuities. The difference from estimated event sample to emission in the new engine was 84 ms median and 172 ms p95. These figures measure local DSP cost and recognition delay. Overall browser CPU percentage, total memory usage, and dropped frames on physical devices remain unmeasured.

## Run the comparisons

The core evaluation has no dependencies beyond Node.js and access to the baseline commit.

```sh
node --test tests/pitch-analysis.test.mjs
node scripts/evaluate-recognition.mjs --events
node scripts/evaluate-recognition.mjs --export=/tmp/papertempo-audio-fixtures
```

The two external comparisons use temporary installations. The Basic Pitch script uses Chromium request interception for the bundled fixtures and model files. Substitute the path to the local Brave or Chromium executable.

```sh
python3 -m venv /tmp/papertempo-pyin
/tmp/papertempo-pyin/bin/pip install librosa==0.11.0
/tmp/papertempo-pyin/bin/python scripts/evaluate-pyin.py /tmp/papertempo-audio-fixtures /tmp/papertempo-pyin.json

npm install --prefix /tmp/papertempo-model @spotify/basic-pitch@1.0.1 @tensorflow/tfjs@3.21.0 esbuild@0.25.12 playwright-core@1.59.1
node scripts/evaluate-basic-pitch.mjs /tmp/papertempo-model /tmp/papertempo-audio-fixtures "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" /tmp/papertempo-basic.json
node scripts/evaluate-recognition.mjs --external=/tmp/papertempo-basic.json --pyin=/tmp/papertempo-pyin.json --events
```

## Browser verification

Chromium 159.0.8154.6 exercised the actual browser capture API using a 48 kHz WAV as the device input. With a C4 sine at 0.003 peak amplitude, the feature branch showed a moving meter and C4. The same stream produced no pitch on upstream main during 2.2 seconds. Its RMS is below the upstream 0.008 gate.

A second Chromium check used a local, generated MediaStream and forced the analyser fallback. It exercised correct and substituted triads, per-head scored verdicts, note review, take comparison, and a disconnected track. The generated triad reached its displayed verdict in approximately 0.28 s in one run, measured from scheduled onset to rendered notehead attributes. Firefox 159.0 and WebKit 27.2 passed the generated-stream meter, pitch rejection, quiet C4 and cleanup checks. A separate Chromium check exercised real Verovio SVG engraving and accessible markers.

Run the optional Playwright checks with the dev server running:

```sh
npm install --prefix /tmp/papertempo-browser playwright
PLAYWRIGHT_BROWSERS_PATH=/tmp/papertempo-browsers /tmp/papertempo-browser/node_modules/.bin/playwright install chromium firefox webkit
export PAPERTEMPO_PLAYWRIGHT=/tmp/papertempo-browser/node_modules/playwright
export PLAYWRIGHT_BROWSERS_PATH=/tmp/papertempo-browsers
PAPERTEMPO_CROSS_BROWSER=1 node scripts/check-microphone-browser.mjs
node scripts/check-score-browser.mjs
```

To compare the same WAV against upstream in Chromium, serve commit `086f974` on a separate port and set `PAPERTEMPO_BASELINE_URL` to its localhost URL when running the microphone check.

## Reproduce the physical microphone and phone case

1. Start the local app with `npm run dev` and open the localhost URL in the terminal output. Choose **Other / General** for the input profile.
2. Open the microphone diagnostics. Select the computer microphone nearest the phone. Click **Test microphone** and grant microphone permission. Note the actual track label, sample rate and processing settings shown in the panel, then check that a tap on the selected mic raises the meter.
3. Play a sustained 261.63 Hz C4 sine tone on the phone at moderate volume next to the mic. Check that the meter moves and that the pitch readout shows C4 near 261.63 Hz. If the meter moves and the detector rejects the note, record the level, noise estimate, clipping status and rejection message.
4. Try a recorded single piano note and a recorded guitar note, then repeat a note with a short release. For chords, select the relevant input profile and play a simple triad, a substituted tone and an omitted tone against a matching MusicXML chord.
5. Repeat with the headset or Bluetooth mic deliberately selected, then unplug it mid-test. Check the track state, diagnostics and take status before trying the original microphone again. If the OS or browser applies speech processing, capture the actual track settings with each result.

The quiet-signal and browser results apply to controlled PCM replays. Physical phone playback, Bluetooth routing, real room impulse responses, dense ensemble music, and live playing through each browser remain unverified.


## Implementation files

| Files | Change |
| --- | --- |
| `dist/audio.mjs` | Keeps the count-in and existing pure helpers and exposes the new microphone entry point. |
| `dist/microphone.mjs` | Requests and inspects the selected capture track, maps frame indices to the practice clock, and manages fallbacks and cleanup. |
| `dist/audio-capture-worklet.mjs` | Copies bounded PCM blocks and tags them with render-frame indices. |
| `dist/audio-input-worker.mjs` | Runs pitch and onset analysis off the UI and audio threads. |
| `dist/audio-input.mjs` | Measures level, estimates background noise, tracks attacks and reattacks, and refines chord-tone onset times. |
| `dist/input-profiles.mjs` | Defines the six input profiles, A4 tuning, pitch range guidance, and instrument-specific grouping. |
| `dist/pitch-analysis.mjs` | Provides corrected CMNDF, NSDF and spectral harmonic pitch estimates. |
| `dist/microphone-diagnostics.mjs` | Displays permission, device, actual settings, input level and pitch evidence. |
| `dist/score.mjs` | Preserves sounding tones, notehead mappings, ties and repeated occurrences. |
| `dist/playback.mjs` | Plays the sounding tones of simultaneous groups and advances through overlapping voices. |
| `dist/practice.mjs` | Aligns timestamped attacks, groups chord tones, and scores and reviews each written head. |
| `dist/app.mjs`, `dist/index.html`, `dist/styles.css` | Connect the input controls, live verdicts, note and bar review, retry, take comparison, and coach to the existing interface. |
| `scripts/audio-fixtures.mjs`, `tests/fixtures/` | Build reproducible fixture audio and supply the attributed café excerpt. |
| `scripts/evaluate-recognition.mjs`, `scripts/evaluate-basic-pitch.mjs`, `scripts/evaluate-pyin.py` | Compare the baseline, streaming engine and external algorithms on identical clips. |
| `scripts/check-microphone-browser.mjs`, `scripts/check-score-browser.mjs` | Exercise capture and practice in browser contexts and verify engraved noteheads. |
| `tests/pitch-analysis.test.mjs`, `tests/practice.test.mjs`, `tests/playback.test.mjs` | Cover pitch evidence, recorded mixtures, timing and chord grading, capture failures and polyphonic playback. |
| `README.md`, `guides/audio-recognition-evaluation.md` | Describe microphone setup, score coverage, measured results and reproduction commands. |
