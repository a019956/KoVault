/** Short, sortable, collision-resistant id (time + randomness), ~16 chars. */
export function newId(): string {
  const t = Date.now().toString(36);
  const r = new Uint32Array(2);
  crypto.getRandomValues(r);
  return t + r[0].toString(36) + r[1].toString(36).slice(0, 4);
}
