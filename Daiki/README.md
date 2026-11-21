# Daiki's version of PaperTempo

This is my working copy of PaperTempo. It's based on the team version in `../dist/` (Diart's upload on `main`), which is left unchanged.

## What's different from `../dist/`

- `dist/app.mjs`: uploading a PDF without MusicXML now explains that it needs converting first (for example with Audiveris).
- `tests/`: 16 automated Node tests. They drive the site's own note detector (`dist/audio.mjs`) with synthesized audio, and the score follower and feedback (`dist/practice.mjs`) with timestamped note-on events.

## Run it

From this `Daiki/` folder:

```sh
python -m http.server 8000 --directory dist   # then open http://localhost:8000
npm test                                      # Node 18+, no dependencies
```

The microphone only works on `localhost` or over HTTPS.
