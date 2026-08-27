// Fixture: console logging outside the logger module.
export function report(message: string): void {
  console.log(message);
  console.error(message);
  console.warn(message);
}
