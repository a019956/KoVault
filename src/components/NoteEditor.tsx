import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { NoteMeta } from '../data/types';
import { labelHue, timeAgo, useVault } from '../hooks';
import { normalizeLabel } from '../data/search';
import { SketchPad } from './SketchPad';

type Mode = 'write' | 'preview' | 'draw';

interface Props {
  meta: NoteMeta;
  onBack?: () => void;
  onOpenTitle: (title: string) => void;
  onLabel: (label: string) => void;
}

const SAVE_DELAY = 500;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Markdown → sanitized HTML, with Obsidian-style [[wiki links]]. */
export function renderMarkdown(src: string): string {
  const withLinks = src.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = escapeHtml(target.trim());
    return `<a href="#" class="wikilink" data-wiki="${t}">${escapeHtml((alias ?? target).trim())}</a>`;
  });
  const html = marked.parse(withLinks, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html);
}

export function NoteEditor({ meta, onBack, onOpenTitle, onLabel }: Props) {
  const vault = useVault();
  const [loaded, setLoaded] = useState(false);
  const [body, setBody] = useState('');
  const [sketch, setSketch] = useState('');
  const [title, setTitle] = useState(meta.title);
  const [mode, setMode] = useState<Mode>('write');
  const [menu, setMenu] = useState(false);

  // Pending local edits, flushed after a short pause and when the editor closes.
  const pending = useRef<{ body?: string; sketch?: string; title?: string }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = {};
    if (p.body === undefined && p.sketch === undefined && p.title === undefined) return;
    const content: { body?: string; sketch?: string } = {};
    if (p.body !== undefined) content.body = p.body;
    if (p.sketch !== undefined) content.sketch = p.sketch;
    await vault.updateNote(
      meta.id,
      p.title !== undefined ? { title: p.title.trim() || 'Untitled' } : {},
      Object.keys(content).length ? content : undefined,
    );
  }, [vault, meta.id]);

  const queue = useCallback(
    (patch: { body?: string; sketch?: string; title?: string }) => {
      Object.assign(pending.current, patch);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY);
    },
    [flush],
  );

  // Load content; reload if a sync brought in a newer version and there are no unsaved edits.
  const remoteVersion = vault.remoteApplied.get(meta.id) === meta.updatedAt ? meta.updatedAt : 0;
  useEffect(() => {
    if (Object.keys(pending.current).length) return;
    let alive = true;
    void vault.getContent(meta.id).then((c) => {
      if (!alive) return;
      setBody(c.body);
      setSketch(c.sketch);
      setTitle(vault.notes.get(meta.id)?.title ?? '');
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [vault, meta.id, remoteVersion]);

  useEffect(() => {
    const save = () => void flush();
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', save);
      void flush();
    };
  }, [flush]);

  const html = useMemo(() => (mode === 'preview' ? renderMarkdown(body) : ''), [mode, body]);
  const words = useMemo(() => (body.trim() ? body.trim().split(/\s+/).length : 0), [body]);

  const folders = vault.liveFolders();

  const remove = async () => {
    setMenu(false);
    if (!confirm(`Delete "${meta.title}"?`)) return;
    pending.current = {};
    await vault.deleteNote(meta.id);
  };

  return (
    <section className="editor">
      <header className="pane-head editor-head">
        {onBack && (
          <button className="icon-btn" aria-label="Back to list" onClick={onBack}>
            ←
          </button>
        )}
        <div className="tabs" role="tablist">
          {(['write', 'preview', 'draw'] as Mode[]).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {m === 'write' ? 'Write' : m === 'preview' ? 'Preview' : 'Draw'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className={`icon-btn ${meta.pinned ? 'on' : ''}`}
          aria-label={meta.pinned ? 'Unpin note' : 'Pin note'}
          title={meta.pinned ? 'Unpin' : 'Pin'}
          onClick={() => void vault.updateNote(meta.id, { pinned: !meta.pinned })}
        >
          📌
        </button>
        <div className="menu-wrap">
          <button className="icon-btn" aria-label="Note options" onClick={() => setMenu((m) => !m)}>
            ⋯
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(false)} />
              <div className="menu right" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    const blob = new Blob([`# ${meta.title}\n\n${body}`], { type: 'text/markdown' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${meta.title.replace(/[\\/:*?"<>|]/g, '_') || 'note'}.md`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                  }}
                >
                  Download as Markdown
                </button>
                <button role="menuitem" className="danger" onClick={remove}>
                  Delete note
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="editor-body">
        <input
          className="title-input"
          value={title}
          placeholder="Untitled"
          aria-label="Note title"
          onChange={(e) => {
            setTitle(e.target.value);
            queue({ title: e.target.value });
          }}
        />
        <div className="meta-row">
          <label className="folder-select">
            📁
            <select
              aria-label="Folder"
              value={meta.folderId ?? ''}
              onChange={(e) => void vault.updateNote(meta.id, { folderId: e.target.value || null })}
            >
              <option value="">Unfiled</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {vault.folderPath(f.id)}
                </option>
              ))}
            </select>
          </label>
          <LabelEditor
            labels={meta.labels}
            onChange={(labels) => void vault.updateNote(meta.id, { labels })}
            onOpen={onLabel}
          />
        </div>

        {!loaded ? null : mode === 'write' ? (
          <textarea
            className="body-input"
            value={body}
            placeholder={'Start writing… Markdown supported.\n\n- [ ] checklist item\n[[Another note]] links to a note'}
            aria-label="Note body"
            onChange={(e) => {
              setBody(e.target.value);
              queue({ body: e.target.value });
            }}
          />
        ) : mode === 'preview' ? (
          <article
            className="markdown"
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest('a');
              if (!a) return;
              if (a.dataset.wiki) {
                e.preventDefault();
                void flush().then(() => onOpenTitle(a.dataset.wiki!));
              } else {
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
              }
            }}
            dangerouslySetInnerHTML={{ __html: html || '<p class="hint">Nothing written yet.</p>' }}
          />
        ) : (
          <SketchPad
            data={sketch}
            onChange={(s) => {
              setSketch(s);
              queue({ sketch: s });
            }}
          />
        )}
      </div>
      <footer className="status-bar">
        <span>{words} words</span>
        {meta.hasSketch && <span>✏️ drawing</span>}
        <span>Edited {timeAgo(meta.updatedAt)}</span>
      </footer>
    </section>
  );
}

function LabelEditor({ labels, onChange, onOpen }: { labels: string[]; onChange: (l: string[]) => void; onOpen: (l: string) => void }) {
  const vault = useVault();
  const [text, setText] = useState('');
  const all = vault.labelCounts().map(([l]) => l);

  const add = (raw: string) => {
    const l = normalizeLabel(raw);
    setText('');
    if (l && !labels.includes(l)) onChange([...labels, l]);
  };

  return (
    <div className="label-editor">
      {labels.map((l) => (
        <span key={l} className="chip" style={{ ['--hue' as string]: labelHue(l) }}>
          <button className="chip-text" onClick={() => onOpen(l)}>
            #{l}
          </button>
          <button className="chip-x" aria-label={`Remove label ${l}`} onClick={() => onChange(labels.filter((x) => x !== l))}>
            ×
          </button>
        </span>
      ))}
      <input
        list="all-labels"
        value={text}
        placeholder="+ label"
        aria-label="Add label"
        onChange={(e) => {
          const v = e.target.value;
          if (/[,\s]$/.test(v)) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && labels.length) {
            onChange(labels.slice(0, -1));
          }
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id="all-labels">
        {all.filter((l) => !labels.includes(l)).map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </div>
  );
}
