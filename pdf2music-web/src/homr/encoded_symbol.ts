import { Fraction } from "./fraction";
import { nonote, empty, hasRhythmSymbolAPosition } from "./vocabulary";

export class SymbolDuration {
  base_duration: Fraction;
  dots: number;
  actual_notes: number;
  normal_notes: number;
  kern: number;
  fraction: Fraction;

  constructor(
    base_duration: Fraction,
    dots: number,
    actual_notes: number,
    normal_notes: number,
    kern: number
  ) {
    this.base_duration = base_duration;
    this.dots = dots;
    const actionNormal = new Fraction(actual_notes, normal_notes);
    this.actual_notes = actionNormal.numerator;
    this.normal_notes = actionNormal.denominator;
    this.fraction = this._toFraction();
    this.kern = kern;
  }

  private _toFraction(): Fraction {
    let dur = this.base_duration;
    let add = dur.div(2);
    for (let i = 0; i < this.dots; i++) {
      dur = dur.add(add);
      add = add.div(2);
    }
    if (this.actual_notes !== this.normal_notes) {
      dur = dur.mul(new Fraction(this.normal_notes, this.actual_notes));
    }
    return dur;
  }
}

export function priorPowerOfTwo(n: number): number {
  if (n < 1) return 1;
  return 1 << (n.toString(2).length - 1);
}

export function kernToSymbolDuration(kern: string): SymbolDuration {
  if (kern.endsWith("m")) {
    return new SymbolDuration(new Fraction(1), 0, 1, 1, 4);
  }

  let i = 0;
  while (i < kern.length && kern[i].match(/\d/)) i++;
  const baseStr = kern.substring(0, i);
  const rest = kern.substring(i);

  const base = baseStr ? parseInt(baseStr) : 4;
  const dots = (rest.match(/\./g) || []).length;

  if (kern.includes("G")) {
    return new SymbolDuration(new Fraction(0), dots, 1, 1, base);
  }
  if (base === 0) {
    return new SymbolDuration(new Fraction(1), dots, 1, 1, base);
  }

  if ((base & (base - 1)) === 0) {
    return new SymbolDuration(new Fraction(1, base), dots, 1, 1, base);
  } else {
    const normalNotes = priorPowerOfTwo(base);
    return new SymbolDuration(new Fraction(1, normalNotes), dots, base, normalNotes, normalNotes);
  }
}

export class EncodedSymbol {
  rhythm: string;
  pitch: string;
  lift: string;
  articulation: string;
  slur: string;
  position: string;
  coordinates: Float32Array | null;
  private _duration: SymbolDuration | null = null;

  constructor(
    rhythm: string,
    pitch: string = nonote,
    lift: string = nonote,
    articulation: string = nonote,
    slur: string = nonote,
    position: string = nonote,
    coordinates: Float32Array | null = null
  ) {
    this.rhythm = rhythm;
    this.pitch = pitch;
    this.lift = lift;
    this.articulation = articulation;
    this.slur = slur;
    this.position = position;
    this.coordinates = coordinates;
  }

  isControlSymbol(): boolean {
    return this.rhythm === "BOS" || this.rhythm === "EOS" || this.rhythm === "PAD";
  }

  isTuplet(): boolean {
    const noTuplet = this.removeTuplet();
    return noTuplet.rhythm !== this.rhythm;
  }

  removeTuplet(): EncodedSymbol {
    const match = this.rhythm.match(/^(note|rest)_(\d+)(.*)$/);
    if (!match) return this;
    let duration = parseInt(match[2]);
    if (duration % 3 === 0) duration = (duration / 3) * 2;
    else if (duration % 5 === 0) duration = (duration / 5) * 4;
    else if (duration % 7 === 0) duration = (duration / 7) * 4;
    else return this;

    const result = this.clone();
    result.rhythm = match[1] + "_" + duration + match[3];
    result._duration = null;
    return result;
  }

  changeLift(lift: string): EncodedSymbol {
    const result = this.clone();
    result.lift = lift;
    return result;
  }

  toUpperPosition(): EncodedSymbol {
    if (this.position !== "lower") return this;
    const result = this.clone();
    result.position = "upper";
    return result;
  }

  isValid(): boolean {
    const hasPosition = hasRhythmSymbolAPosition(this.rhythm);
    const isNote = [this.lift, this.articulation, this.pitch, this.slur, this.position].map(
      (s) => s !== nonote
    );
    return isNote.every((item) => item === hasPosition);
  }

  addArticulations(articulations: string[]): EncodedSymbol {
    const all: string[] = [];
    all.push(...articulations);
    all.push(...this.articulation.split("_").filter((a) => a));
    const result = this.clone();
    result.articulation = [...new Set(all)].sort().join("_");
    return result;
  }

  addSlurs(slurs: string[]): EncodedSymbol {
    const all: string[] = [];
    all.push(...slurs);
    all.push(...this.slur.split("_").filter((a) => a));
    const result = this.clone();
    result.slur = [...new Set(all)].sort().join("_");
    return result;
  }

  stripArticulations(toBeRemoved: string[], removeAll: boolean = false): [string[], EncodedSymbol] {
    if (this.articulation === nonote && !hasRhythmSymbolAPosition(this.rhythm)) {
      return [[], this.clone()];
    }
    const stripped: string[] = [];
    const remaining: string[] = [];
    for (const art of this.articulation.split("_")) {
      if (!art) continue;
      if (removeAll || toBeRemoved.includes(art)) stripped.push(art);
      else remaining.push(art);
    }
    const result = this.clone();
    result.articulation = remaining.length ? remaining.join("_") : empty;
    return [stripped, result];
  }

  stripSlurs(toBeRemoved: string[], removeAll: boolean = false): [string[], EncodedSymbol] {
    if (this.slur === nonote && !hasRhythmSymbolAPosition(this.rhythm)) {
      return [[], this.clone()];
    }
    const stripped: string[] = [];
    const remaining: string[] = [];
    for (const slur of this.slur.split("_")) {
      if (!slur) continue;
      if (removeAll || toBeRemoved.includes(slur)) stripped.push(slur);
      else remaining.push(slur);
    }
    const result = this.clone();
    result.slur = remaining.length ? remaining.join("_") : empty;
    return [stripped, result];
  }

  getDuration(): SymbolDuration {
    if (this._duration) return this._duration;
    const rhythm = this.rhythm;
    if (!rhythm.startsWith("note") && !rhythm.startsWith("rest")) {
      return new SymbolDuration(new Fraction(0), 0, 1, 1, 1);
    }
    const kern = rhythm.split("_")[1];
    const duration = kernToSymbolDuration(kern);
    this._duration = duration;
    return duration;
  }

  clone(): EncodedSymbol {
    const s = new EncodedSymbol(
      this.rhythm,
      this.pitch,
      this.lift,
      this.articulation,
      this.slur,
      this.position,
      this.coordinates
    );
    s._duration = this._duration;
    return s;
  }

  toString(): string {
    return [this.rhythm, this.pitch, this.lift, this.articulation, this.slur, this.position].join(
      " "
    );
  }

  equals(other: EncodedSymbol): boolean {
    return (
      this.rhythm === other.rhythm &&
      this.pitch === other.pitch &&
      this.lift === other.lift &&
      this.articulation === other.articulation &&
      this.slur === other.slur &&
      this.position === other.position
    );
  }

  hashKey(): string {
    return [this.rhythm, this.pitch, this.lift, this.articulation, this.slur, this.position].join(
      "|"
    );
  }

  compareTo(other: EncodedSymbol): number {
    return this.toString() > other.toString() ? 1 : this.toString() < other.toString() ? -1 : 0;
  }
}

export function groupIntoChords(symbols: EncodedSymbol[]): EncodedSymbol[][] {
  const chords: EncodedSymbol[][] = [];
  let isInChord = false;
  for (const symbol of symbols) {
    if (symbol.rhythm === "chord") {
      isInChord = true;
    } else if (isInChord && chords.length > 0) {
      chords[chords.length - 1].push(symbol);
      isInChord = false;
    } else {
      chords.push([symbol]);
    }
  }
  return chords;
}

export function flattenChords(chords: EncodedSymbol[][]): EncodedSymbol[] {
  const result: EncodedSymbol[] = [];
  for (const chord of chords) {
    if (chords.length === 0) continue;
    let isInChord = false;
    for (const symbol of chord) {
      if (isInChord) result.push(new EncodedSymbol("chord"));
      result.push(symbol);
      isInChord = true;
    }
  }
  return result;
}

function groupIntoMeasures(chords: EncodedSymbol[][]): EncodedSymbol[][][] {
  const measures: EncodedSymbol[][][] = [];
  let currentMeasure: EncodedSymbol[][] = [];
  for (const chord of chords) {
    currentMeasure.push(chord);
    if (chord.length > 0 && (chord[0].rhythm.includes("barline") || chord[0].rhythm.includes("repeat"))) {
      measures.push(currentMeasure);
      currentMeasure = [];
    }
  }
  if (currentMeasure.length > 0) measures.push(currentMeasure);
  return measures;
}

function flattenMeasures(measures: EncodedSymbol[][][]): EncodedSymbol[][] {
  const result: EncodedSymbol[][] = [];
  for (const measure of measures) {
    for (const chord of measure) {
      result.push(chord);
    }
  }
  return result;
}

function getDurationOfMeasure(measure: EncodedSymbol[][]): Fraction {
  let totalDuration = new Fraction(0);
  for (const chord of measure) {
    let duration = new Fraction(0);
    for (const symbol of chord) {
      if (symbol.rhythm.startsWith("note") || symbol.rhythm.startsWith("rest")) {
        const fraction = symbol.getDuration().fraction;
        if (!fraction.isZero() && (fraction.lt(duration) || duration.isZero())) {
          duration = fraction;
        }
      }
    }
    totalDuration = totalDuration.add(duration);
  }
  return totalDuration;
}

function getTypicalDurationOfMeasures(measures: EncodedSymbol[][][]): Fraction {
  const durations = measures.map(getDurationOfMeasure);
  if (durations.length === 0) return new Fraction(0);
  durations.sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
  return durations[Math.floor(durations.length / 2)];
}

function removeTuplets(measure: EncodedSymbol[][]): EncodedSymbol[][] {
  return measure.map((chord) => chord.map((symbol) => symbol.removeTuplet()));
}

function fixOverEagerTuplets(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  const measures = groupIntoMeasures(chords);
  const mean = getTypicalDurationOfMeasures(measures);
  const result: EncodedSymbol[][][] = [];
  for (let i = 0; i < measures.length; i++) {
    if (getDurationOfMeasure(measures[i]).lt(mean)) {
      result.push(removeTuplets(measures[i]));
    } else {
      result.push(measures[i]);
    }
  }
  return flattenMeasures(result);
}

function onlyKeepLowerStaffIfThereIsAClef(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  let hasLowerClef = false;
  const allResults: EncodedSymbol[][] = [];
  for (let i = 0; i < chords.length; i++) {
    const chord = chords[i];
    const result: EncodedSymbol[] = [];
    for (const symbol of chord) {
      if (hasLowerClef) {
        result.push(symbol);
      } else if (i < 5 && symbol.rhythm.startsWith("clef") && symbol.position === "lower") {
        hasLowerClef = true;
        result.push(symbol);
      } else {
        result.push(symbol.toUpperPosition());
      }
    }
    allResults.push(result);
  }
  return allResults;
}

function removeDuplicatedPitches(chord: EncodedSymbol[]): EncodedSymbol[] {
  if (chord.length <= 1 || !(chord[0].rhythm.startsWith("note") || chord[0].rhythm.startsWith("rest"))) {
    return chord;
  }
  const byPitch = new Map<string, EncodedSymbol>();
  const orderOfAppearance: string[] = [];
  for (const symbol of chord) {
    const key = symbol.pitch + " " + symbol.position;
    if (byPitch.has(key)) {
      if (symbol.getDuration().fraction.gt(byPitch.get(key)!.getDuration().fraction)) {
        byPitch.set(key, symbol);
      }
    } else {
      byPitch.set(key, symbol);
      orderOfAppearance.push(key);
    }
  }
  return orderOfAppearance.map((k) => byPitch.get(k)!);
}

function removeRedundantClefsKeysAndTimeSignatures(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  let clefUpper = "";
  let clefLower = "";
  let key = "";
  let time = "";
  const resultChords: EncodedSymbol[][] = [];
  for (const chord of chords) {
    const result: EncodedSymbol[] = [];
    for (const symbol of chord) {
      if (symbol.rhythm.startsWith("clef")) {
        if (symbol.position === "upper") {
          if (symbol.rhythm !== clefUpper) {
            clefUpper = symbol.rhythm;
            result.push(symbol);
          }
        } else if (symbol.rhythm !== clefLower) {
          clefLower = symbol.rhythm;
          result.push(symbol);
        }
      } else if (symbol.rhythm.startsWith("keySignature")) {
        if (symbol.rhythm !== key) {
          key = symbol.rhythm;
          result.push(symbol);
        }
      } else if (symbol.rhythm.startsWith("timeSignature")) {
        if (symbol.rhythm !== time) {
          time = symbol.rhythm;
          result.push(symbol);
        }
      } else {
        result.push(symbol);
      }
    }
    resultChords.push(result);
  }
  return resultChords;
}

export function removeDuplicatedSymbols(
  symbols: EncodedSymbol[],
  cleanupTuplets: boolean = true
): EncodedSymbol[] {
  let chords = groupIntoChords(symbols);
  if (cleanupTuplets) {
    chords = fixOverEagerTuplets(chords);
    chords = onlyKeepLowerStaffIfThereIsAClef(chords);
  }
  chords = chords.map(removeDuplicatedPitches);
  chords = removeRedundantClefsKeysAndTimeSignatures(chords);
  return flattenChords(chords);
}

export function sortTokenChords(
  symbols: EncodedSymbol[],
  keepChordSymbol: boolean = false
): EncodedSymbol[][] {
  const chords: EncodedSymbol[][] = [];
  let isInChord = false;
  for (const symbol of symbols) {
    if (symbol.rhythm === "chord") {
      isInChord = true;
    } else if (isInChord && chords.length > 0) {
      if (keepChordSymbol) chords[chords.length - 1].push(new EncodedSymbol("chord"));
      chords[chords.length - 1].push(symbol);
      isInChord = false;
    } else {
      chords.push([symbol]);
    }
  }
  return chords.map((chord) => [...chord].sort((a, b) => a.compareTo(b)));
}
