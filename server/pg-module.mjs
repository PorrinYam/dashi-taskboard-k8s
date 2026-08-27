// Lazy loader for the `pg` driver: the packaged standalone App ships without a bundled
// PostgreSQL driver, so importing must happen only once DATABASE_URL mode actually runs.
let cached = null;

export async function loadPg() {
  if (!cached) {
    cached = await import("pg");
  }
  return cached.default ?? cached;
}
