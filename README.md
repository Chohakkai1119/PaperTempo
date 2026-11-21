# PaperTempo

PaperTempo is a static sheet-music practice website. It listens for one instrument and one note at a time. Your microphone audio and imported files are processed in the browser.

## Run locally

From this directory, run `python3 -m http.server 8000 --directory dist` and open `http://localhost:8000`. Microphone access requires a secure context such as localhost or HTTPS and browser permission.

## Demo

1. Open the included **Morning Lines** score.
2. Choose **Bar 9**. The preview shows the first system on page two.
3. Select **Start listening**. Play E4, D4, and C4, then pause. Play G4 when ready to confirm the first note of page two and turn the page.
4. Stop listening to review the take. For timing feedback, choose **Scored tempo** before the take, follow the four-beat count-in, and play at least three expected notes. The timing tolerance is ±120 ms.

The **How it works** panel links to the matching two-page A4 PDF and MusicXML files.

## Imports

Use single-part, single-voice partwise MusicXML (`.musicxml`, `.xml`, or compressed `.mxl`). Chords, overlapping voices, grace notes, repeats, and unpitched percussion are outside the supported score types. The detector works best on clear, sustained pitches in a quiet room. If you select a bar that starts with rests, the score retains those rests in the timing reference.

For a clean printed PDF, export the score as MusicXML with an optical music recognition tool such as Audiveris. Check the converted notes against the PDF before practising. Select the PDF and MusicXML together to open both from the score viewer. Audiveris is optional and runs separately from the website.

Vendor files are bundled with the site. Verovio 6.4.1 is available from https://github.com/rism-digital/verovio/tree/version-6.4.1. The fonts and fflate include their licenses alongside the distributed files.
