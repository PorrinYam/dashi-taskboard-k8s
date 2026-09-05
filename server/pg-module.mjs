// Lazy loader for the `pg` driver: the packaged standalone App ships without a bundled
// PostgreSQL driver, so importing must happen only once DATABASE_URL mode actually runs.
// The returned module is normalized to the CJS default shape (`.Pool` / `.Client` at the
// top level) so callers never deal with ESM interop themselves.
let cached = null;

export async function loadPg() {
  if (!cached) {
    const imported = await import("pg");
    cached = imported.default ?? imported;
  }
  return cached;
}
