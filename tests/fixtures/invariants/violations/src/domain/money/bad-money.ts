// Fixture: every domain-scoped rule is violated here, at known line numbers.
export function toMajor(minor: string): number {
  return parseFloat(minor) / 100;
}

export function render(value: number): string {
  return value.toFixed(2);
}

export function stamped(): Date {
  return new Date();
}

export function alsoBad(raw: string): number {
  return Number.parseFloat(raw);
}
