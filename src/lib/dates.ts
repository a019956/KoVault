export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = fromISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Monday of the week containing the given date. */
export function weekStart(s: string): string {
  const d = fromISODate(s);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  return toISODate(d);
}

export function today(): string {
  return toISODate(new Date());
}

export function formatDay(s: string): string {
  return fromISODate(s).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function formatWeek(start: string): string {
  const a = fromISODate(start);
  const b = fromISODate(addDays(start, 6));
  const fmt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${a.toLocaleDateString(undefined, fmt)} – ${b.toLocaleDateString(undefined, fmt)}`;
}
