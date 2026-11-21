export class Fraction {
  numerator: number;
  denominator: number;

  constructor(numerator: number, denominator: number = 1) {
    if (denominator === 0) throw new Error("Denominator cannot be zero");
    const g = Fraction.gcd(Math.abs(numerator), Math.abs(denominator));
    const sign = denominator < 0 ? -1 : 1;
    this.numerator = (sign * numerator) / g;
    this.denominator = Math.abs(denominator) / g;
  }

  static gcd(a: number, b: number): number {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      [a, b] = [b, a % b];
    }
    return a || 1;
  }

  add(other: Fraction): Fraction {
    return new Fraction(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator
    );
  }

  sub(other: Fraction): Fraction {
    return new Fraction(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator
    );
  }

  mul(other: Fraction | number): Fraction {
    if (typeof other === "number") return new Fraction(this.numerator * other, this.denominator);
    return new Fraction(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  div(other: Fraction | number): Fraction {
    if (typeof other === "number") return new Fraction(this.numerator, this.denominator * other);
    return new Fraction(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  lt(other: Fraction): boolean {
    return this.numerator * other.denominator < other.numerator * this.denominator;
  }

  gt(other: Fraction): boolean {
    return this.numerator * other.denominator > other.numerator * this.denominator;
  }

  eq(other: Fraction): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  isZero(): boolean {
    return this.numerator === 0;
  }

  static from(n: number, d: number = 1): Fraction {
    return new Fraction(n, d);
  }
}
