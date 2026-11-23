/** node-postgres returns timestamp columns as JS Date objects. Repositories
 * reuse those values on upsert; stringifying a Date directly produces a
 * non-ISO string that Postgres rejects. Normalize at the repository boundary. */

export function reusedIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}
