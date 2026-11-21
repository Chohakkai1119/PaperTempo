import { writeFileSync } from 'node:fs';

const output = new URL('../dist/assets/', import.meta.url);
const bars = [
  [['G4', 1], ['G4', 1], ['A4', 2], ['G4', 2]],
  [['C5', 2], ['B4', 4]],
  [['G4', 1], ['G4', 1], ['A4', 2], ['G4', 2]],
  [['D5', 2], ['C5', 4]],
  [['G4', 1], ['G4', 1], ['G5', 2], ['E5', 2]],
  [['C5', 2], ['B4', 2], ['A4', 2]],
  [['F5', 1], ['F5', 1], ['E5', 2], ['C5', 2]],
  [['D5', 2], ['C5', 4]],
];

const noteXML = (pitch, duration) => {
  const step = pitch[0];
  const octave = pitch.slice(1);
  const type = duration === 1 ? 'eighth' : duration === 2 ? 'quarter' : 'half';
  return `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>1</voice><type>${type}</type></note>`;
};

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Happy Birthday</work-title></work>
  <identification><creator type="arranger">PaperTempo</creator></identification>
  <part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>
  <part id="P1">
${bars.map((bar, index) => {
  const attributes = index === 0 ? '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : '';
  const print = index === 4 ? '<print new-system="yes"/>' : '';
  return `    <measure number="${index + 1}">${print}${attributes}${bar.map(([pitch, duration]) => noteXML(pitch, duration)).join('')}</measure>`;
}).join('\n')}
  </part>
</score-partwise>
`;
writeFileSync(new URL('happy-birthday.musicxml', output), xml);

const text = (x, y, size, value, font = 'F1') => `BT /${font} ${size} Tf ${x} ${y} Td (${value}) Tj ET\n`;
const line = (x1, y1, x2, y2, width = 0.8) => `${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
const noteY = (pitch, bottom) => {
  const midi = (Number(pitch.slice(1)) + 1) * 12 + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[pitch[0]];
  const e4 = 64;
  const steps = ({ C: -2, D: -1, E: 0, F: 1, G: 2, A: 3, B: 4 })[pitch[0]] + 7 * (Number(pitch.slice(1)) - 4);
  void midi;
  return bottom + steps * 5;
};
const ellipse = (x, y, filled) => {
  const rx = 5.2;
  const ry = 3.6;
  const k = 0.55228475;
  const path = `${x - rx} ${y} m ${x - rx} ${y + k * ry} ${x - k * rx} ${y + ry} ${x} ${y + ry} c ${x + k * rx} ${y + ry} ${x + rx} ${y + k * ry} ${x + rx} ${y} c ${x + rx} ${y - k * ry} ${x + k * rx} ${y - ry} ${x} ${y - ry} c ${x - k * rx} ${y - ry} ${x - rx} ${y - k * ry} ${x - rx} ${y} c ${filled ? 'f' : 'S'}\n`;
  return path;
};
const staff = (bottom, systemIndex) => {
  let content = '';
  for (let i = 0; i < 5; i++) content += line(68, bottom + i * 10, 552, bottom + i * 10, 0.65);
  content += text(72, bottom + 73, 17, systemIndex === 0 ? 'Happy Birthday' : 'Happy Birthday (continued)', 'F2');
  // A simple vector treble clef, centred on the G line.
  const x = 91;
  const y = bottom + 20;
  content += `2.1 w ${x} ${y - 18} m ${x + 2} ${y + 4} ${x - 7} ${y + 31} ${x + 1} ${y + 47} c ${x + 8} ${y + 58} ${x + 15} ${y + 45} ${x + 10} ${y + 37} c ${x + 6} ${y + 29} ${x - 1} ${y + 31} ${x - 4} ${y + 38} c ${x - 7} ${y + 48} ${x + 1} ${y + 60} ${x + 10} ${y + 54} c ${x + 25} ${y + 45} ${x + 10} ${y + 17} ${x + 5} ${y - 3} c ${x + 2} ${y - 15} ${x + 6} ${y - 25} ${x + 6} ${y - 25} c S\n`;
  content += text(112, bottom + 23, 11, '3');
  content += text(112, bottom + 9, 11, '4');
  for (let i = 0; i <= 4; i++) content += line(136 + i * 104, bottom, 136 + i * 104, bottom + 40, 0.8);
  return content;
};
const drawBar = (barIndex, bottom) => {
  const bar = bars[barIndex];
  const startX = 136 + (barIndex % 4) * 104;
  const slot = 13;
  let offset = 0;
  let content = '';
  for (const [pitch, duration] of bar) {
    const x = startX + 13 + (offset + duration / 2) * slot;
    const y = noteY(pitch, bottom);
    const type = duration === 1 ? 'eighth' : duration === 2 ? 'quarter' : 'half';
    const stemX = x + 4.5;
    content += ellipse(x, y, type !== 'half');
    content += line(stemX, y, stemX, y + 34, 1.05);
    if (type === 'eighth') content += `${stemX} ${y + 34} m ${stemX + 9} ${y + 28} ${stemX + 10} ${y + 22} ${stemX + 4} ${y + 19} c S\n`;
    offset += duration;
  }
  return content;
};

let content = '0 0 0 rg\n';
content += text(68, 730, 25, 'Happy Birthday', 'F2');
content += text(68, 708, 11, 'Melody in C major  |  3/4 time  |  Quarter note = 100');
content += staff(600, 0);
content += staff(386, 1);
for (let i = 0; i < bars.length; i++) content += drawBar(i, i < 4 ? 600 : 386);
content += text(68, 50, 9, 'Traditional melody  |  Arranged for a single melody instrument');

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf, 'ascii'));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf, 'ascii');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(new URL('happy-birthday.pdf', output), pdf, 'ascii');
