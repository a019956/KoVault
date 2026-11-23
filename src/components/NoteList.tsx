import { useEffect, useState } from 'react';
import type { View } from '../App';
import type { SearchHit } from '../data/vault';
import type { NoteMeta } from '../data/types';
import { labelHue, timeAgo, useVault } from '../hooks';

interface Props {
  view: View;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSearch: (q: string) => void;
  onMenu?: () => void;
}

export function NoteList({ view, selectedId, onSelect, onNew, onSearch, onMenu }: Props) {
  const vault = useVault();
  const [query, setQuery] = useState(view.kind === 'search' ? view.query : '');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [sort, setSort] = useState<'updated' | 'title' | 'created'>('updated');

  useEffect(() => {
    if (view.kind !== 'search') setQuery('');
  }, [view]);

  // Debounced search; re-runs when the vault changes so results stay fresh.
  const version = vault.getVersion();
  useEffect(() => {
    if (view.kind !== 'search') {
      setHits(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void vault.search(view.query).then((h) => !cancelled && setHits(h));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [view, vault, version]);

  let title: string;
  let notes: NoteMeta[];
  if (view.kind === 'search') {
    title = 'Search';
    notes = (hits ?? []).map((h) => vault.notes.get(h.id)!).filter(Boolean);
  } else if (view.kind === 'label') {
    title = `#${view.label}`;
    notes = vault.liveNotes().filter((n) => n.labels.some((l) => l === view.label || l.startsWith(view.label + '/')));
  } else if (view.kind === 'notes' && view.folderId === 'all') {
    title = 'All notes';
    notes = vault.liveNotes();
  } else if (view.kind === 'notes') {
    title = view.folderId ? vault.folderPath(view.folderId) : 'Unfiled';
    notes = vault.liveNotes().filter((n) => n.folderId === view.folderId);
  } else {
    title = '';
    notes = [];
  }

  if (view.kind !== 'search') {
    const cmp: Record<typeof sort, (a: NoteMeta, b: NoteMeta) => number> = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      created: (a, b) => b.createdAt - a.createdAt,
      title: (a, b) => a.title.localeCompare(b.title),
    };
    notes = [...notes].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || cmp[sort](a, b));
  }
  const snippets = new Map((hits ?? []).map((h) => [h.id, h.snippet]));

  return (
    <section className="note-list">
      <header className="pane-head">
        {onMenu && (
          <button className="icon-btn" aria-label="Open menu" onClick={onMenu}>
            ☰
          </button>
        )}
        <h2 title={title}>{title}</h2>
        <button className="primary small" onClick={onNew} aria-label="New note">
          ＋ New
        </button>
      </header>
      <div className="search-row">
        <input
          type="search"
          placeholder="Search notes…  (#label to filter)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onSearch(e.target.value.trim());
          }}
        />
        {view.kind !== 'search' && (
          <select aria-label="Sort notes" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="updated">Recent</option>
            <option value="created">Created</option>
            <option value="title">A–Z</option>
          </select>
        )}
      </div>
      <ul className="notes">
        {notes.map((n) => (
          <li key={n.id}>
            <button className={`note-item ${n.id === selectedId ? 'active' : ''}`} onClick={() => onSelect(n.id)}>
              <div className="note-title">
                {n.pinned && <span title="Pinned">📌 </span>}
                {n.title || 'Untitled'}
                {n.hasSketch && <span className="badge" title="Has drawing">✏️</span>}
              </div>
              {snippets.get(n.id) && <div className="snippet">{snippets.get(n.id)}</div>}
              <div className="note-meta">
                <span>{timeAgo(n.updatedAt)}</span>
                {view.kind !== 'notes' || view.folderId === 'all' ? n.folderId && <span className="folder-tag">📁 {vault.folderPath(n.folderId)}</span> : null}
                {n.labels.slice(0, 3).map((l) => (
                  <span key={l} className="chip tiny" style={{ ['--hue' as string]: labelHue(l) }}>
                    #{l}
                  </span>
                ))}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {notes.length === 0 && (
        <p className="hint center">{view.kind === 'search' ? (hits ? 'No matching notes.' : 'Searching…') : 'No notes here yet.'}</p>
      )}
    </section>
  );
}
