# PaperTempo

PaperTempo is a sheet-music practice website. It listens for one instrument and grades melodies and supported chords against the score. Microphone audio and MusicXML files are processed in the browser. When a PDF is uploaded without MusicXML, the PDF is sent to the PaperTempo server for conversion.

## Run locally

Install [Node.js](https://nodejs.org/) and [uv](https://docs.astral.sh/uv/), then prepare the PDF-to-MusicXML converter:

```sh
git clone https://github.com/pllopis/pdf2music.git
cd pdf2music
uv sync
```

The first conversion downloads about 110 MB of OMR model weights and may take several minutes. Start PaperTempo in a second terminal from this repository:

```sh
node server.mjs
```

When the converter is installed in this repository's `pdf2music` subfolder, PaperTempo finds its virtual-environment executable automatically. Otherwise, put `pdf2music` on `PATH` or set `PDF2MUSIC_BIN` to its full executable path. Open `http://localhost:8000`. The server serves the website and `/api/convert`; microphone access requires a secure context such as localhost or HTTPS and browser permission. For a public deployment, put the Node server behind HTTPS and configure `HOST` and `PORT` for the host.

Uploaded PDFs are temporarily stored on the server while converting, then removed. The conversion engine runs locally on the server; it does not send scores to a third-party conversion service. The [pdf2music project](https://github.com/pllopis/pdf2music) and its OMR engine are AGPL-3.0 licensed; review that license before distributing a deployment that includes the converter.

## Demo

1. Open the included **Morning Lines** score.
2. Set **Start at** to **Bar 9** and **End after** to **Bar 10**. The score window shows the selected passage.
3. Set the **Reference tempo**, choose a **Playback instrument**, then select **Hear this passage**. Playback uses instrument recordings bundled with PaperTempo, and the score window follows the highlighted notes. Use **Pause playback** to resume from the same spot or **Stop playback** to try another instrument before playing again.
4. Choose your **Instrument being played**, leave **Score following** on **Keep going**, and select **Start listening**. After the optional four-beat count-in, start whenever you are ready. Play E4, then play C4 two beats later, leaving out D4. Watch the cursor continue through bar 10. Results appear automatically at the end of the passage.
5. Select the missed D4 to see it marked on the score. Choose **Practise bars 9–10**, then play the passage again with D4 included. **Take comparison** compares completed takes of the same passage at the same tempo and in the same following mode.
6. To drill pitches at your own pace, choose **Wait for the right note**. The cursor advances when you play the expected pitch or chord. Choose **Scored tempo** to rate timing against the reference tempo or **Free tempo** for pitch feedback.

Use **Count-in** to turn the clicks and countdown on or off. In timed practice, the first detected attack after you are ready is checked against the first written note and sets the timing reference, even if the pitch is wrong. In **Keep going**, the gap to the second note starts at that attack and the live status shows the next pitch. **Restart** reuses your take settings.

The overall grade weights pitch accuracy at 60% and rhythm at 40%. Rhythm uses beat timing and the spacing between neighbouring notes you matched. Beat timing measures each onset against the reference tempo starting at your first detected attack. At 120 BPM, correctly assigned notes within 200 ms of the beat earn full beat-timing credit. Wider deviations lose credit gradually. Closely spaced notes still use distinct assignment windows. Note spacing compares the played time between attacks with the score, including written rests. Missed notes and extra pitches reduce the grade.

The bundled [instrument recording credits](dist/assets/instruments/CREDITS.txt) list the source and license for each sample.

The **How it works** panel links to the matching two-page A4 PDF and MusicXML files.

## Check the microphone

1. Run `npm run dev` and open `http://localhost:3000`. Pick the actual instrument under **Instrument being played**.
2. Open **Microphone setup and diagnostics**, select the input physically beside the instrument or phone, and click **Test microphone**. Confirm the reported device label and live track. The browser can list more device labels after permission is granted.
3. Play a sustained **C4 (261.63 Hz)** tone from the phone at a moderate level. The meter should move, and the pitch readout should show C4 near 261.6 Hz. A moving meter and a pitch rejection indicate that sound reached the browser. If the meter stays flat, check the selected input, operating-system gain, and permission. Play a recorded instrument note next to compare its result.
4. Stop the microphone test before starting a practice take. The blue cursor shows where to play. Green means correct and on time, yellow means correct and early or late, and red means wrong or missed. Gray marks pitch-only results or insufficient evidence, with a text verdict on each assessed note. Select a note or a bar in Results to review and retry it.

Run `npm test` for the dependency-free regressions and `node scripts/evaluate-recognition.mjs` for the same-fixture baseline comparison. The [audio recognition evaluation](guides/audio-recognition-evaluation.md) includes the metrics, fixture licences, model comparison, limitations, and optional browser and hardware verification steps.

## Imports

Upload partwise MusicXML (`.musicxml`, `.xml`, or compressed `.mxl`). PaperTempo keeps the original notation visible and assesses new attacks in the first part across its staves and voices. Simultaneous notes form a chord, ties preserve a single attack, and simple barline repeats get separate results. Practice compares sounding pitch when MusicXML provides a transposition. Grace notes and unpitched percussion are skipped. Alternate endings and multi-part transcription are outside this implementation.

For a printed PDF, upload the PDF by itself and PaperTempo will convert it with its server-side optical music recognition engine, then open and download the resulting MusicXML. You can also select a PDF together with an existing MusicXML file to open the original PDF alongside that score without conversion. Check converted notes against the PDF before practising: optical recognition can misread notes and rhythms. Conversion currently accepts PDFs up to 20 MB and can take a few minutes on the first run while model weights are downloaded.

Vendor files are bundled with the site. Verovio 6.4.1 is available from https://github.com/rism-digital/verovio/tree/version-6.4.1. The fonts and fflate include their licenses alongside the distributed files.

## Hackathon materials

Find the student guide, event slides, and project planning notes in [guides/](guides/).
