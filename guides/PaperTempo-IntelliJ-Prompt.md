# PaperTempo prompt for IntelliJ IDEA

Paste this prompt into your coding assistant with the `main` branch of `tipit419/KCL-First-Year-Hack` checked out in IntelliJ IDEA. If the project is missing the PaperTempo source, extract `PaperTempo-source.zip` somewhere you can point the assistant to.

## Prompt

Continue PaperTempo on the `main` branch of the `tipit419/KCL-First-Year-Hack` repository in IntelliJ IDEA. The remote is `https://github.com/tipit419/KCL-First-Year-Hack.git`. PaperTempo is a static website for practising sheet music with a microphone. The demo is time-sensitive, so use the existing browser-based implementation and keep it easy to run and host.

1. Inspect the current branch, working tree, and project structure. If PaperTempo is already in the repo, work with the existing files. Otherwise import the supplied source bundle. It contains the static site under `dist/`, the sample generator under `scripts/`, and a README. Fit the files into the repo without overwriting unrelated work. Preserve any existing hosting configuration.
2. Run the website from its local HTTP entry point. For the supplied source, run `python3 -m http.server 8000 --directory dist` and open `http://localhost:8000`. Use HTTPS for the published website because the microphone requires a secure browser context. Make sure the public website opens for a visitor who is signed out.
3. Preserve these demo features:
   - Verovio sheet music, the original two-page *Morning Lines* sample in MusicXML and PDF, and uploads for single-part, single-voice MusicXML or MXL. Allow a matching PDF to be attached for comparison. Printed PDFs need to be converted to MusicXML separately.
   - A starting-bar selector, previous and next controls, and a highlight for the next expected note. Detect one note at a time in the browser. A held note should count once, a clear repeat should count twice, and stopping should release the microphone.
   - A preview of the next page near a break. Keep the current page visible during a pause. Turn the page on a confirmed note from the new page. Tolerate a nearby skipped note and record wrong or extra notes for the results.
   - Free-tempo pitch feedback and scored-tempo feedback with a four-beat count-in and a ±120 ms timing window. A result should take the player back to its bar. Show timing only after at least three matched notes.
4. Run the demo from *Morning Lines*, Bar 9. Play E4, D4, and C4. Pause, then play G4 to turn to page two. In scored tempo, play one deliberate late note and check the results. Also check microphone denial, a held note, a repeated note, and a PDF supplied without MusicXML. Record which checks used a real instrument and which used simulated audio.
5. Commit the PaperTempo files on `main` and push to `origin/main` if your GitHub credentials grant write access. Report the branch, commit, push status, and any remaining demo blocker.

The published demo is available at [PaperTempo](https://papertempo-studio.cometeagle48.chatgpt.site/).
