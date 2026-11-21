# PaperTempo

**Practise from sheet music that listens as you play, follows your notes, and turns the page for you.**

PaperTempo is a sheet-music practice website for one instrument playing one note at a time. Open a score, press **Start listening**, and play: the score follows you, scrolls as you go, and shows where your pitch or timing drifted. Microphone audio stays in your browser.

**Live site:** <https://papertempo.vercel.app>

Built at KCL First Year Hack by Daiki, Diart and Yu.

## Features

- **Sheet music in the browser.** Scores are engraved with [Verovio](https://www.verovio.org) and shown four rows at a time. The view scrolls up a row once you reach the third row, so the next lines are always visible.
- **Live score following.** One note at a time is detected from the microphone and matched to the score.
  - **Keep going** moves the cursor at the reference tempo and grades the passage at the end.
  - **Wait for the right note** advances only when you play the expected pitch. Use **Scored tempo** to rate timing or **Free tempo** for pitch only.
- **Count-in.** A large 4 · 3 · 2 · 1 countdown appears over the score in time with the clicks. It can be switched off.
- **Restart (R)** discards the take and goes straight back into the count-in with the same bars, mode and tempo.
- **Full screen (F)** puts the score panel on its own, including the countdown and Restart.
- **Results.** You get pitch accuracy, rhythm and an overall grade, with missed notes marked on the score. **Practise bars …** jumps to a weak spot, and **Take comparison** compares repeated takes of the same passage.
- **Hear this passage.** Playback uses recorded piano, nylon-string guitar, steel-string guitar, flute or violin.
- **"What should I practise next?"** After a timed take, a coach suggests one drill for your weakest bar, using Snowflake Cortex. See [Practice coach](#practice-coach-snowflake-cortex).
- **Imports.** You can open MusicXML (`.musicxml`, `.xml`, `.mxl`), or convert a printed PDF with server-side optical music recognition.

## Demo

1. Open the included **Morning Lines** score.
2. Set **Start at** to **Bar 9** and **End after** to **Bar 10**. The score window shows the selected passage.
3. Set the **Reference tempo**, choose a **Playback instrument**, then select **Hear this passage**. Playback uses instrument recordings bundled with PaperTempo, and the score window follows the highlighted notes. Use **Pause playback** to resume from the same spot, or **Stop playback** to try another instrument before playing again.
4. Leave **Score following** on **Keep going** and select **Start listening**. After the four-beat count-in, play E4 and C4 at their written beats, leaving out D4. Watch the cursor continue through bar 10. Results appear automatically at the end of the passage.
5. Select the missed D4 to see it marked on the score. Choose **Practise bars 9–10**, then play the passage again with D4 included. **Take comparison** compares completed takes of the same passage at the same tempo and in the same following mode.
6. Select **What should I practise next?** for a one-line drill on your weakest bar. **Practise this bar** jumps to it.
7. To drill pitches at your own pace, choose **Wait for the right note**. The cursor advances when you play the expected pitch. Choose **Scored tempo** to rate timing against the reference tempo, or **Free tempo** for pitch feedback.

Use **Count-in** to turn the clicks and countdown on or off. With it off, **Keep going** starts immediately, and timed **Wait for the right note** anchors to the first correct note. **Restart** reuses your take settings.

### Keyboard shortcuts

| Key | Action |
|---|---|
| **R** | Restart the take (or start one) with the same settings |
| **F** | Enter or leave full screen (hidden where the browser doesn't support it) |

Shortcuts are ignored while you're typing in a field.

### How grading works

The overall grade weights pitch accuracy at 60% and rhythm at 40%. Rhythm uses beat timing and the spacing between neighbouring notes you matched. Beat timing measures each onset against the count-in. Note spacing compares the played time between attacks with the score, including written rests. Missed notes and extra pitches reduce the grade.

## Run locally

You need [Node.js](https://nodejs.org/) 20 or newer. The microphone only works on `localhost` or over HTTPS.

| Command | Serves | Use it for |
|---|---|---|
| `npm run dev` | Website and `/api/*` on <http://localhost:3000> | Everyday development, including the practice coach |
| `node server.mjs` | Website and `/api/convert` on <http://localhost:8000> | PDF-to-MusicXML conversion (needs pdf2music, below) |
| `npm start` | Website only on <http://localhost:8000> (Python) | A quick static preview |
| `npm test` | — | Run the test suite |

There's no build step and nothing to install for `npm run dev` or `npm test`.

### PDF conversion (optional)

Install [uv](https://docs.astral.sh/uv/), then prepare the PDF-to-MusicXML converter:

```sh
git clone https://github.com/pllopis/pdf2music.git
cd pdf2music
uv sync
```

The first conversion downloads about 110 MB of OMR model weights and may take several minutes. Then start PaperTempo from this repository:

```sh
node server.mjs
```

When the converter is installed in this repository's `pdf2music` subfolder, PaperTempo finds its virtual-environment executable automatically. Otherwise, put `pdf2music` on `PATH` or set `PDF2MUSIC_BIN` to its full executable path. Open <http://localhost:8000>. For a public deployment, put the Node server behind HTTPS and configure `HOST` and `PORT` for the host.

Uploaded PDFs are stored on the server only while converting, then removed. The conversion engine runs locally on the server and doesn't send scores to a third-party service. The [pdf2music project](https://github.com/pllopis/pdf2music) and its OMR engine are AGPL-3.0 licensed; review that license before distributing a deployment that includes the converter.

## Practice coach (Snowflake Cortex)

After a timed take, **What should I practise next?** sends only numbers to the backend: for each bar played, its label, the number of missed notes, and the timing offsets in milliseconds. Microphone audio never leaves the browser.

- **Target bar.** Our own code picks the target bar: the one with the worst average timing offset, with ties broken by most missed notes. The language model never chooses the bar.
- **The drill.** Snowflake Cortex (chat completions) writes one drill of at most two sentences for that bar.
- **Fallback.** If the Snowflake settings are missing, or Cortex fails or takes longer than 10 seconds, PaperTempo returns a built-in drill instead. The page labels the result **Coach (Snowflake Cortex)** or **Quick tip (coach unavailable)**.
- **Input.** Real takes are accepted as they are. Offsets beyond ±2 s count as a late start rather than a timing error. Only malformed requests get a 400.
- **Rate limit.** Each IP gets 5 requests per minute. The limiter is in memory, so on serverless it's best-effort: each function instance keeps its own count.

### Environment variables

Set these in Vercel (Production), or in a local `.env` file copied from `.env.example`. Never commit `.env`.

| Variable | Example | Meaning |
|---|---|---|
| `SNOWFLAKE_ACCOUNT` | `orgname-accountname` | Account identifier used in `https://<account>.snowflakecomputing.com` |
| `SNOWFLAKE_PAT` | — | Programmatic access token for a Snowflake service user |
| `SNOWFLAKE_MODEL` | `claude-haiku-4-5` | Cortex model name |

Without them, the coach uses the built-in drills.

## Deployment

The live site runs on Vercel and deploys automatically on every push to `main`.

- **Vercel settings:** Framework = Other, Build Command = empty, Output Directory = `dist`.
- **Functions:** files in `api/` become serverless functions (`/api/health`, `/api/drill`). `vercel.json` only raises their time limit to 20 seconds.
- **PDF conversion:** this needs `server.mjs` and pdf2music, which Vercel doesn't run, so on the live site you upload MusicXML instead.

## Project structure

```
dist/            The website (static files, served as-is)
  app.mjs          UI, practice flow, count-in, Restart, full screen
  audio.mjs        Microphone, pitch detection, note onsets, count-in clicks
  practice.mjs     Matching played notes to the score, grading
  score.mjs        Loading and engraving scores (Verovio)
  rows.mjs         The scrolling 4-row score window
  playback.mjs     "Hear this passage" playback
  instruments.mjs  Bundled instrument recordings
  assets/          Sample scores, fonts, instrument samples (with credits)
  vendor/          Verovio and fflate (with licenses)
api/             Vercel functions: /api/health, /api/drill
lib/             Shared backend code: validation, target bar, Cortex client, rate limit
scripts/         dev-server.mjs (local site + API) and sample-score generators
server.mjs       Local server with PDF conversion (/api/convert)
tests/           Node tests (npm test)
guides/          Hackathon guide, slides, research and planning notes
```

## Tests

Run `npm test` (Node 20+, no dependencies). The tests cover:
- the pitch and onset detector, fed with synthesized audio
- score following, grading and take comparison
- playback
- the scrolling row window
- the count-in, Restart and title removal
- the coach API: validation, target-bar picker, fallback, rate limit, and mocked Cortex responses

## Imports

Upload partwise MusicXML (`.musicxml`, `.xml`, or compressed `.mxl`). PaperTempo keeps the original notation visible and builds a single-note practice sequence from the first part:
- Simultaneous chords resolve to their highest pitched note.
- Overlapping lines resolve to the highest note at each onset.
- Grace notes and unpitched percussion are skipped.
- Barline repeats are played once more.

This conversion is intended for one-pitch-at-a-time microphone practice, so it doesn't preserve chord voicings or percussion in the practice sequence. The detector works best on clear, sustained pitches in a quiet room.

For a printed PDF, upload the PDF by itself and PaperTempo will convert it with its server-side optical music recognition engine (see [PDF conversion](#pdf-conversion-optional)), then open and download the resulting MusicXML. You can also select a PDF together with an existing MusicXML file to open the original PDF alongside that score without conversion. Check converted notes against the PDF before practising: optical recognition can misread notes and rhythms. Conversion accepts PDFs up to 20 MB.

## Credits and licenses

- **Notation:** [Verovio](https://github.com/rism-digital/verovio/tree/version-6.4.1) 6.4.1 (LGPL-3.0). Its license is bundled in `dist/vendor/`.
- **MXL unzipping:** [fflate](https://github.com/101arrowz/fflate) (MIT), license in `dist/vendor/`.
- **Fonts:** DM Sans and Instrument Serif, licenses in `dist/assets/`.
- **Instrument recordings:** Meta Open Sound and VS Chamber Orchestra Community Edition, both CC0. See [CREDITS.txt](dist/assets/instruments/CREDITS.txt).
- **PDF conversion:** [pdf2music](https://github.com/pllopis/pdf2music) (AGPL-3.0). It's installed separately and isn't bundled.

## Hackathon materials

Find the student guide, event slides, and project planning notes in [guides/](guides/).
