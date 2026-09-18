export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[worker]", ...args);
}

export function logError(...args: unknown[]): void {
  console.error(new Date().toISOString(), "[worker]", ...args);
}
