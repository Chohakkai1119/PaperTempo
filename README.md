# PaperTempo

PaperTempo is a sheet-music practice website. It listens for one instrument and one note at a time. Microphone audio and MusicXML files are processed in the browser. When a PDF is uploaded without MusicXML, the PDF is sent to the PaperTempo server for conversion.

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
2. Set **Start at** to **Bar 9** and **End after** to **Bar 10**. The preview shows the first system on page two.
3. Set the **Reference tempo** and choose **Hear this passage**. Playback follows the single-note practice line and turns the page. Use **Pause playback** to resume from the same spot or **Stop playback** to return to practice.
4. Select **Scored tempo** and **Start listening**. After the four-beat count-in, play E4 and C4 at their written beats, leaving out D4. Play G4 on the first beat of bar 10 to turn the page, then finish the bar.
5. Select the missed D4 to see it marked on page one. Choose **Practise bars 9–10**, then play the passage again with D4 included. **Take comparison** shows the results from both completed takes at the same tempo.

Scored tempo combines 60% pitch accuracy with 40% rhythm. Rhythm credit decreases with onset error and missed notes earn no credit. The timing window scales with tempo from 70 to 140 ms, and rhythm and overall accuracy require at least three matched notes.

The **How it works** panel links to the matching two-page A4 PDF and MusicXML files.

## Imports

Upload partwise MusicXML (`.musicxml`, `.xml`, or compressed `.mxl`). PaperTempo keeps the original notation visible and builds a single-note practice sequence from the first part: simultaneous chords resolve to their highest pitched note, overlapping lines resolve to the highest note at each onset, grace notes and unpitched percussion are skipped, and barline repeats are played once more. This conversion is intended for one-pitch-at-a-time microphone practice, so it does not preserve chord voicings or percussion in the practice sequence. The detector works best on clear, sustained pitches in a quiet room.

For a printed PDF, upload the PDF by itself and PaperTempo will convert it with its server-side optical music recognition engine, then open and download the resulting MusicXML. You can also select a PDF together with an existing MusicXML file to open the original PDF alongside that score without conversion. Check converted notes against the PDF before practising: optical recognition can misread notes and rhythms. Conversion currently accepts PDFs up to 20 MB and can take a few minutes on the first run while model weights are downloaded.

Vendor files are bundled with the site. Verovio 6.4.1 is available from https://github.com/rism-digital/verovio/tree/version-6.4.1. The fonts and fflate include their licenses alongside the distributed files.

## Hackathon materials

Find the student guide, event slides, and project planning notes in [guides/](guides/).
