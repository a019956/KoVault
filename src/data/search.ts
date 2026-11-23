export interface ParsedQuery {
  terms: string[];
  labels: string[];
}

/** `#label` tokens filter by label; everything else must appear in title or body. */
export function parseQuery(q: string): ParsedQuery {
  const terms: string[] = [];
  const labels: string[] = [];
  for (const raw of q.trim().toLowerCase().split(/\s+/)) {
    if (!raw) continue;
    if (raw.startsWith('#') && raw.length > 1) labels.push(raw.slice(1));
    else terms.push(raw);
  }
  return { terms, labels };
}

export interface MatchResult {
  score: number;
  snippet: string;
}

/** Returns null when the note does not match. Title hits score higher than body hits. */
export function matchNote(title: string, body: string, terms: string[]): MatchResult | null {
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  let firstBodyHit = -1;
  for (const term of terms) {
    const inTitle = t.includes(term);
    const bi = b.indexOf(term);
    if (!inTitle && bi < 0) return null;
    if (inTitle) score += 10;
    if (bi >= 0) {
      score += 1;
      if (firstBodyHit < 0 || bi < firstBodyHit) firstBodyHit = bi;
    }
  }
  return { score, snippet: makeSnippet(body, firstBodyHit) };
}

export function makeSnippet(body: string, at: number, radius = 60): string {
  if (!body) return '';
  const start = Math.max(0, at < 0 ? 0 : at - radius);
  const end = Math.min(body.length, (at < 0 ? 0 : at) + radius * 2);
  const s = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + (end < body.length ? '…' : '');
}

export function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '');
}
