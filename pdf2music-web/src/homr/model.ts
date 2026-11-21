import * as constants from "./constants";
import {
  AngledBoundingBox,
  BoundingBox,
  BoundingEllipse,
  DebugDrawable,
  RotatedBoundingBox,
} from "./bounding_boxes";

export type NDArray = any;
export type Point = [number, number];
export type Color = [number, number, number];

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function diff(values: number[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] - values[i - 1]);
  }
  return result;
}

function argmin(values: number[]): number {
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < best) {
      best = values[i];
      idx = i;
    }
  }
  return idx;
}

class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class InputPredictions {
  original: NDArray;
  preprocessed: NDArray;
  notehead: NDArray;
  symbols: NDArray;
  staff: NDArray;
  stems_rest: NDArray;
  clefs_keys: NDArray;

  constructor(
    original: NDArray,
    preprocessed: NDArray,
    notehead: NDArray,
    symbols: NDArray,
    staff: NDArray,
    clefs_keys: NDArray,
    stems_rest: NDArray
  ) {
    this.original = original;
    this.preprocessed = preprocessed;
    this.notehead = notehead;
    this.symbols = symbols;
    this.staff = staff;
    this.stems_rest = stems_rest;
    this.clefs_keys = clefs_keys;
  }
}

export abstract class SymbolOnStaff extends DebugDrawable {
  center: Point;

  constructor(center: Point) {
    super();
    this.center = center;
  }

  copy(): any {
    return this;
  }

  transformCoordinates(
    transformation: (p: Point) => Point
  ): this {
    const copy = this.copy();
    copy.center = transformation(this.center);
    return copy;
  }
}

export class Accidental extends SymbolOnStaff {
  box: BoundingBox;
  position: number;

  constructor(box: BoundingBox, position: number) {
    super(box.center);
    this.box = box;
    this.position = position;
  }

  draw_onto_image(img: NDArray, color: Color = [255, 0, 0]): void {}

  toString(): string {
    return "Accidental(" + this.center.toString() + ")";
  }

  copy(): Accidental {
    return new Accidental(this.box, this.position);
  }
}

export class Rest extends SymbolOnStaff {
  box: BoundingBox;
  hasDot: boolean;

  constructor(box: BoundingBox) {
    super(box.center);
    this.box = box;
    this.hasDot = false;
  }

  draw_onto_image(img: NDArray, color: Color = [255, 0, 0]): void {}

  toString(): string {
    return "Rest(" + this.center.toString() + ")";
  }

  copy(): Rest {
    return new Rest(this.box);
  }
}

export enum StemDirection {
  UP = 1,
  DOWN = 2,
}

export enum NoteHeadType {
  HOLLOW = 1,
  SOLID = 2,
}

export const note_names: string[] = ["C", "D", "E", "F", "G", "A", "B"];

export function noteHeadTypeToString(t: NoteHeadType): string {
  if (t === NoteHeadType.HOLLOW) return "O";
  else if (t === NoteHeadType.SOLID) return "*";
  else throw new Error("Unknown NoteHeadType");
}

export class Note extends SymbolOnStaff {
  box: BoundingEllipse;
  position: number;
  hasDot: boolean;
  stem: RotatedBoundingBox | null;
  circleOfFifth: number;
  stemDirection: StemDirection | null;
  beams: RotatedBoundingBox[];
  flags: RotatedBoundingBox[];

  constructor(
    box: BoundingEllipse,
    position: number,
    stem: RotatedBoundingBox | null,
    stemDirection: StemDirection | null
  ) {
    super(box.center);
    this.box = box;
    this.position = position;
    this.hasDot = false;
    this.stem = stem;
    this.circleOfFifth = 0;
    this.stemDirection = stemDirection;
    this.beams = [];
    this.flags = [];
  }

  draw_onto_image(img: NDArray, color: Color = [255, 0, 0]): void {}

  toString(): string {
    return "Note(" + this.center.toString() + ", " + this.position.toString() + ")";
  }

  copy(): Note {
    return new Note(this.box, this.position, this.stem, this.stemDirection);
  }
}

export class BarLine extends SymbolOnStaff {
  box: RotatedBoundingBox;

  constructor(box: RotatedBoundingBox) {
    super(box.center);
    this.box = box;
  }

  draw_onto_image(img: NDArray, color: Color = [255, 0, 0]): void {}

  toString(): string {
    return "BarLine(" + this.center.toString() + ")";
  }

  copy(): BarLine {
    return new BarLine(this.box);
  }
}

export class Clef extends SymbolOnStaff {
  box: BoundingBox;

  constructor(box: BoundingBox) {
    super(box.center);
    this.box = box;
  }

  draw_onto_image(img: NDArray, color: Color = [255, 0, 0]): void {}

  toString(): string {
    return "Clef(" + this.center.toString() + ")";
  }

  copy(): Clef {
    return new Clef(this.box);
  }
}

export class StaffPoint {
  x: number;
  y: number[];
  angle: number;
  averageUnitSize: number;

  constructor(x: number, y: number[], angle: number) {
    if (y.length % constants.number_of_lines_on_a_staff !== 0) {
      throw new Error("A staff must consist of 5, 10, ... lines");
    }
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.averageUnitSize = mean(diff(y));
  }

  merge(other: StaffPoint): StaffPoint {
    if (Math.abs(this.x - other.x) > 1e-3) {
      throw new ValueError("Can't merge points at different positions");
    }
    const y: number[] = [];
    y.push(...this.y);
    y.push(...other.y);
    const angle = (this.angle + other.angle) / 2;
    return new StaffPoint(this.x, y.sort((a, b) => a - b), angle);
  }

  findPositionInUnitSizes(box: AngledBoundingBox): number {
    const center = box.center;
    const distances = this.y.map((yValue) => Math.abs(yValue - center[1]));
    const idxOfClosestY = argmin(distances);
    const distance = this.y[idxOfClosestY] - center[1];
    const distanceInUnitSizes = Math.round(
      (2 * distance) / this.averageUnitSize
    );
    const position =
      2 * (this.y.length - idxOfClosestY) + distanceInUnitSizes - 1;
    return position;
  }

  transformCoordinates(
    transformation: (p: Point) => Point
  ): StaffPoint {
    const xy = this.y.map((yValue) => transformation([this.x, yValue]));
    const averageX = mean(xy.map((p) => p[0]));
    return new StaffPoint(
      averageX,
      xy.map((p) => p[1]),
      this.angle
    );
  }

  toBoundingBox(): BoundingBox {
    return new BoundingBox(
      [
        Math.round(this.x),
        Math.round(this.y[0]),
        Math.round(this.x),
        Math.round(this.y[this.y.length - 1]),
      ],
      [],
      -2
    );
  }

  toString(): string {
    return "P(" + this.x.toString() + "," + this.y[2].toString() + ")";
  }
}

export class Staff extends DebugDrawable {
  grid: StaffPoint[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  averageUnitSize: number;
  symbols: SymbolOnStaff[];
  isGrandstaff: boolean;
  protected _yTolerance: number;

  constructor(grid: StaffPoint[]) {
    super();
    this.grid = grid;
    this.minX = grid[0].x;
    this.maxX = grid[grid.length - 1].x;
    this.minY = Math.min(...grid.map((p) => Math.min(...p.y)));
    this.maxY = Math.max(...grid.map((p) => Math.max(...p.y)));
    this.averageUnitSize = median(grid.map((p) => p.averageUnitSize));
    this.symbols = [];
    this.isGrandstaff = false;
    this._yTolerance =
      constants.max_number_of_ledger_lines * this.averageUnitSize;
  }

  isOnStaffZone(item: AngledBoundingBox): boolean {
    const point = this.getAt(item.center[0]);
    if (point === null) {
      return false;
    }
    if (
      item.center[1] > point.y[point.y.length - 1] + this._yTolerance ||
      item.center[1] < point.y[0] - this._yTolerance
    ) {
      return false;
    }
    return true;
  }

  merge(other: Staff): Staff {
    const gridA: Map<number, StaffPoint> = new Map();
    for (const p of this.grid) {
      gridA.set(Math.round(p.x), p);
    }
    const gridB: Map<number, StaffPoint> = new Map();
    for (const p of other.grid) {
      gridB.set(Math.round(p.x), p);
    }
    const xPositions: number[] = [];
    for (const key of gridA.keys()) {
      if (gridB.has(key)) xPositions.push(key);
    }
    xPositions.sort((a, b) => a - b);

    const grid = xPositions.map((x) => gridA.get(x)!.merge(gridB.get(x)!));
    const result = new Staff(grid);
    result.symbols.push(...this.symbols);
    result.symbols.push(...other.symbols);
    result.isGrandstaff = true;
    return result;
  }

  addSymbol(symbol: SymbolOnStaff): void {
    this.symbols.push(symbol);
  }

  getAt(x: number): StaffPoint | null {
    let closestPoint = this.grid[0];
    let bestDist = Math.abs(closestPoint.x - x);
    for (let i = 1; i < this.grid.length; i++) {
      const d = Math.abs(this.grid[i].x - x);
      if (d < bestDist) {
        bestDist = d;
        closestPoint = this.grid[i];
      }
    }
    if (Math.abs(closestPoint.x - x) > constants.staff_position_tolerance) {
      return null;
    }
    return closestPoint;
  }

  yDistanceTo(point: Point): number {
    const staffPoint = this.getAt(point[0]);
    if (staffPoint === null) {
      return 1e10;
    }
    return Math.min(...staffPoint.y.map((y) => Math.abs(y - point[1])));
  }

  draw_onto_image(img: NDArray, color: Color = [255, 0, 0]): void {}

  getBarLines(): BarLine[] {
    const result: BarLine[] = [];
    for (const symbol of this.symbols) {
      if (symbol instanceof BarLine) {
        result.push(symbol);
      }
    }
    return result;
  }

  getClefs(): Clef[] {
    const result: Clef[] = [];
    for (const symbol of this.symbols) {
      if (symbol instanceof Clef) {
        result.push(symbol);
      }
    }
    return result;
  }

  getNotes(): Note[] {
    const result: Note[] = [];
    for (const symbol of this.symbols) {
      if (symbol instanceof Note) {
        result.push(symbol);
      }
    }
    return result;
  }

  extendToXRange(minX: number, maxX: number): Staff {
    const grid = [...this.grid];

    if (minX >= 0 && minX < grid[0].x) {
      grid.unshift(new StaffPoint(minX, grid[0].y, grid[0].angle));
    }
    if (maxX >= 0 && maxX > grid[grid.length - 1].x) {
      grid.push(
        new StaffPoint(
          maxX,
          grid[grid.length - 1].y,
          grid[grid.length - 1].angle
        )
      );
    }

    return new Staff(grid);
  }

  getNumberOfNotes(): number {
    let result = 0;
    for (const symbol of this.symbols) {
      if (symbol instanceof Note) {
        result += 1;
      }
    }
    return result;
  }

  getAllExceptNotes(): SymbolOnStaff[] {
    const result: SymbolOnStaff[] = [];
    for (const symbol of this.symbols) {
      if (!(symbol instanceof Note)) {
        result.push(symbol);
      }
    }
    return result;
  }

  toString(): string {
    return "Staff(" + this.symbols.map((s) => s.toString()).join(", ") + ")";
  }

  copy(): Staff {
    return new Staff(this.grid);
  }

  transformCoordinates(
    transformation: (p: Point) => Point
  ): Staff {
    const copy = new Staff(
      this.grid.map((point) => point.transformCoordinates(transformation))
    );
    copy.symbols = this.symbols.map((symbol) =>
      symbol.transformCoordinates(transformation)
    );
    copy.isGrandstaff = this.isGrandstaff;
    return copy;
  }
}

export class GrandStaffPair {
  pairIndex: number[];
  score: number;

  constructor(pairIndex: number[], score: number) {
    this.pairIndex = pairIndex;
    this.score = score;
  }

  getScore(): number {
    return this.score;
  }

  getIndex(): number[] {
    return this.pairIndex;
  }

  toString(): string {
    return `staff pair: ${this.pairIndex} with score: ${this.score})`;
  }
}

export class MultiStaff extends DebugDrawable {
  staffs: Staff[];
  connections: RotatedBoundingBox[];

  constructor(staffs: Staff[], connections: RotatedBoundingBox[]) {
    super();
    this.staffs = [...staffs].sort((a, b) => a.minY - b.minY);
    this.connections = connections;
  }

  merge(other: MultiStaff): MultiStaff {
    const uniqueStaffs: Staff[] = [];
    const uniqueConnections: RotatedBoundingBox[] = [];
    for (const staff of [...this.staffs, ...other.staffs]) {
      if (!uniqueStaffs.includes(staff)) {
        uniqueStaffs.push(staff);
      }
    }
    for (const connection of [...this.connections, ...other.connections]) {
      if (!uniqueConnections.includes(connection)) {
        uniqueConnections.push(connection);
      }
    }
    return new MultiStaff(uniqueStaffs, uniqueConnections);
  }

  protected _scoreBraceWithStaffPair(
    symbol: RotatedBoundingBox,
    upperStaff: Staff,
    lowerStaff: Staff
  ): number {
    const unitSize = median([upperStaff.averageUnitSize, lowerStaff.averageUnitSize]);
    const xDistanceThreshold =
      constants.grandstaff_x_distance_threshold_factor * unitSize;
    const yOverlapThreshold =
      constants.grandstaff_y_overlap_threshold_factor * symbol.size[1];

    const symbolMinX = symbol.center[0];
    const staffMinX = Math.min(upperStaff.minX, lowerStaff.minX);
    const xDistance = Math.abs(staffMinX - symbolMinX);

    const symbolMinY = symbol.center[1] - symbol.size[1] / 2;
    const symbolMaxY = symbol.center[1] + symbol.size[1] / 2;
    const yOverlap =
      Math.min(symbolMaxY, lowerStaff.maxY) -
      Math.max(symbolMinY, upperStaff.minY);

    if (
      xDistance < xDistanceThreshold &&
      yOverlap > yOverlapThreshold &&
      yOverlap > xDistance
    ) {
      return yOverlap - xDistance;
    } else {
      return 0;
    }
  }

  protected _selectGrandstaffs(
    braceDot: RotatedBoundingBox[]
  ): GrandStaffPair[] {
    const pairScores: GrandStaffPair[] = [];
    for (let i = 0; i < this.staffs.length - 1; i++) {
      let bestScore = -Infinity;
      for (const symbol of braceDot) {
        const score = this._scoreBraceWithStaffPair(
          symbol,
          this.staffs[i],
          this.staffs[i + 1]
        );
        if (score > bestScore) {
          bestScore = score;
        }
      }
      if (bestScore > 0) {
        pairScores.push(new GrandStaffPair([i, i + 1], bestScore));
      }
    }

    const result: GrandStaffPair[] = [];
    const usedStaffIndex: Set<number> = new Set();
    const sortedPairs = [...pairScores].sort(
      (a, b) => b.getScore() - a.getScore()
    );
    for (const pair of sortedPairs) {
      if (pair.getIndex().some((index) => usedStaffIndex.has(index))) {
        continue;
      }

      result.push(pair);
      for (const index of pair.getIndex()) {
        usedStaffIndex.add(index);
      }
    }

    return result;
  }

  protected _mergeSelectedPairs(
    pairs: GrandStaffPair[]
  ): Staff[] {
    const result: Staff[] = [];
    let i = 0;
    while (i < this.staffs.length) {
      if (pairs.some((pair) => pair.getIndex().includes(i))) {
        result.push(this.staffs[i].merge(this.staffs[i + 1]));
        i += 2;
        continue;
      }
      result.push(this.staffs[i]);
      i += 1;
    }
    return result;
  }

  createGrandstaffs(braceDot: RotatedBoundingBox[]): MultiStaff {
    if (this.staffs.length < 2) {
      return this;
    }
    const pairs = this._selectGrandstaffs(braceDot);
    if (pairs.length === 0) {
      return this;
    }
    const mergedStaffs = this._mergeSelectedPairs(pairs);
    return new MultiStaff(mergedStaffs, this.connections);
  }

  breakApart(): MultiStaff[] {
    return this.staffs.map((staff) => new MultiStaff([staff], []));
  }

  draw_onto_image(img: NDArray, color: Color = [255, 0, 0]): void {
    for (const staff of this.staffs) {
      staff.draw_onto_image(img, color);
    }
    for (const connection of this.connections) {
      connection.draw_onto_image(img, color);
    }
  }
}
