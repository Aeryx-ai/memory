const CODES = { usage: 1, notfound: 2, refused: 3, check: 4, sync: 5 };
export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    if (!(code in CODES)) throw new Error(`unknown error code ${code}`);
    this.code = code;
  }
}
export function exitCode(code) { return CODES[code] ?? 1; }
