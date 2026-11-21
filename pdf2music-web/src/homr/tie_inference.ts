/**
 * Recovers ties from the model output.
 *
 * homr's transformer has no tie tokens at all — its vocabulary only knows
 * `slurStart`/`slurStop` — so a tie in the score comes back as a slur. A curved
 * line joining two adjacent notes of the same pitch is a tie by definition, so
 * those pairs are rewritten into real ties here.
 *
 * `<tie>` is the sounding element and `<tied>` the notated one; both are
 * emitted, which is what makes players and notation editors agree.
 *
 * Runs on the main thread: it needs DOMParser.
 */
export function inferTies(musicxml: string): string {
  const doc = new DOMParser().parseFromString(musicxml, "text/xml");
  if (doc.querySelector("parsererror")) return musicxml;

  for (const part of Array.from(doc.querySelectorAll("part"))) {
    // Notes belonging to different staves or voices are not adjacent to each
    // other even when they are adjacent in the document.
    const byLayer = new Map<string, Element[]>();
    for (const note of Array.from(part.querySelectorAll("note"))) {
      const layer = `${note.querySelector("staff")?.textContent ?? ""}/${
        note.querySelector("voice")?.textContent ?? ""
      }`;
      const notes = byLayer.get(layer);
      if (notes) notes.push(note);
      else byLayer.set(layer, [note]);
    }

    for (const notes of byLayer.values()) {
      for (let i = 0; i + 1 < notes.length; i++) {
        const first = notes[i];
        const second = notes[i + 1];
        const pitch = pitchKey(first);
        if (!pitch || pitch !== pitchKey(second)) continue;

        const startSlur = findSlur(first, "start");
        const stopSlur = findSlur(second, "stop");
        if (!startSlur || !stopSlur) continue;

        startSlur.remove();
        stopSlur.remove();
        addTie(doc, first, "start");
        addTie(doc, second, "stop");
      }
    }
  }

  return new XMLSerializer().serializeToString(doc);
}

function pitchKey(note: Element): string | null {
  const pitch = note.querySelector("pitch");
  if (!pitch || note.querySelector("rest")) return null;
  const step = pitch.querySelector("step")?.textContent ?? "";
  const alter = pitch.querySelector("alter")?.textContent ?? "0";
  const octave = pitch.querySelector("octave")?.textContent ?? "";
  return `${step}${alter}${octave}`;
}

function findSlur(note: Element, type: "start" | "stop"): Element | null {
  return note.querySelector(`notations > slur[type="${type}"]`);
}

function addTie(doc: Document, note: Element, type: "start" | "stop") {
  if (note.querySelector(`tie[type="${type}"]`)) return;

  // <tie> is a direct child of <note> and must precede <voice>/<type>.
  const tie = doc.createElement("tie");
  tie.setAttribute("type", type);
  const duration = note.querySelector("duration");
  note.insertBefore(tie, duration ? duration.nextSibling : note.firstChild);

  let notations = note.querySelector("notations");
  if (!notations) {
    notations = doc.createElement("notations");
    note.appendChild(notations);
  }
  const tied = doc.createElement("tied");
  tied.setAttribute("type", type);
  // <tied> comes first inside <notations>.
  notations.insertBefore(tied, notations.firstChild);
}
