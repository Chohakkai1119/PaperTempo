import { Fraction } from "./fraction";
import { duration_of_quarter } from "./constants";
import {
  EncodedSymbol,
  SymbolDuration,
  sortTokenChords,
} from "./encoded_symbol";
import { empty, nonote } from "./vocabulary";

function eprint(...args: any[]): void {
  console.warn(...args);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// MusicXML's schema defines most elements as an ordered sequence, and readers
// such as MuseScore reject a file whose children are out of order ("corrupted
// file"). The Python version gets this for free because music21's element
// classes reorder on serialisation; here the order is applied explicitly, so
// the builder code below can stay a straight port of the Python.
const CHILD_ORDER: Record<string, string[]> = {
  "score-partwise": [
    "work", "movement-number", "movement-title", "identification", "defaults",
    "credit", "part-list", "part",
  ],
  work: ["work-number", "work-title", "opus"],
  identification: ["creator", "rights", "encoding", "source", "relation", "miscellaneous"],
  encoding: ["encoding-date", "encoder", "software", "encoding-description", "supports"],
  defaults: [
    "scaling", "concert-score", "page-layout", "system-layout", "staff-layout",
    "appearance", "music-font", "word-font", "lyric-font", "lyric-language",
  ],
  "part-list": ["part-group", "score-part"],
  "score-part": [
    "identification", "part-link", "part-name", "part-name-display",
    "part-abbreviation", "part-abbreviation-display", "group",
    "score-instrument", "player", "midi-device", "midi-instrument",
  ],
  attributes: [
    "footnote", "level", "divisions", "key", "time", "staves", "part-symbol",
    "instruments", "clef", "staff-details", "transpose", "for-part",
    "directive", "measure-style",
  ],
  key: ["cancel", "fifths", "mode", "key-step", "key-alter", "key-accidental", "key-octave"],
  time: ["beats", "beat-type", "interchangeable", "senza-misura"],
  clef: ["sign", "line", "clef-octave-change"],
  note: [
    "grace", "tie", "cue", "chord", "pitch", "unpitched", "rest", "duration",
    "instrument", "footnote", "level", "voice", "type", "dot", "accidental",
    "time-modification", "stem", "notehead", "notehead-text", "staff", "beam",
    "notations", "lyric", "play", "listen",
  ],
  pitch: ["step", "alter", "octave"],
  "time-modification": ["actual-notes", "normal-notes", "normal-type", "normal-dot"],
  notations: [
    "footnote", "level", "tied", "slur", "tuplet", "glissando", "slide",
    "ornaments", "technical", "articulations", "dynamics", "fermata",
    "arpeggiate", "non-arpeggiate", "accidental-mark", "other-notation",
  ],
  articulations: [
    "accent", "strong-accent", "staccato", "tenuto", "detached-legato",
    "staccatissimo", "spiccato", "scoop", "plop", "doit", "falloff",
    "breath-mark", "caesura", "stress", "unstress", "soft-accent",
    "other-articulation",
  ],
  ornaments: [
    "trill-mark", "turn", "delayed-turn", "inverted-turn",
    "delayed-inverted-turn", "vertical-turn", "inverted-vertical-turn",
    "shake", "wavy-line", "mordent", "inverted-mordent", "schleifer",
    "tremolo", "haydn", "other-ornament", "accidental-mark",
  ],
  backup: ["duration", "footnote", "level"],
  forward: ["duration", "footnote", "level", "voice", "staff"],
  barline: [
    "bar-style", "footnote", "level", "wavy-line", "segno", "coda", "fermata",
    "ending", "repeat",
  ],
  direction: [
    "direction-type", "offset", "footnote", "level", "voice", "staff", "sound",
    "listening",
  ],
  metronome: [
    "beat-unit", "beat-unit-dot", "beat-unit-tied", "per-minute",
    "metronome-arrows", "metronome-note", "metronome-relation",
  ],
};

/** Stable sort of `children` into the order the schema declares for `tagName`. */
function inSchemaOrder(tagName: string, children: XmlElement[]): XmlElement[] {
  const order = CHILD_ORDER[tagName];
  if (!order) return children;
  return children
    .map((child, index) => ({ child, index }))
    .sort((a, b) => {
      const ra = order.indexOf(a.child.tagName);
      const rb = order.indexOf(b.child.tagName);
      // Unknown tags keep their position relative to each other, at the end.
      const ka = ra < 0 ? order.length : ra;
      const kb = rb < 0 ? order.length : rb;
      return ka - kb || a.index - b.index;
    })
    .map((entry) => entry.child);
}

class XmlElement {
  tagName: string;
  value: string | null = null;
  attributes: Record<string, string | number> = {};
  children: XmlElement[] = [];

  constructor(
    tagName: string,
    value: string | number | null = null,
    attributes: Record<string, string | number> = {}
  ) {
    this.tagName = tagName;
    if (value !== null) this.value = String(value);
    this.attributes = { ...attributes };
  }

  addChild(child: XmlElement): XmlElement {
    this.children.push(child);
    return child;
  }

  getChildren(): XmlElement[] {
    return this.children;
  }

  getChildrenOfType(tagName: string): XmlElement[] {
    return this.children.filter((c) => c.tagName === tagName);
  }

  toXml(indent: number = 0): string {
    const pad = "  ".repeat(indent);
    const attrStr = Object.entries(this.attributes)
      .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
      .join("");
    if (this.children.length === 0 && (this.value === null || this.value === "")) {
      return `${pad}<${this.tagName}${attrStr} />`;
    }
    if (this.children.length === 0) {
      return `${pad}<${this.tagName}${attrStr}>${escapeXml(this.value!)}</${this.tagName}>`;
    }
    let inner = "";
    for (const c of inSchemaOrder(this.tagName, this.children)) {
      inner += c.toXml(indent + 1) + "\n";
    }
    return `${pad}<${this.tagName}${attrStr}>\n${inner}${pad}</${this.tagName}>`;
  }
}

function el(
  tagName: string,
  value: string | number | null = null,
  attributes: Record<string, string | number> = {}
): XmlElement {
  return new XmlElement(tagName, value, attributes);
}

function toInt(f: Fraction): number {
  return Math.floor(f.numerator / f.denominator);
}

function minFraction(fracs: Fraction[]): Fraction {
  let m = fracs[0];
  for (let i = 1; i < fracs.length; i++) {
    if (fracs[i].lt(m)) m = fracs[i];
  }
  return m;
}

export class XmlGeneratorArguments {
  output_large_page: boolean;
  output_metronome: number | null;
  output_tempo: number | null;

  constructor(
    large_page: boolean = false,
    metronome: number | null = null,
    tempo: number | null = null
  ) {
    this.output_large_page = large_page;
    this.output_metronome = metronome;
    this.output_tempo = tempo;
  }
}

class ConversionState {
  beats: number = 4 * duration_of_quarter;
  division: number;
  nominator: Fraction;
  tremolo_state: string = "stop";
  volta_number: number = 1;
  last_volta_measure: number = -10;

  constructor(division: number, nominator: Fraction) {
    this.division = division;
    this.nominator = nominator;
  }

  start_volta(measure_no: number): number {
    if (measure_no === this.last_volta_measure + 1) {
      this.volta_number += 1;
    } else {
      this.volta_number = 1;
    }
    return this.volta_number;
  }

  stop_volta(measure_no: number): number {
    this.last_volta_measure = measure_no;
    return this.volta_number;
  }

  toggle_tremolo_state(): string {
    if (this.tremolo_state === "start") {
      this.tremolo_state = "stop";
    } else {
      this.tremolo_state = "start";
    }
    return this.tremolo_state;
  }
}

class SymbolChord {
  symbols: EncodedSymbol[];
  tuplet_mark: string;

  constructor(symbols: EncodedSymbol[], tuplet_mark: string = "") {
    this.symbols = symbols;
    this.tuplet_mark = tuplet_mark;
  }

  toString(): string {
    return this.symbols.map((s) => s.toString()).join("&");
  }

  is_barline(): boolean {
    if (this.symbols.length === 0) return false;
    const first_rhythm = this.symbols[0].rhythm;
    return first_rhythm.includes("barline") || first_rhythm.includes("repeat");
  }

  get_duration(): Fraction {
    const notes_rests = this.symbols
      .filter(
        (s) => s.rhythm.startsWith("note") || s.rhythm.startsWith("rest")
      )
      .map((s) => s.getDuration().fraction);
    if (notes_rests.length === 0) return new Fraction(0);
    return minFraction(notes_rests);
  }

  into_positions(): SymbolChord[] {
    const upper: EncodedSymbol[] = [];
    const lower: EncodedSymbol[] = [];
    let lower_is_only_rest = true;
    for (const symbol of this.symbols) {
      if (symbol.position === "upper") {
        upper.push(symbol);
      } else {
        lower.push(symbol);
        lower_is_only_rest =
          lower_is_only_rest && symbol.rhythm.startsWith("rest");
      }
    }
    let chords: SymbolChord[] = [
      new SymbolChord(upper, this.tuplet_mark),
      new SymbolChord(lower, this.tuplet_mark),
    ];
    if (lower_is_only_rest) {
      chords = [chords[1], chords[0]];
    }
    return chords.filter((chord) => chord.symbols.length > 0);
  }
}

function build_identification(): XmlElement {
  const ident = el("identification");
  const enc = el("encoding");
  enc.addChild(el("software", "homr"));
  ident.addChild(enc);
  return ident;
}

export function generate_xml(
  args: XmlGeneratorArguments,
  staffs: EncodedSymbol[][],
  title: string
): string {
  const root = el("score-partwise", null, { version: "4.0" });
  root.addChild(build_work(title));
  root.addChild(build_identification());
  root.addChild(build_defaults(args));
  const has_two_staves_by_part = staffs.map((staff) =>
    _voice_has_two_staves(staff)
  );
  root.addChild(build_part_list(has_two_staves_by_part));
  for (let index = 0; index < staffs.length; index++) {
    root.addChild(
      build_part(args, staffs[index], index, has_two_staves_by_part[index])
    );
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + root.toXml();
}

function _voice_has_two_staves(voice: EncodedSymbol[]): boolean {
  return voice.some((s) => s.position === "lower");
}

function build_part(
  args: XmlGeneratorArguments,
  voice: EncodedSymbol[],
  index: number,
  has_two_staves: boolean
): XmlElement {
  const part = el("part", null, { id: get_part_id(index) });
  const is_first_part = index === 0;
  const measures = build_measures(args, voice, is_first_part, has_two_staves);
  for (const measure of measures) {
    part.addChild(measure);
  }
  return part;
}

function build_measures(
  args: XmlGeneratorArguments,
  voice: EncodedSymbol[],
  is_first_part: boolean,
  has_two_staves: boolean = false
): XmlElement[] {
  function close_current_measure(): void {
    rebalance_measure_voices(current_measure);
    measures.push(current_measure);
  }

  let measure_number = 1;
  const groups = add_tuplet_start_stop(group_into_chords(voice));
  const [division, nominator] = find_division_and_time_signature_nominator(groups);
  const state = new ConversionState(division, nominator);
  const measures: XmlElement[] = [];
  let current_measure = el("measure", null, { number: String(measure_number) });
  const first_attributes = build_or_get_attributes(current_measure, null);
  first_attributes.addChild(build_divisions(division));
  if (has_two_staves) {
    first_attributes.addChild(el("staves", 2));
    first_attributes.addChild(el("part-symbol", "brace"));
  }
  if (is_first_part) {
    const direction = build_add_time_direction(args);
    if (direction) {
      current_measure.addChild(direction);
    }
  }
  let attributes: XmlElement | null = first_attributes;
  for (let group_no = 0; group_no < groups.length; group_no++) {
    const group = groups[group_no];
    const symbol = group.symbols[0];
    const rhythm = symbol.rhythm;
    const last_attributes = attributes;
    attributes = null;
    if (rhythm.startsWith("note") || rhythm.startsWith("rest")) {
      if (group.symbols.length === 1 && rhythm.endsWith("m")) {
        attributes = build_or_get_attributes(current_measure, last_attributes);
        build_multi_measure_rest(symbol, attributes);
      } else {
        const staff_positions = group.into_positions();
        for (let pos_no = 0; pos_no < staff_positions.length; pos_no++) {
          const staff_pos = staff_positions[pos_no];
          const chord_duration =
            pos_no === staff_positions.length - 1
              ? group.get_duration()
              : new Fraction(0);
          for (const note_xml of build_note_chord(staff_pos, state, chord_duration)) {
            current_measure.addChild(note_xml);
          }
        }
      }
      continue;
    }
    if (rhythm === "newline") {
      const is_last_measure = group_no === groups.length - 1;
      if (!is_last_measure) {
        current_measure.addChild(el("print", null, { "new-system": "yes" }));
      }
    } else if (rhythm.startsWith("clef")) {
      attributes = build_or_get_attributes(current_measure, last_attributes, true);
      for (const should_be_clef of group.symbols) {
        if (should_be_clef.rhythm.startsWith("clef")) {
          build_clef(should_be_clef, attributes);
        }
      }
    } else if (rhythm.startsWith("keySignature")) {
      attributes = build_or_get_attributes(current_measure, last_attributes);
      build_key(symbol, attributes);
    } else if (rhythm.startsWith("timeSignature")) {
      attributes = build_or_get_attributes(current_measure, last_attributes);
      build_time_signature(symbol, attributes, state);
    } else if (rhythm.includes("barline")) {
      if (rhythm !== "barline") {
        const barline = build_or_get_barline(current_measure, "right");
        build_barline_style(symbol, barline);
      }

      close_current_measure();
      measure_number += 1;
      current_measure = el("measure", null, { number: String(measure_number) });
    } else if (rhythm === "repeatStart") {
      close_current_measure();
      measure_number += 1;
      current_measure = el("measure", null, { number: String(measure_number) });

      const barline = build_or_get_barline(current_measure, "right");
      build_repeat(symbol, barline);
    } else if (rhythm === "repeatEnd") {
      const barline = build_or_get_barline(current_measure, "right");
      build_repeat(symbol, barline);

      close_current_measure();
      measure_number += 1;
      current_measure = el("measure", null, { number: String(measure_number) });
    } else if (rhythm === "repeatEndStart") {
      const barline = build_or_get_barline(current_measure, "right");
      build_repeat(new EncodedSymbol("repeatEnd"), barline);

      close_current_measure();
      measure_number += 1;
      current_measure = el("measure", null, { number: String(measure_number) });
      const barline2 = build_or_get_barline(current_measure, "right");
      build_repeat(new EncodedSymbol("repeatStart"), barline2);
    } else if (rhythm.startsWith("voltaStart")) {
      const volta_number = state.start_volta(measure_number);
      const barline = build_or_get_barline(current_measure, "left");
      build_barline_ending(symbol, barline, volta_number);
    } else if (
      rhythm.startsWith("voltaStop") ||
      rhythm.startsWith("voltaDiscontinue")
    ) {
      const volta_number = state.stop_volta(measure_number);
      const barline = build_or_get_barline(current_measure, "right");
      build_barline_ending(symbol, barline, volta_number);
    } else {
      eprint("Symbol isn't supported yet ", symbol);
    }
  }

  if (current_measure.getChildren().length > 0) {
    close_current_measure();
  }
  return measures;
}

function build_work(title_text: string): XmlElement {
  const work = el("work");
  const title = el("work-title", title_text);
  work.addChild(title);
  return work;
}

function build_defaults(args: XmlGeneratorArguments): XmlElement {
  if (!args.output_large_page) {
    return el("defaults");
  }
  const page_width = 110;
  const page_height_val = 300;
  const defaults = el("defaults");
  const page_layout = el("page-layout");
  page_layout.addChild(el("page-height", page_height_val));
  page_layout.addChild(el("page-width", page_width));
  defaults.addChild(page_layout);
  return defaults;
}

function get_part_id(index: number): string {
  return "P" + String(index + 1);
}

function _part_metadata(
  has_two_staves: boolean
): [string, string, string, number] {
  if (has_two_staves) {
    return ["Piano", "Piano", "keyboard.piano", 1];
  }
  return ["Voice", "Voice", "voice", 54];
}

function build_part_list(has_two_staves_by_part: boolean[]): XmlElement {
  const part_list = el("part-list");
  for (let part = 0; part < has_two_staves_by_part.length; part++) {
    const has_two_staves = has_two_staves_by_part[part];
    const part_id = get_part_id(part);
    const [part_name_str, instrument_name_str, instrument_sound_str, midi_program] =
      _part_metadata(has_two_staves);
    const score_part = el("score-part", null, { id: part_id });
    const part_name = el("part-name", part_name_str);
    score_part.addChild(part_name);
    const score_instrument = el("score-instrument", null, { id: part_id + "-I1" });
    const instrument_name = el("instrument-name", instrument_name_str);
    score_instrument.addChild(instrument_name);
    const instrument_sound = el("instrument-sound", instrument_sound_str);
    score_instrument.addChild(instrument_sound);
    score_part.addChild(score_instrument);
    const midi_instrument = el("midi-instrument", null, { id: part_id + "-I1" });
    midi_instrument.addChild(el("midi-channel", part + 1));
    midi_instrument.addChild(el("midi-program", midi_program));
    midi_instrument.addChild(el("volume", 100));
    midi_instrument.addChild(el("pan", 0));
    score_part.addChild(midi_instrument);
    part_list.addChild(score_part);
  }
  return part_list;
}

function build_or_get_attributes(
  measure: XmlElement,
  last_attributes: XmlElement | null,
  force_new: boolean = false
): XmlElement {
  if (last_attributes !== null && !force_new) {
    return last_attributes;
  }

  const attributes = el("attributes");
  measure.addChild(attributes);
  return attributes;
}

function build_or_get_barline(measure: XmlElement, location: string): XmlElement {
  const children = measure.getChildrenOfType("barline");
  for (const child of children) {
    if (child.attributes["location"] === location) {
      return child;
    }
  }

  const barline = el("barline", null, { location });
  measure.addChild(barline);
  return barline;
}

function build_key(model_key: EncodedSymbol, attributes: XmlElement): void {
  const key = el("key");
  const circle_of_fifth = model_key.rhythm.split("_")[1];
  const fifth = el("fifths", parseInt(circle_of_fifth));
  attributes.addChild(key);
  key.addChild(fifth);
}

function get_staff(symbol: EncodedSymbol): number {
  return symbol.position === "lower" ? 2 : 1;
}

function get_xml_voice(staff_num: number, rhythmic_layer: number): number {
  return (staff_num - 1) * 4 + rhythmic_layer + 1;
}

class TimedNoteEvent {
  staff_num: number;
  start: number;
  end: number;
  notes: XmlElement[];

  constructor(
    staff_num: number,
    start: number,
    end: number,
    notes: XmlElement[]
  ) {
    this.staff_num = staff_num;
    this.start = start;
    this.end = end;
    this.notes = notes;
  }
}

function rebalance_measure_voices(measure: XmlElement): void {
  const timed_events: TimedNoteEvent[] = [];
  let current_time = 0;
  let last_note_start = 0;
  for (const child of measure.getChildren()) {
    if (child.tagName === "backup") {
      const durations = child.getChildrenOfType("duration");
      if (durations.length > 0) {
        current_time -= parseInt(durations[0].value!);
      }
      continue;
    }
    if (child.tagName === "forward") {
      const durations = child.getChildrenOfType("duration");
      if (durations.length > 0) {
        current_time += parseInt(durations[0].value!);
      }
      continue;
    }
    if (child.tagName !== "note") {
      continue;
    }

    const duration_nodes = child.getChildrenOfType("duration");
    const duration =
      duration_nodes.length > 0 ? parseInt(duration_nodes[0].value!) : 0;
    const staff_nodes = child.getChildrenOfType("staff");
    const staff_num =
      staff_nodes.length > 0 ? parseInt(staff_nodes[0].value!) : 1;
    const is_chord_tone = child.getChildrenOfType("chord").length > 0;
    const start = is_chord_tone ? last_note_start : current_time;
    const end = start + duration;
    if (
      is_chord_tone &&
      timed_events.length > 0 &&
      timed_events[timed_events.length - 1].staff_num === staff_num &&
      timed_events[timed_events.length - 1].start === start &&
      timed_events[timed_events.length - 1].end === end
    ) {
      timed_events[timed_events.length - 1].notes.push(child);
    } else if (is_chord_tone) {
      timed_events.push(new TimedNoteEvent(staff_num, start, end, [child]));
    } else {
      last_note_start = start;
      current_time += duration;
      timed_events.push(new TimedNoteEvent(staff_num, start, end, [child]));
    }
  }

  const by_staff: Map<number, TimedNoteEvent[]> = new Map();
  for (const event of timed_events) {
    let arr = by_staff.get(event.staff_num);
    if (!arr) {
      arr = [];
      by_staff.set(event.staff_num, arr);
    }
    arr.push(event);
  }

  for (const [staff_num, events] of by_staff.entries()) {
    const sorted_events = [...events].sort(
      (a, b) => a.start - b.start || a.end - b.end
    );
    let active: { end: number; voice_no: number }[] = [];
    for (const event of sorted_events) {
      active = active.filter((a) => a.end > event.start);
      const used_voices = new Set(active.map((a) => a.voice_no));
      let voice_no = 1;
      while (used_voices.has(voice_no)) {
        voice_no += 1;
      }
      active.push({ end: event.end, voice_no });
      const xml_voice = String(get_xml_voice(staff_num, voice_no - 1));
      for (const note of event.notes) {
        const voice_nodes = note.getChildrenOfType("voice");
        if (voice_nodes.length > 0) {
          voice_nodes[0].value = xml_voice;
        }
      }
    }
  }
}

function build_clef(model_clef: EncodedSymbol, attributes: XmlElement): void {
  const sign_and_line = model_clef.rhythm.split("_")[1];
  const sign = sign_and_line[0];
  const line = sign_and_line[1];
  const clef = el("clef", null, { number: get_staff(model_clef) });
  attributes.addChild(clef);
  clef.addChild(el("sign", sign));
  clef.addChild(el("line", parseInt(line)));
}

function build_time_signature(
  model_time_signature: EncodedSymbol,
  attributes: XmlElement,
  state: ConversionState
): void {
  const time = el("time");

  const denominator = model_time_signature.rhythm.split("/")[1];
  attributes.addChild(time);
  const beats = Math.max(
    toInt(state.nominator.mul(parseInt(denominator))),
    1
  );
  time.addChild(el("beats", String(beats)));
  time.addChild(el("beat-type", denominator));
  state.beats = beats;
}

function build_barline_style(barline: EncodedSymbol, xml: XmlElement): void {
  const style_value =
    barline.rhythm === "bolddoublebarline" ? "heavy-heavy" : "light-light";
  const style = el("bar-style", style_value);
  xml.addChild(style);
}

function build_barline_ending(
  volta: EncodedSymbol,
  xml: XmlElement,
  volta_number: number
): void {
  let ending: XmlElement;
  if (volta.rhythm.startsWith("voltaStart")) {
    ending = el("ending", null, {
      type: "start",
      number: String(volta_number),
    });
  } else if (volta.rhythm.startsWith("voltaStop")) {
    ending = el("ending", null, {
      type: "stop",
      number: String(volta_number),
    });
  } else if (volta.rhythm.startsWith("voltaDiscontinue")) {
    ending = el("ending", null, {
      type: "discontinue",
      number: String(volta_number),
    });
  } else {
    throw new Error("Unknown ending " + String(volta));
  }
  xml.addChild(ending);
}

function build_repeat(barline: EncodedSymbol, xml: XmlElement): void {
  if (xml.getChildrenOfType("repeat").length > 0) {
    eprint("barline already has a repeat");
    return;
  }

  const repeat = el("repeat");
  const direction = barline.rhythm === "repeatStart" ? "forward" : "backward";
  repeat.attributes["direction"] = direction;
  xml.addChild(repeat);
}

const LIFT_TO_ALTER: Record<string, number> = {
  N: 0,
  "#": 1,
  "##": 2,
  b: -1,
  bb: -2,
};

const DURATION_NAMES: Record<number, string> = {
  0: "breve",
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "16th",
  32: "32nd",
  64: "64th",
  128: "128th",
};

function build_articulations(
  note: XmlElement,
  articualations: string,
  tuplet_mark: string,
  state: ConversionState
): void {
  const notation = el("notations");
  note.addChild(notation);

  const xml_articulations: XmlElement[] = [];
  const xml_ornaments: XmlElement[] = [];

  for (const articulation of articualations.split("_")) {
    if (articulation === "") {
      continue;
    } else if (articulation === nonote) {
      eprint("WARNING note without valid articulation", articualations);
    } else if (articulation === "fermata") {
      notation.addChild(el("fermata"));
    } else if (articulation === "arpeggiate") {
      notation.addChild(el("arpeggiate"));
    } else if (articulation === "accent") {
      xml_articulations.push(el("accent"));
    } else if (articulation === "arpeggiate") {
      notation.addChild(el("arpeggiate"));
    } else if (articulation === "fermata") {
      xml_articulations.push(el("fermata"));
    } else if (articulation === "staccato") {
      xml_articulations.push(el("staccato"));
    } else if (articulation === "staccatissimo") {
      xml_articulations.push(el("staccatissimo"));
    } else if (articulation === "tenuto") {
      xml_articulations.push(el("tenuto"));
    } else if (articulation === "tremolo") {
      xml_ornaments.push(
        el("tremolo", 3, { type: state.toggle_tremolo_state() })
      );
    } else if (articulation === "trill") {
      xml_ornaments.push(el("trill-mark"));
    } else if (articulation === "breathMark") {
      xml_articulations.push(el("breath-mark"));
    } else if (articulation === "turn") {
      xml_ornaments.push(el("inverted-turn"));
    } else if (articulation === "caesura") {
      xml_articulations.push(el("caesura"));
    } else if (articulation === "doit") {
      xml_articulations.push(el("doit"));
    } else if (articulation === "slurStart") {
      notation.addChild(el("slur", null, { type: "start" }));
    } else if (articulation === "slurStop") {
      notation.addChild(el("slur", null, { type: "stop" }));
    } else if (articulation === "tieStart") {
      notation.addChild(el("tied", null, { type: "start" }));
    } else if (articulation === "tieStop") {
      notation.addChild(el("tied", null, { type: "stop" }));
    } else {
      throw new Error("Unsupported articulation " + articulation);
    }
  }

  if (tuplet_mark !== "") {
    const tuplet_xml = el("tuplet", null, { type: tuplet_mark });
    notation.addChild(tuplet_xml);
  }

  if (xml_articulations.length > 0) {
    const parent = el("articulations");
    for (const child of xml_articulations) {
      parent.addChild(child);
    }
    notation.addChild(parent);
  }

  if (xml_ornaments.length > 0) {
    const parent = el("ornaments");
    for (const child of xml_ornaments) {
      parent.addChild(child);
    }
    notation.addChild(parent);
  }
}

function build_slurs(note: XmlElement, slurs: string, slur_number: number): void {
  const notations = note.getChildrenOfType("notations");
  let notation: XmlElement;
  if (notations.length > 0) {
    notation = notations[0];
  } else {
    notation = el("notations");
    note.addChild(notation);
  }

  if (slurs === "_" || slurs === "") {
    // pass
  } else if (slurs === nonote) {
    eprint("WARNING note without valid articulation", slurs);
  } else if (slurs === "slurStart") {
    notation.addChild(el("slur", null, { type: "start", number: slur_number }));
  } else if (slurs === "slurStop") {
    notation.addChild(el("slur", null, { type: "stop", number: slur_number }));
  } else if (slurs === "slurStart_slurStop") {
    notation.addChild(el("slur", null, { type: "stop", number: slur_number }));
    notation.addChild(el("slur", null, { type: "start", number: slur_number }));
  } else {
    throw new Error("Unsupported slur " + slurs);
  }
}

function build_note_or_rest(
  model_note: EncodedSymbol,
  rhythmic_layer: number,
  is_chord: boolean,
  state: ConversionState,
  tuplet_mark: string
): XmlElement {
  const note = el("note");
  if (is_chord) {
    note.addChild(el("chord"));
  }
  const model_pitch = model_note.pitch;
  const model_duration = model_note.getDuration();
  if (model_pitch === empty) {
    if (model_duration.fraction.numerator === 0) {
      note.addChild(el("rest", null, { measure: "yes" }));
    } else {
      note.addChild(el("rest"));
    }
  } else if (model_pitch === nonote) {
    eprint("WARNING note without pitch", model_note);
    note.addChild(el("rest"));
  } else {
    const pitch = el("pitch");
    pitch.addChild(el("step", model_pitch[0]));
    pitch.addChild(el("octave", parseInt(model_pitch[1])));
    if (model_note.lift === nonote) {
      eprint("WARNING note with invalid lift", model_note);
    } else if (model_note.lift !== empty) {
      pitch.addChild(el("alter", LIFT_TO_ALTER[model_note.lift]));
    }
    note.addChild(pitch);
  }

  if (model_note.rhythm.includes("G")) {
    note.addChild(el("grace"));
    const base_duration = model_duration.kern;
    const duration_name = DURATION_NAMES[base_duration];
    note.addChild(el("type", duration_name));
  } else if (model_duration.fraction.numerator > 0) {
    const base_duration = model_duration.kern === 0 ? 1 : model_duration.kern;
    const duration_name = DURATION_NAMES[base_duration];
    note.addChild(el("type", duration_name));
    note.addChild(
      el("duration", toInt(model_duration.fraction.mul(state.division)))
    );
  } else {
    const duration_name = DURATION_NAMES[0];
    note.addChild(el("type", duration_name));
    note.addChild(el("duration", state.beats));
  }

  const staff_num = get_staff(model_note);
  const slur_number = staff_num;
  note.addChild(el("staff", staff_num));
  note.addChild(el("voice", String(get_xml_voice(staff_num, rhythmic_layer))));
  for (let i = 0; i < model_duration.dots; i++) {
    note.addChild(el("dot"));
  }
  if (model_duration.actual_notes !== model_duration.normal_notes) {
    const time_modification = el("time-modification");
    time_modification.addChild(
      el("actual-notes", model_duration.actual_notes)
    );
    time_modification.addChild(
      el("normal-notes", model_duration.normal_notes)
    );
    note.addChild(time_modification);
    build_articulations(note, model_note.articulation, tuplet_mark, state);
    build_slurs(note, model_note.slur, slur_number);
  } else {
    build_articulations(note, model_note.articulation, "", state);
    build_slurs(note, model_note.slur, slur_number);
  }

  return note;
}

function build_multi_measure_rest(
  symbol: EncodedSymbol,
  attributes: XmlElement
): XmlElement | null {
  const other_styles = attributes.getChildrenOfType("measure-style");
  if (other_styles.length > 0) {
    eprint("Measure already has a multi rest");
    return null;
  }
  const duration = parseInt(
    symbol.rhythm.split("_")[1].replace("m", "")
  );
  const style = el("measure-style");
  const rest = el("multiple-rest", duration);
  style.addChild(rest);
  attributes.addChild(style);
  return style;
}

function build_note_chord(
  note_chord: SymbolChord,
  state: ConversionState,
  chord_duration: Fraction
): XmlElement[] {
  const by_duration = _group_notes(note_chord.symbols);
  const result: XmlElement[] = [];
  let final_duration = new Fraction(0);
  const sorted_durations = [...by_duration].sort((a, b) =>
    a.fraction.lt(b.fraction) ? -1 : a.fraction.gt(b.fraction) ? 1 : 0
  );
  for (let i = 0; i < sorted_durations.length; i++) {
    const group_duration = sorted_durations[i].fraction;
    let is_first = true;
    for (const note_loop of sorted_durations[i].notes) {
      const note = note_loop;
      result.push(
        build_note_or_rest(
          note,
          i,
          !is_first,
          state,
          note_chord.tuplet_mark
        )
      );
      is_first = false;
    }
    if (i !== sorted_durations.length - 1 && group_duration.gt(new Fraction(0))) {
      const backup = el("backup");
      backup.addChild(
        el("duration", toInt(group_duration.mul(state.division)))
      );
      result.push(backup);
    }

    final_duration = group_duration;
  }

  if (chord_duration.lt(final_duration)) {
    const backup = el("backup");
    backup.addChild(
      el(
        "duration",
        toInt(final_duration.sub(chord_duration).mul(state.division))
      )
    );
    result.push(backup);
  }
  return result;
}

function _group_notes(
  notes: EncodedSymbol[]
): { fraction: Fraction; notes: EncodedSymbol[] }[] {
  const groups: { fraction: Fraction; notes: EncodedSymbol[] }[] = [];
  let max_duration: Fraction = new Fraction(0);
  for (const n of notes) {
    const f = n.getDuration().fraction;
    if (f.gt(max_duration)) max_duration = f;
  }
  function getGroup(f: Fraction) {
    for (const g of groups) {
      if (g.fraction.eq(f)) return g;
    }
    const g = { fraction: f, notes: [] as EncodedSymbol[] };
    groups.push(g);
    return g;
  }
  for (const note of notes) {
    const duration = note.getDuration();
    const is_grace = note.rhythm.includes("G");
    let fraction: Fraction;
    if (is_grace) {
      fraction = new Fraction(0);
    } else if (duration.fraction.numerator === 0) {
      fraction = max_duration;
    } else {
      fraction = duration.fraction;
    }
    getGroup(fraction).notes.push(note);
  }
  return groups;
}

function build_add_time_direction(
  args: XmlGeneratorArguments
): XmlElement | null {
  if (!args.output_metronome) {
    return null;
  }
  const direction = el("direction");
  const direction_type = el("direction-type");
  direction.addChild(direction_type);
  const metronome = el("metronome");
  direction_type.addChild(metronome);
  const beat_unit = el("beat-unit", "quarter");
  metronome.addChild(beat_unit);
  const per_minute = el("per-minute", String(args.output_metronome));
  metronome.addChild(per_minute);
  if (args.output_tempo) {
    direction.addChild(el("sound", null, { tempo: args.output_tempo }));
  } else {
    direction.addChild(
      el("sound", null, { tempo: args.output_metronome })
    );
  }
  return direction;
}

function find_common_division(durations: Fraction[]): number {
  function lcm(a: number, b: number): number {
    return Math.abs(a * b) / Fraction.gcd(a, b);
  }

  const denominators = durations
    .filter((d) => d.gt(new Fraction(0)))
    .map((d) => d.denominator);
  if (denominators.length === 0) {
    return 1;
  }
  let common = denominators[0];
  for (let i = 1; i < denominators.length; i++) {
    common = lcm(common, denominators[i]);
  }
  return common;
}

function find_division_and_time_signature_nominator(
  voice: SymbolChord[]
): [number, Fraction] {
  const durations: Fraction[] = [new Fraction(1, 4)];
  let duration_in_measure = new Fraction(0);
  const measure_duration: Fraction[] = [];
  for (const chord of voice) {
    if (chord.is_barline() && duration_in_measure.gt(new Fraction(0))) {
      measure_duration.push(duration_in_measure);
      duration_in_measure = new Fraction(0);
    } else {
      const duration = chord.get_duration();
      if (duration.gt(new Fraction(0))) {
        durations.push(duration);
        duration_in_measure = duration_in_measure.add(duration);
      }
    }
  }

  if (duration_in_measure.gt(new Fraction(0))) {
    measure_duration.push(duration_in_measure);
    duration_in_measure = new Fraction(0);
  }

  if (measure_duration.length === 0) {
    return [find_common_division(durations), new Fraction(1)];
  }

  const sorted = [...measure_duration].sort((a, b) =>
    a.lt(b) ? -1 : a.gt(b) ? 1 : 0
  );
  const nominator = sorted[Math.floor(sorted.length / 2)];

  return [find_common_division(durations), nominator];
}

function group_into_chords(voice: EncodedSymbol[]): SymbolChord[] {
  return sortTokenChords(voice).map((s) => new SymbolChord(s));
}

class TupletParser {
  static parse(groups: SymbolChord[]): SymbolChord[] {
    for (const measure_groups of TupletParser.split_into_measures(groups)) {
      const saved_marks = measure_groups.map((group) => group.tuplet_mark);
      if (TupletParser.add_tuplets(measure_groups)) {
        continue;
      }
      for (let i = 0; i < measure_groups.length; i++) {
        measure_groups[i].tuplet_mark = saved_marks[i];
      }
    }
    return groups;
  }

  static get_tuplet_duration(group: SymbolChord): SymbolDuration | null {
    for (const symbol of group.symbols) {
      if (symbol.rhythm.startsWith("note") || symbol.rhythm.startsWith("rest")) {
        const duration = symbol.getDuration();
        if (duration.normal_notes !== duration.actual_notes) {
          return duration;
        }
      }
    }
    return null;
  }

  static split_into_measures(groups: SymbolChord[]): SymbolChord[][] {
    const measures: SymbolChord[][] = [];
    let current_measure: SymbolChord[] = [];
    for (const group of groups) {
      current_measure.push(group);
      if (group.is_barline()) {
        measures.push(current_measure);
        current_measure = [];
      }
    }
    if (current_measure.length > 0) {
      measures.push(current_measure);
    }
    return measures;
  }

  static add_tuplets(groups: SymbolChord[]): boolean {
    let cursor = 0;
    while (cursor < groups.length) {
      const duration = TupletParser.get_tuplet_duration(groups[cursor]);

      if (duration === null) {
        cursor += 1;
        continue;
      }

      const start = cursor;
      const tuplet_format = [duration.actual_notes, duration.normal_notes];
      const tuplet_size = duration.actual_notes;

      while (cursor - start < tuplet_size) {
        if (cursor >= groups.length) {
          return false;
        }
        const current_duration = TupletParser.get_tuplet_duration(groups[cursor]);
        if (current_duration === null) {
          return false;
        }
        const current_format = [
          current_duration.actual_notes,
          current_duration.normal_notes,
        ];
        if (
          current_format[0] !== tuplet_format[0] ||
          current_format[1] !== tuplet_format[1]
        ) {
          return false;
        }
        cursor += 1;
      }

      groups[start].tuplet_mark = "start";
      groups[cursor - 1].tuplet_mark = "stop";
    }

    return true;
  }
}

function add_tuplet_start_stop(groups: SymbolChord[]): SymbolChord[] {
  return TupletParser.parse(groups);
}

function build_divisions(division: number): XmlElement {
  return el("divisions", Math.floor(division / 4));
}
