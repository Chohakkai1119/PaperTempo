import { writeFileSync } from 'node:fs';

const bars = [
  ['C4', 'D4', 'E4', 'G4'],
  ['E4/2', 'D4', 'C4'],
  ['D4', 'E4', 'F4', 'A4'],
  ['G4/2', 'E4/2'],
  ['F4', 'E4', 'D4', 'E4'],
  ['C4/2', 'G4', 'R'],
  ['A4', 'G4', 'E4', 'D4'],
  ['E4', 'F4', 'G4/2'],
  ['E4', 'D4', 'C4/2'],
  ['G4', 'A4', 'G4', 'E4'],
  ['F4/2', 'E4', 'D4'],
  ['E4', 'E4', 'G4/2'],
  ['A4', 'G4', 'F4', 'E4'],
  ['D4/2', 'F4', 'R'],
  ['E4', 'G4', 'A4', 'C5'],
  ['B4', 'G4', 'E4/2'],
  ['F4', 'D4', 'E4', 'D4'],
  ['C4/4'],
];
const types = { 1: 'quarter', 2: 'half', 4: 'whole' };
const measures = bars.map((bar, index) => {
  const print = index === 9 ? '<print new-page="yes"/>' : index && index % 3 === 0 ? '<print new-system="yes"/>' : '';
  const attributes = index === 0
    ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction placement="above"><direction-type><words font-style="italic">Andante</words></direction-type><sound tempo="88"/></direction>'
    : '';
  const notes = bar.map((value, noteIndex) => {
    const [pitch, duration = '1'] = value.split('/');
    const content = pitch === 'R' ? '<rest/>' : `<pitch><step>${pitch[0]}</step><octave>${pitch[1]}</octave></pitch>`;
    return `<note id="sample-n${index + 1}-${noteIndex + 1}">${content}<duration>${duration}</duration><voice>1</voice><type>${types[duration]}</type></note>`;
  });
  const ending = index === bars.length - 1 ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '';
  return `  <measure number="${index + 1}">${print}${attributes}${notes.join('')}${ending}</measure>`;
});
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Morning Lines</work-title></work>
  <identification><creator type="composer">PaperTempo</creator></identification>
  <part-list><score-part id="P1"><part-name>Solo melody</part-name></score-part></part-list>
  <part id="P1">
${measures.join('\n')}
  </part>
</score-partwise>`;
writeFileSync(new URL('../dist/assets/morning-lines.musicxml', import.meta.url), xml);
