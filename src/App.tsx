import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Sidebar } from './components/Sidebar';
import { NoteList } from './components/NoteList';
import { NoteEditor } from './components/NoteEditor';
import { Tasks } from './components/Tasks';
import { useMediaQuery, useVault } from './hooks';

export type View =
  | { kind: 'notes'; folderId: string | null | 'all' }
  | { kind: 'label'; label: string }
  | { kind: 'search'; query: string }
  | { kind: 'tasks' };

export function App() {
  const vault = useVault();
  const narrow = useMediaQuery('(max-width: 820px)');
  const [view, setView] = useState<View>({ kind: 'notes', folderId: 'all' });
  const [noteId, setNoteId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Drop the selection if the note was deleted (locally or by a sync).
  const selected = noteId ? vault.notes.get(noteId) : undefined;
  useEffect(() => {
    if (noteId && (!selected || selected.deleted)) setNoteId(null);
  }, [noteId, selected]);

  // Android hardware back button: close editor → close drawer → leave the app.
  const nav = useRef({ noteId, drawerOpen, narrow });
  nav.current = { noteId, drawerOpen, narrow };
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const sub = CapApp.addListener('backButton', () => {
      const s = nav.current;
      if (s.drawerOpen) setDrawerOpen(false);
      else if (s.noteId && s.narrow) setNoteId(null);
      else void CapApp.exitApp();
    });
    return () => void sub.then((h) => h.remove());
  }, []);

  const go = useCallback((v: View) => {
    setView(v);
    setDrawerOpen(false);
    if (v.kind === 'tasks') setNoteId(null);
  }, []);

  const openNote = useCallback((id: string) => setNoteId(id), []);

  const newNote = useCallback(async () => {
    const folderId = view.kind === 'notes' && view.folderId !== 'all' ? view.folderId : null;
    const labels = view.kind === 'label' ? [view.label] : [];
    const n = await vault.createNote(folderId, 'Untitled', labels);
    setNoteId(n.id);
  }, [vault, view]);

  const openByTitle = useCallback(
    async (title: string) => {
      const existing = vault.findNoteByTitle(title);
      setNoteId(existing ? existing.id : (await vault.createNote(null, title)).id);
    },
    [vault],
  );

  // On phones only one pane is visible at a time.
  const showList = view.kind !== 'tasks' && (!narrow || !noteId);
  const showEditor = view.kind !== 'tasks' && (!narrow || !!noteId);

  return (
    <div className={`app ${narrow ? 'narrow' : ''}`}>
      {narrow && drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} />}
      <Sidebar view={view} onNavigate={go} open={!narrow || drawerOpen} />
      <main className="panes">
        {view.kind === 'tasks' && <Tasks onMenu={narrow ? () => setDrawerOpen(true) : undefined} />}
        {showList && (
          <NoteList
            view={view}
            selectedId={noteId}
            onSelect={openNote}
            onNew={newNote}
            onSearch={(q) => setView(q ? { kind: 'search', query: q } : { kind: 'notes', folderId: 'all' })}
            onMenu={narrow ? () => setDrawerOpen(true) : undefined}
          />
        )}
        {showEditor &&
          (selected && !selected.deleted ? (
            <NoteEditor
              key={selected.id}
              meta={selected}
              onBack={narrow ? () => setNoteId(null) : undefined}
              onOpenTitle={openByTitle}
              onLabel={(label) => go({ kind: 'label', label })}
            />
          ) : (
            <div className="empty-editor">
              <p>Select a note or create a new one.</p>
              <button className="primary" onClick={newNote}>
                New note
              </button>
            </div>
          ))}
      </main>
    </div>
  );
}
