import { useState } from 'react';
import type { View } from '../App';
import type { Folder } from '../data/types';
import { labelHue, useVault } from '../hooks';
import { Account } from './Account';

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  open: boolean;
}

export function Sidebar({ view, onNavigate, open }: Props) {
  const vault = useVault();
  const folders = vault.liveFolders();
  const labels = vault.labelCounts();
  const notes = vault.liveNotes();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const counts = new Map<string | null, number>();
  for (const n of notes) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1);

  const children = (parentId: string | null) => folders.filter((f) => f.parentId === parentId);

  const addFolder = async (parentId: string | null) => {
    const name = prompt(parentId ? 'New subfolder name' : 'New folder name');
    if (!name?.trim()) return;
    const f = await vault.createFolder(name, parentId);
    if (parentId) setExpanded((s) => new Set(s).add(parentId));
    onNavigate({ kind: 'notes', folderId: f.id });
  };

  const isActive = (v: View) => JSON.stringify(v) === JSON.stringify(view);

  const renderFolder = (f: Folder, depth: number) => {
    const kids = children(f.id);
    const isOpen = expanded.has(f.id);
    const active = view.kind === 'notes' && view.folderId === f.id;
    return (
      <li key={f.id}>
        <div className={`nav-item folder ${active ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          <button
            className="twisty"
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            style={{ visibility: kids.length ? 'visible' : 'hidden' }}
            onClick={() =>
              setExpanded((s) => {
                const n = new Set(s);
                if (n.has(f.id)) n.delete(f.id);
                else n.add(f.id);
                return n;
              })
            }
          >
            {isOpen ? '▾' : '▸'}
          </button>
          <button className="nav-label" onClick={() => onNavigate({ kind: 'notes', folderId: f.id })}>
            <span className="icon">📁</span>
            <span className="name">{f.name}</span>
            <span className="count">{counts.get(f.id) ?? ''}</span>
          </button>
          <FolderMenu folder={f} onAddChild={() => addFolder(f.id)} onDeleted={() => onNavigate({ kind: 'notes', folderId: 'all' })} />
        </div>
        {isOpen && kids.length > 0 && <ul>{kids.map((k) => renderFolder(k, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand">
        <img src="./icon.svg" alt="" width={26} height={26} />
        <span>KoVault</span>
      </div>
      <Account />
      <nav>
        <button className={`nav-item ${isActive({ kind: 'notes', folderId: 'all' }) ? 'active' : ''}`} onClick={() => onNavigate({ kind: 'notes', folderId: 'all' })}>
          <span className="icon">🗂️</span>
          <span className="name">All notes</span>
          <span className="count">{notes.length}</span>
        </button>
        <button className={`nav-item ${view.kind === 'tasks' ? 'active' : ''}`} onClick={() => onNavigate({ kind: 'tasks' })}>
          <span className="icon">✅</span>
          <span className="name">Tasks</span>
        </button>

        <div className="section-head">
          <span>Folders</span>
          <button className="icon-btn" title="New folder" aria-label="New folder" onClick={() => addFolder(null)}>
            ＋
          </button>
        </div>
        <ul className="tree">
          <li>
            <div className={`nav-item folder ${isActive({ kind: 'notes', folderId: null }) ? 'active' : ''}`} style={{ paddingLeft: 8 }}>
              <span className="twisty" />
              <button className="nav-label" onClick={() => onNavigate({ kind: 'notes', folderId: null })}>
                <span className="icon">📥</span>
                <span className="name">Unfiled</span>
                <span className="count">{counts.get(null) ?? ''}</span>
              </button>
            </div>
          </li>
          {children(null).map((f) => renderFolder(f, 0))}
        </ul>

        <div className="section-head">
          <span>Labels</span>
        </div>
        {labels.length === 0 && <p className="hint">Add labels to a note to see them here.</p>}
        <div className="label-cloud">
          {labels.map(([l, c]) => (
            <button
              key={l}
              className={`chip ${view.kind === 'label' && view.label === l ? 'active' : ''}`}
              style={{ ['--hue' as string]: labelHue(l) }}
              onClick={() => onNavigate({ kind: 'label', label: l })}
            >
              #{l} <span className="count">{c}</span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  );
}

function FolderMenu({ folder, onAddChild, onDeleted }: { folder: Folder; onAddChild: () => void; onDeleted: () => void }) {
  const vault = useVault();
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className="icon-btn" aria-label={`Folder options for ${folder.name}`} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAddChild();
              }}
            >
              New subfolder
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                const name = prompt('Rename folder', folder.name);
                if (name) void vault.renameFolder(folder.id, name);
              }}
            >
              Rename
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setOpen(false);
                if (confirm(`Delete folder "${folder.name}" and its subfolders? Notes inside are kept and moved up one level.`)) {
                  void vault.deleteFolder(folder.id).then(onDeleted);
                }
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
