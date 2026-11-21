import { EncodedSymbol } from "./encoded_symbol";
import { empty, nonote } from "./vocabulary";

function eprint(...args: any[]): void {
  console.warn(...args);
}

export const definition: Record<number, string> = {
  [-7]: "CbM",
  [-6]: "GbM",
  [-5]: "DbM",
  [-4]: "AbM",
  [-3]: "EbM",
  [-2]: "BbM",
  [-1]: "FM",
  0: "CM",
  1: "GM",
  2: "DM",
  3: "AM",
  4: "EM",
  5: "BM",
  6: "F#M",
  7: "C#M",
};

export const inv_definition: Record<string, number> = (() => {
  const result: Record<string, number> = {};
  for (const k of Object.keys(definition)) {
    result[definition[Number(k)]] = Number(k);
  }
  return result;
})();

export const circle_of_fifth_notes_positive: string[] = ["F", "C", "G", "D", "A", "E", "B"];
export const circle_of_fifth_notes_negative: string[] = [
  ...circle_of_fifth_notes_positive,
].reverse();

export function key_signature_to_circle_of_fifth(key_signature: string): number {
  if (!(key_signature in inv_definition)) {
    eprint("Warning: Unknown key signature", key_signature);
    return 0;
  }
  return inv_definition[key_signature];
}

export function repeat_note_for_all_octaves(notes: string[]): string[] {
  const result: string[] = [];
  for (const note of notes) {
    for (let octave = 0; octave < 11; octave++) {
      result.push(note + String(octave));
    }
  }
  return result;
}

export abstract class AbstractKeyTransformation {
  abstract add_accidental(note: string, accidental: string): string;
  abstract reset_at_end_of_measure(): AbstractKeyTransformation;
}

export class NoKeyTransformation extends AbstractKeyTransformation {
  current_accidentals: Record<string, string> = {};

  add_accidental(note: string, accidental: string): string {
    if (
      accidental !== "" &&
      (!(note in this.current_accidentals) || this.current_accidentals[note] !== accidental)
    ) {
      this.current_accidentals[note] = accidental;
      return accidental;
    } else {
      return "";
    }
  }

  reset_at_end_of_measure(): NoKeyTransformation {
    return new NoKeyTransformation();
  }
}

export class KeyTransformation extends AbstractKeyTransformation {
  circle_of_fifth: number;
  sharps: Set<string> = new Set();
  flats: Set<string> = new Set();

  constructor(circle_of_fifth: number) {
    super();
    this.circle_of_fifth = circle_of_fifth;
    if (circle_of_fifth > 0) {
      this.sharps = new Set(
        repeat_note_for_all_octaves(
          circle_of_fifth_notes_positive.slice(0, circle_of_fifth)
        )
      );
    } else if (circle_of_fifth < 0) {
      this.flats = new Set(
        repeat_note_for_all_octaves(
          circle_of_fifth_notes_negative.slice(0, Math.abs(circle_of_fifth))
        )
      );
    }
  }

  add_accidental(note: string, accidental: string | null): string {
    if (accidental === "#" || accidental === "b" || accidental === "N") {
      let previous_accidental = "N";
      if (this.sharps.has(note)) {
        this.sharps.delete(note);
        previous_accidental = "#";
      }
      if (this.flats.has(note)) {
        this.flats.delete(note);
        previous_accidental = "b";
      }
      if (accidental === "#") {
        this.sharps.add(note);
      } else if (accidental === "b") {
        this.flats.add(note);
      }
      return accidental !== previous_accidental ? accidental : "";
    } else {
      if (this.sharps.has(note)) {
        this.sharps.delete(note);
        return "N";
      }
      if (this.flats.has(note)) {
        this.flats.delete(note);
        return "N";
      }
      return "";
    }
  }

  reset_at_end_of_measure(): KeyTransformation {
    return new KeyTransformation(this.circle_of_fifth);
  }
}

export function maintain_accidentals_during_measure(
  symbols: EncodedSymbol[]
): EncodedSymbol[] {
  const results: EncodedSymbol[] = [];
  let key: AbstractKeyTransformation = new KeyTransformation(0);

  for (const symbol of symbols) {
    if (symbol.rhythm.includes("barline")) {
      key = key.reset_at_end_of_measure();
      results.push(symbol);
    } else if (symbol.lift !== nonote) {
      const lift = symbol.lift !== empty ? symbol.lift : null;
      let actual_accidental: string | null = null;

      if (lift === "#" || lift === "b" || lift === "N") {
        actual_accidental = lift;
        key.add_accidental(symbol.pitch, lift);
      } else if ((key as KeyTransformation).sharps.has(symbol.pitch)) {
        actual_accidental = "#";
      } else if ((key as KeyTransformation).flats.has(symbol.pitch)) {
        actual_accidental = "b";
      } else {
        actual_accidental = empty;
      }

      results.push(symbol.changeLift(actual_accidental ? actual_accidental : empty));
    } else {
      results.push(symbol);
    }
  }

  return results;
}

export function strip_naturals(symbols: EncodedSymbol[]): EncodedSymbol[] {
  const results: EncodedSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.lift === "N") {
      results.push(symbol.changeLift(empty));
    } else {
      results.push(symbol);
    }
  }
  return results;
}
