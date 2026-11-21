# PaperTempo prompt sheet

**Upload a score, play it aloud, and let PaperTempo follow along, turn the page, and show where your pitch or timing drifted.**

Paste the prompts into JetBrains Air **one at a time** in your team’s project. Run the checkpoint after each prompt before moving on.

## Seven-hour build

Start with a **short, printed, two-page melody** and one instrument playing a single note at a time. Use a quiet room. Prepare the same score as a PDF and a verified MusicXML file so you can test the microphone and page turns while someone checks PDF conversion. Use a piece your team wrote or can freely share. Save chords, handwritten scores, repeats, and accompaniment for a later version.

| Time | Target |
|---|---|
| 0:00–1:00 | Display the sample score. In parallel, convert the matching PDF once with Audiveris. |
| 1:00–2:00 | Detect stable notes and note attacks from the demo instrument. |
| 2:00–3:15 | Follow the player and recover from a missed note. |
| 3:15–4:00 | Preload and turn the next page. |
| 4:00–4:45 | Show pitch and timing feedback. |
| 4:45–6:00 | Connect the PDF upload. |
| 6:00–7:00 | Test the complete flow, rehearse, and submit. |

## 1. Build the score viewer

```text
Build the first slice of PaperTempo, a browser app for musicians practising from sheet music. Inspect the existing repo first. Reuse its stack if one exists. If it is empty, use Vite and TypeScript. Add a sample button and an upload control for MusicXML. Use Verovio to display a short, two-page, single-voice score. Build an ordered list of expected notes with pitch, onset in beats, duration, measure, rendered note ID, and page. Keep rests in the timing data. Let me pick a starting bar and use Previous and Next to move the highlight. Keep the music large and the controls simple. Run the app or build and tell me how to verify this slice.
```

**Checkpoint** · Open the sample, select a bar, and confirm the highlight moves through the correct notes on both pages.

## 2. Listen to the instrument

```text
Add Start Listening and Stop controls. Use the browser microphone and a monophonic pitch detector to recognise played notes. Process audio locally. Check volume and pitch confidence before accepting a detection. Emit a timestamped note-on event when a stable pitch begins. A held note should produce one event, and two distinct attacks of the same pitch should produce two events. Use an onset cue and a short debounce to separate attacks from jitter. Show the detected note in a small test panel and show clear states for silence and denied microphone permission. Release the microphone when stopped.
```

**Checkpoint** · Play three different notes, hold one, then play the same note twice. Try this with the instrument you’ll use on stage.

## 3. Follow the player

```text
Match each accepted microphone note-on to the expected score notes, starting at the selected bar. Highlight the next expected note and briefly mark the note that just matched. Use a short lookahead and recent timing to recover if the player skips a note. Avoid jumping ahead on a stray wrong note and keep the current position during silence. If the app loses its place, let the player select a bar to resume. Keep a record of matched notes, missed notes, and confident extra notes for the feedback screen. Make the matcher testable with a sequence of timestamped note-on events.
```

**Checkpoint** · Play slowly, pause mid-bar, then skip a note. The highlight should wait during the pause and pick up close to the skipped note.

## 4. Get the next page ready

```text
Pre-render the next score page while the musician is still on the current one. Show a readable preview of its opening bars near the end of the current page. When the player matches the first note on the next page, switch the main view to that page and keep the new highlight in view. Use confirmed score position to trigger the turn. Keep Previous Page and Next Page available for manual control. Make the page turn instant and test it in a two-page score.
```

**Checkpoint** · Pause at the end of page one. Page two should be ready. Playing its first note should turn the page.

## 5. Give pitch and timing feedback

```text
Add a target BPM and a short count-in for a scored practice run. Measure timing against the selected tempo and starting bar using the downbeat after the count-in as the reference. Use one clock for the count-in and detected note timestamps. Stop the click after the count-in so the mic hears the instrument on its own. Report pitch accuracy as matched notes divided by expected notes in the attempted passage, with extra notes listed separately. Report timing as the share of matched notes within a stated tolerance and show how early or late each was in milliseconds. Let the player click a result to jump to its bar and try again. For free-tempo practice, show pitch feedback only. If too few notes matched, show that there is insufficient audio for a timing result.
```

**Checkpoint** · Play one run on time and one with a deliberate late note and a wrong pitch. The report should show where they happened.

## 6. Wire up PDF upload

```text
Add PDF upload for clean, printed scores. Connect it to a small local backend that runs Audiveris in batch mode and returns its exported MusicXML or compressed MXL. Pass arguments directly to the process, use temporary files, and show a clear error if conversion fails or takes too long. Keep the original PDF available alongside the converted score for a quick visual check. Send imported scores through the same viewer and practice flow as the sample. Keep MusicXML upload working as a fallback.
```

**Checkpoint** · Upload the demo PDF, check the converted notes against the original, and start listening from a selected bar.

## 7. Rehearse the demo

```text
Test the complete PaperTempo flow with the prepared two-page PDF and the instrument we plan to use. Check the normal path plus microphone denial, a held note, a repeated note, a pause before a page turn, a wrong note, and a PDF that fails to convert. Fix issues that block the demo. Keep the sample MusicXML ready so we can show live following and feedback if conversion fails. Update the README with local startup steps, the Audiveris dependency, and the supported score types.
```

**60-second demo** · Upload the printed score. Start a practice run a few notes before the page break. Pause briefly, then play into page two so the audience sees it turn. Play one note late and open the results to show the feedback at that bar.

**If time gets tight** · Keep live following, the automatic page turn, and two feedback numbers. Use the MusicXML sample if PDF conversion is still unreliable and say which file you loaded.
