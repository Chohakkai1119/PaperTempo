import { Midi } from "@tonejs/midi";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteNameToMidi(step: string, alter: number, octave: number): number {
  const baseIdx = NOTE_NAMES.indexOf(step);
  if (baseIdx < 0) return 60;
  return (octave + 1) * 12 + baseIdx + alter;
}

function parseDuration(duration: string, divisions: number): number {
  const parts = duration.split("/").map(Number);
  if (parts.length === 1) return parts[0];
  return parts[0] / parts[1];
}

export function musicxmlToMidi(musicxml: string): ArrayBuffer {
  const parser = new DOMParser();
  const doc = parser.parseFromString(musicxml, "text/xml");

  const midi = new Midi();
  const track = midi.addTrack();
  track.name = "Score";

  const part = doc.querySelector("part");
  if (!part) return midi.toArray().buffer as ArrayBuffer;

  const divisionsEl = doc.querySelector("divisions");
  const divisions = divisionsEl ? parseInt(divisionsEl.textContent || "1") : 1;
  // @tonejs/midi's ppq is read-only, so note positions are converted from
  // MusicXML divisions into the header's own tick resolution instead.
  const ppq = midi.header.ppq;
  track.instrument.number = 0;

  let currentTime = 0;
  // A note whose tie continues extends the note already written instead of
  // sounding again. Keyed by pitch *and* layer: chords tie independently, and
  // the same pitch sounding in another voice must not break the tie.
  const openTies = new Map<string, { note: any; endTicks: number }>();

  const measures = part.querySelectorAll(":scope > measure");
  for (const measure of measures) {
    let divisionsInMeasure = divisions;

    const divisionsElInMeasure = measure.querySelector("attributes > divisions");
    if (divisionsElInMeasure) {
      divisionsInMeasure = parseInt(divisionsElInMeasure.textContent || "1");
    }

    const children = Array.from(measure.children);
    let timeInMeasure = 0;

    for (const child of children) {
      if (child.tagName === "backup") {
        const dur = child.querySelector("duration");
        if (dur) {
          timeInMeasure -= parseDuration(dur.textContent || "0", divisionsInMeasure);
        }
      } else if (child.tagName === "forward") {
        const dur = child.querySelector("duration");
        if (dur) {
          timeInMeasure += parseDuration(dur.textContent || "0", divisionsInMeasure);
        }
      } else if (child.tagName === "note") {
        const isRest = child.querySelector("rest") !== null;
        const isChord = child.querySelector("chord") !== null;
        const pitchEl = child.querySelector("pitch");
        const durationEl = child.querySelector("duration");
        const duration = durationEl
          ? parseDuration(durationEl.textContent || "0", divisionsInMeasure)
          : 0;

        if (isChord) {
          // don't advance time
        } else {
          if (!isChord) timeInMeasure = Math.max(timeInMeasure, 0);
        }

        if (!isRest && pitchEl) {
          const step = pitchEl.querySelector("step")?.textContent || "C";
          const alter = parseInt(pitchEl.querySelector("alter")?.textContent || "0");
          const octave = parseInt(pitchEl.querySelector("octave")?.textContent || "4");
          const midiNote = noteNameToMidi(step, alter, octave);

          const noteTime = currentTime + (isChord ? timeInMeasure - duration : timeInMeasure);
          const startTicks = Math.round((noteTime / divisionsInMeasure) * ppq);
          const durationTicks = Math.max(
            1,
            Math.round((duration / divisionsInMeasure) * ppq)
          );

          const tiesFrom = child.querySelector('tie[type="stop"]') !== null;
          const tiesTo = child.querySelector('tie[type="start"]') !== null;
          const tieKey = [
            midiNote,
            child.querySelector("staff")?.textContent ?? "",
            child.querySelector("voice")?.textContent ?? "",
          ].join(":");
          const open = openTies.get(tieKey);
          // Independent rounding of each note, and measures whose voices are
          // walked with <backup>, leave the two halves of a tie a tick or two
          // apart, so the join is matched with a tolerance.
          const joins = open && Math.abs(open.endTicks - startTicks) <= ppq / 8;

          if (tiesFrom && open && joins) {
            // Continuation: lengthen the sounding note rather than restrike it.
            open.endTicks = startTicks + durationTicks;
            open.note.durationTicks = open.endTicks - open.note.ticks;
            if (!tiesTo) openTies.delete(tieKey);
          } else {
            track.addNote({
              midi: midiNote,
              ticks: startTicks,
              durationTicks,
              velocity: 0.8,
            });
            // addNote keeps `notes` sorted by tick and returns the track, so the
            // note just inserted has to be looked up.
            const note = track.notes.find(
              (n) => n.midi === midiNote && n.ticks === startTicks
            );
            if (tiesTo && note) {
              openTies.set(tieKey, { note, endTicks: startTicks + durationTicks });
            } else {
              openTies.delete(tieKey);
            }
          }
        }

        if (!isChord) {
          timeInMeasure += duration;
        }
      }
    }

    currentTime += timeInMeasure;
  }

  return midi.toArray().buffer as ArrayBuffer;
}
