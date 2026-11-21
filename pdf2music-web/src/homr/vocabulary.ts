export const nonote = ".";
export const empty = "_";

export function buildDict(tokens: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t in result) throw new Error("Duplicated entry for " + t);
    if (t.trim() !== t) throw new Error("Tokens must not contain whitespace: " + t);
    if (t.includes("&")) throw new Error("& is reserved as alternatives for chords");
    result[t] = i;
  }
  return result;
}

function product<T>(...arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>(
    (acc, arr) => acc.flatMap((row) => arr.map((item) => [...row, item])),
    [[]]
  );
}

export function buildRhythm(): Record<string, number> {
  const rhythm: string[] = [];

  rhythm.push("PAD", "BOS", "EOS");
  rhythm.push("chord");

  rhythm.push("barline", "doublebarline", "bolddoublebarline");
  rhythm.push("repeatStart", "repeatEnd", "repeatEndStart");
  rhythm.push("voltaStart", "voltaStop", "voltaDiscontinue");

  for (let c = 3; c <= 5; c++) rhythm.push(`clef_F${c}`);
  for (let c = 1; c <= 5; c++) rhythm.push(`clef_C${c}`);
  for (let c = 1; c <= 2; c++) rhythm.push(`clef_G${c}`);

  for (let c = -7; c <= 7; c++) rhythm.push(`keySignature_${c}`);
  for (const c of [1, 2, 3, 4, 6, 8, 12, 16, 32, 48]) rhythm.push(`timeSignature/${c}`);

  for (let c = 2; c <= 10; c++) rhythm.push(`rest_${c}m`);

  const kernBaseDurations = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 32, 64, 128];
  const dots = ["", ".", ".."];
  const grace = ["", "G"];
  const kernValues: string[] = [];
  for (const d of kernBaseDurations) {
    for (const g of grace) {
      for (const dot of dots) {
        kernValues.push(`${d}${g}${dot}`);
      }
    }
  }

  const irregularDurations = [7, 11, 13, 18, 20, 21, 22, 24, 26, 28, 30, 34, 36, 40, 48, 56, 96];

  for (const d of kernValues) rhythm.push(`note_${d}`);
  for (const d of irregularDurations) rhythm.push(`note_${d}`);
  for (const d of kernValues) rhythm.push(`rest_${d}`);
  for (const d of irregularDurations) rhythm.push(`rest_${d}`);

  return buildDict(rhythm);
}

export function buildLift(): Record<string, number> {
  return buildDict([nonote, empty, "#", "##", "N", "b", "bb"]);
}

export function buildPosition(): Record<string, number> {
  return buildDict([nonote, "upper", "lower"]);
}

export function buildArticulation(): Record<string, number> {
  const articulation = [nonote, empty];
  const articulationsLieder = [
    "accent", "accent_arpeggiate", "accent_arpeggiate_fermata",
    "accent_arpeggiate_staccato", "accent_arpeggiate_tenuto",
    "accent_breathMark", "accent_breathMark_fermata", "accent_fermata",
    "accent_fermata_staccato", "accent_staccatissimo", "accent_staccato",
    "accent_staccato_tenuto", "accent_tenuto", "accent_tremolo",
    "accent_trill", "accent_fermata_trill", "arpeggiate",
    "arpeggiate_breathMark_fermata", "arpeggiate_fermata",
    "arpeggiate_fermata_staccato", "arpeggiate_staccatissimo",
    "arpeggiate_staccato", "arpeggiate_staccato_tenuto",
    "arpeggiate_tenuto", "arpeggiate_tremolo", "arpeggiate_trill",
    "breathMark", "breathMark_fermata", "breathMark_fermata_tenuto",
    "breathMark_staccato", "breathMark_tenuto", "breathMark_trill",
    "breathMark_tremolo", "breathMark_staccato_tenuto", "fermata",
    "fermata_staccato", "fermata_staccato_tenuto", "fermata_tenuto",
    "fermata_tremolo", "fermata_trill", "fermata_turn", "spiccato",
    "staccatissimo", "staccato", "staccato_tenuto", "staccato_tremolo",
    "staccato_trill", "staccato_turn", "tenuto", "tremolo", "trill", "turn",
  ];
  articulation.push(...articulationsLieder);
  return buildDict(articulation);
}

export function buildSlur(): Record<string, number> {
  return buildDict([nonote, empty, "slurStart_slurStop", "slurStart", "slurStop"]);
}

export function buildPitch(): Record<string, number> {
  const pitch = [nonote, empty];
  const noteNames = ["C", "D", "E", "F", "G", "A", "B"];
  const octaveRange: number[] = [];
  for (let o = 0; o < 10; o++) octaveRange.push(o);
  const all: string[] = [];
  for (const octave of octaveRange) {
    for (const n of noteNames) {
      all.push(`${n}${octave}`);
    }
  }
  all.reverse();
  pitch.push(...all);
  return buildDict(pitch);
}

export function hasRhythmSymbolAPosition(rhythm: string): boolean {
  return rhythm.startsWith("note") || rhythm.startsWith("rest") || rhythm.startsWith("clef");
}

export class Vocabulary {
  rhythm: Record<string, number>;
  lift: Record<string, number>;
  articulation: Record<string, number>;
  pitch: Record<string, number>;
  slur: Record<string, number>;
  position: Record<string, number>;

  constructor() {
    this.rhythm = buildRhythm();
    this.lift = buildLift();
    this.articulation = buildArticulation();
    this.pitch = buildPitch();
    this.slur = buildSlur();
    this.position = buildPosition();
  }
}
