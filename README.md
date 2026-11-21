# PaperTempo

PaperTempo is a static sheet-music practice website. It listens for one instrument and one note at a time. Your microphone audio and imported files are processed in the browser.

## Run locally

To run the site and the API together (Node 20+, no install needed):

```sh
npm run dev        # http://localhost:3000
```

`scripts/dev-server.mjs` serves `dist/` and routes `/api/*` to the functions in `api/`, the same way Vercel does. Use `localhost`: microphone access requires a secure context such as localhost or HTTPS, plus browser permission. Without a `.env` file, the practice coach uses its built-in fallback drills. To try Snowflake Cortex locally, copy `.env.example` to `.env` and fill in the values (`.env` is git-ignored). `npx vercel dev` also works if you have the Vercel CLI linked to the project.

For the static site only (no coach), run `python3 -m http.server 8000 --directory dist` and open `http://localhost:8000`.

Run the tests with `npm test`.

## Demo

1. Open the included **Morning Lines** score.
2. Set **Start at** to **Bar 9** and **End after** to **Bar 10**. The preview shows the first system on page two.
3. Select **Start listening**. Play E4, D4, and C4, then pause. Play G4 when ready to confirm the first note of page two and turn the page.
4. Finish bar 10 to review the take, then select **Practise again** to replay those two bars. For timing feedback, choose **Scored tempo** before the take, follow the four-beat count-in, and play at least three expected notes. The timing tolerance is ±120 ms.

The **How it works** panel links to the matching two-page A4 PDF and MusicXML files.

## Imports

Use single-part, single-voice partwise MusicXML (`.musicxml`, `.xml`, or compressed `.mxl`). Chords, overlapping voices, grace notes, repeats, and unpitched percussion are outside the supported score types. The detector works best on clear, sustained pitches in a quiet room. If you select a bar that starts with rests, the score retains those rests in the timing reference.

For a clean printed PDF, export the score as MusicXML with an optical music recognition tool such as Audiveris. Check the converted notes against the PDF before practising. Select the PDF and MusicXML together to open both from the score viewer. Audiveris is optional and runs separately from the website.

Vendor files are bundled with the site. Verovio 6.4.1 is available from https://github.com/rism-digital/verovio/tree/version-6.4.1. The fonts and fflate include their licenses alongside the distributed files.

## Practice coach (Snowflake Cortex)

After a **Scored tempo** take, the results panel offers **What should I practise next?**. The browser sends only numbers: for each bar played, its label, the number of missed notes, and the timing offsets in milliseconds. Microphone audio never leaves the browser. The response names a target bar and gives one short drill. **Practise this bar** sets the start and end bar to that bar.

### Architecture

```
Browser (dist/, static)  ──POST /api/drill {piece, bars:[{bar, missedNotes, timingOffsetsMs}]}──▶  Vercel function (api/drill.js)
                                                                                                  │ validate (lib/validate.js)
                                                                                                  │ pick target bar (lib/target-bar.js)
                                                                                                  ▼
                                                                         Snowflake Cortex REST API (lib/cortex.js)
                                                                         /api/v2/cortex/v1/chat/completions
```

- **Hosting:** Vercel, linked to `main`; every push deploys. Dashboard settings are Framework = Other, Build Command = empty, and Output Directory = `dist`. `vercel.json` only raises the functions' `maxDuration` to 20 s, which leaves room for the 10 s Cortex timeout.
- **Static site:** `dist/` holds the browser app. It contains no secrets.
- **Functions:** `api/health.js` handles `GET /api/health` and returns `{"ok":true}`. `api/drill.js` handles `POST /api/drill`. Both are thin wrappers over `lib/`, so future routes can reuse the validation, the picker and the Cortex client.
- **Target bar:** chosen by our code, never by the model. It's the bar with the worst mean absolute timing offset, with ties broken by most missed notes, then by the earliest bar.
- **Cortex:** one chat-completions call with a "concise music practice coach" system prompt, a low `max_tokens`, and a 10 s timeout. The model writes only the drill text, at most two sentences.
- **Fallback:** if the env vars are missing, or Cortex errors or times out, the API returns a template drill such as "Start at bar N-1 and play through bar N at half tempo, 3 times, keeping the beat steady". The response always has the shape `{targetBar, drill, source: "cortex" | "fallback"}`. Failures are logged server-side with the Snowflake status and message only, never the token, so you can debug them from the Vercel logs.
- **Validation:** real takes are normalised rather than rejected. Missing `missedNotes` or `timingOffsetsMs` count as empty, and duplicate bar labels are merged. Offsets beyond ±2000 ms count as a *late start* (the player came in long after the count-in) rather than a timing error, so they are excluded from the mean. Only malformed requests get a 400: not JSON, no bars, or wrong types. Rejections are logged with the reason and the (numbers-only) body.
- **Limits:** the body is capped at 64 KB as an abuse guard. `/api/drill` is rate-limited to 5 requests per minute per IP. The limiter is in-memory, so it is **best-effort on serverless**: each function instance keeps its own counters, and they reset when an instance is recycled.

### Environment variables

Set these in Vercel (Production). For local Cortex testing, put them in `.env`; never commit them.

| Variable | Example | Meaning |
|---|---|---|
| `SNOWFLAKE_ACCOUNT` | `orgname-accountname` | Account identifier used in `https://<account>.snowflakecomputing.com` (lowercase; underscores become hyphens) |
| `SNOWFLAKE_PAT` | — | Programmatic access token for a Snowflake service user |
| `SNOWFLAKE_MODEL` | `claude-haiku-4-5` | Cortex model name |

### Future: shared practice history

This is not built yet. The idea is to store takes in Snowflake so players can compare progress across sessions and the coach can use history:

- `takes`: one row per take (id, piece, start/end bar, mode, bpm, pitch accuracy, on-time share, created_at).
- `bar_stats`: one row per bar per take (take_id, bar, missed_notes, mean_abs_offset_ms, offsets).

The new routes would reuse `lib/validate.js` and a Snowflake SQL API client next to `lib/cortex.js`.

## Hackathon materials

Find the student guide, event slides, and project planning notes in [guides/](guides/).
