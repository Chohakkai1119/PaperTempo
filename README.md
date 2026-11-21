# PaperTempo

PaperTempo is a sheet-music practice website. It listens for one instrument and one note at a time. Microphone audio and MusicXML files are processed in the browser. When a PDF is uploaded without MusicXML, the PDF is sent to the PaperTempo server for conversion.

## Run locally

Install [Node.js](https://nodejs.org/) and [uv](https://docs.astral.sh/uv/), then prepare the PDF-to-MusicXML converter:

```sh
git clone https://github.com/pllopis/pdf2music.git
cd pdf2music
uv add "opencv-python>=4.13.0.92,<5" "opencv-python-headless>=4.13.0.92,<5"
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
2. Choose **Bar 9**. The preview shows the first system on page two.
3. Select **Start listening**. Play E4, D4, and C4, then pause. Play G4 when ready to confirm the first note of page two and turn the page.
4. Stop listening to review the take. For timing feedback, choose **Scored tempo** before the take, follow the four-beat count-in, and play at least three expected notes. The timing tolerance is ±120 ms.

The **How it works** panel links to the matching two-page A4 PDF and MusicXML files.

## Imports

Use single-part, single-voice partwise MusicXML (`.musicxml`, `.xml`, or compressed `.mxl`). Chords, overlapping voices, grace notes, repeats, and unpitched percussion are outside the supported score types. The detector works best on clear, sustained pitches in a quiet room. If you select a bar that starts with rests, the score retains those rests in the timing reference.

For a printed PDF, upload the PDF by itself and PaperTempo will convert it with its server-side optical music recognition engine, then open and download the resulting MusicXML. You can also select a PDF together with an existing MusicXML file to open the original PDF alongside that score without conversion. Check converted notes against the PDF before practising: optical recognition can misread notes and rhythms. Conversion currently accepts PDFs up to 20 MB and can take a few minutes on the first run while model weights are downloaded.

Vendor files are bundled with the site. Verovio 6.4.1 is available from https://github.com/rism-digital/verovio/tree/version-6.4.1. The fonts and fflate include their licenses alongside the distributed files.
