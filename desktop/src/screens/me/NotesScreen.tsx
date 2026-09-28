/**
 * ME / notes — every note the reader wrote, grouped by the ayah it belongs to.
 *
 * The gateway exposes `recentNotes(limit)` and no "all notes" call, so the
 * screen asks for the 500 most recently touched notes and says so when that
 * window is full instead of pretending it is the whole set. Editing writes
 * through `saveNote` with the existing id (the same row, new `updatedAt`);
 * deleting needs the confirmation box because a note cannot be recovered.
 */
import { useCallback, useMemo, useState } from 'react';

import type { Note, VerseKey } from '@quran/core';

import { useApp } from '../../app/app-state';
import type { Tr } from '../../app/app-state';
import type { RouteDef } from '../../app/router';
import type { NoteInput } from '../../gateway/types';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, LinkButton, Panel } from '../../ui/primitives';
import { ConfirmBox, MeTabs, StatusLine, formatNumber, type Message } from './shared';
import './me.css';

const NOTE_WINDOW = 500;

interface Group {
  verseKey: VerseKey;
  notes: Note[];
  latest: string;
}

function groupByVerse(notes: Note[]): Group[] {
  const byKey = new Map<VerseKey, Note[]>();
  for (const note of notes) {
    const list = byKey.get(note.verseKey);
    if (list) list.push(note);
    else byKey.set(note.verseKey, [note]);
  }
  return [...byKey.entries()]
    .map(([verseKey, list]) => ({
      verseKey,
      notes: [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      latest: list.reduce((max, note) => (note.updatedAt > max ? note.updatedAt : max), list[0]?.updatedAt ?? ''),
    }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

/** `112:1` → the parts a Persian reader expects to see, no lookup needed. */
function verseLabel(tr: Tr, verseKey: string): string {
  const [chapter, verse] = verseKey.split(':');
  return tr(`سورة ${chapter ?? '؟'} · آیهٔ ${verse ?? '؟'}`, `Surah ${chapter ?? '?'} · ayah ${verse ?? '?'}`);
}

export function NotesScreen() {
  const { tr, gateway } = useApp();
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<{ id: string; verseKey: VerseKey; body: string } | null>(null);
  const [removing, setRemoving] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);

  const state = useAsync<Note[]>(
    async () => {
      if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
      return gateway.recentNotes(NOTE_WINDOW);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway],
  );

  const groups = useMemo(() => groupByVerse(state.value ?? []), [state.value]);

  const save = useCallback(
    async (input: NoteInput) => {
      if (!gateway) return;
      setBusy(true);
      try {
        const note = await gateway.saveNote(input);
        setMessage({
          kind: 'ok',
          text: tr(`یادداشت ${note.verseKey} ذخیره شد.`, `Note on ${note.verseKey} saved.`),
        });
        setEditing(null);
        state.refresh();
      } catch (cause) {
        setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        setBusy(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [gateway, state, tr],
  );

  const remove = useCallback(
    async (note: Note) => {
      if (!gateway) return;
      setBusy(true);
      try {
        await gateway.deleteNote(note.id);
        setMessage({ kind: 'info', text: tr('یادداشت حذف شد.', 'The note was deleted.') });
        setRemoving(null);
        state.refresh();
      } catch (cause) {
        setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        setBusy(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [gateway, state, tr],
  );

  return (
    <div className="stack">
      <MeTabs current="/me/notes" />
      <StateBoundary
        state={state}
        emptyTitle={tr('یادداشتی ندارید', 'There are no notes yet')}
        emptyBody={tr(
          'یادداشت‌ها را کنار خود آیة مورد نظر برمی‌دارید؛ اینجا همه‌شان را یک‌جا می‌بینید.',
          'Notes are taken beside an ayah; this screen gathers them in one place.',
        )}
        emptyAction={
          <LinkButton to="/quran" className="btn btn--primary">
            {tr('رفتن به قرآن', 'Go to the Quran')}
          </LinkButton>
        }
        isEmpty={(notes) => notes.length === 0}
        onRetry={() => state.refresh()}
        skeleton={<div className="state state--loading">{tr('خواندن یادداشت‌ها…', 'Reading notes…')}</div>}
      >
        {(notes) => (
          <div className="stack">
            <StatusLine message={message} />
            <div className="row row--spread">
              <span className="muted">
                {formatNumber(tr, notes.length)} {tr('یادداشت در', 'notes across')} {formatNumber(tr, groups.length)}{' '}
                {tr('آیه', 'ayat')}
              </span>
              {notes.length >= NOTE_WINDOW ? (
                <span className="field__error" role="alert">
                  {tr(
                    `فقط ${NOTE_WINDOW} یادداشتِ اخیر خوانده می‌شود — پایگاه بیش از این را نگه داشته است.`,
                    `Only the ${NOTE_WINDOW} most recent notes are read — the database holds more.`,
                  )}
                </span>
              ) : null}
            </div>

            {groups.map((group) => (
              <Panel
                key={group.verseKey}
                title={
                  <>
                    <LinkButton to={`/quran/ayah/${encodeURIComponent(group.verseKey)}`}>{group.verseKey}</LinkButton>{' '}
                    <span className="faint">{verseLabel(tr, group.verseKey)}</span>
                  </>
                }
                action={
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setEditing({ id: '', verseKey: group.verseKey, body: '' })
                    }
                  >
                    {tr('یادداشت تازه روی همین آیه', 'New note on this ayah')}
                  </Button>
                }
              >
                <ul className="notes">
                  {group.notes.map((note) => (
                    <li key={note.id} className="note">
                      <div className="note__head">
                        <span className="faint mono" dir="ltr">
                          {note.updatedAt.slice(0, 16).replace('T', ' ')}
                        </span>
                        <div className="row">
                          <Button
                            variant="ghost"
                            onClick={() => setEditing({ id: note.id, verseKey: note.verseKey, body: note.body })}
                          >
                            {tr('ویرایش', 'Edit')}
                          </Button>
                          <Button variant="danger" onClick={() => setRemoving(note)}>
                            {tr('حذف', 'Delete')}
                          </Button>
                        </div>
                      </div>
                      <p className="note__body">{note.body}</p>
                    </li>
                  ))}
                </ul>
              </Panel>
            ))}

            {editing ? (
              <Panel title={tr('ویرایش یادداشت', 'Editing a note')}>
                <div className="stack--tight">
                  <p className="muted">
                    <LinkButton to={`/quran/ayah/${encodeURIComponent(editing.verseKey)}`}>{editing.verseKey}</LinkButton>
                  </p>
                  <label className="field__label" htmlFor="note-editor">
                    {tr('متن یادداشت', 'Note text')}
                  </label>
                  <textarea
                    id="note-editor"
                    className="textarea"
                    dir="auto"
                    value={editing.body}
                    onChange={(event) => setEditing({ ...editing, body: event.target.value })}
                  />
                  <div className="row">
                    <Button
                      variant="primary"
                      busy={busy}
                      disabled={editing.body.trim().length === 0}
                      onClick={() => void save({ ...(editing.id ? { id: editing.id } : {}), verseKey: editing.verseKey, body: editing.body })}
                    >
                      {tr('ذخیره', 'Save')}
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(null)}>
                      {tr('بی‌خیال', 'Cancel')}
                    </Button>
                  </div>
                </div>
              </Panel>
            ) : null}

            {removing ? (
              <Panel title={tr('حذف یادداشت', 'Delete a note')}>
                <ConfirmBox
                  title={tr('حذف این یادداشت', 'Delete this note')}
                  consequences={[
                    tr(
                      `یادداشتِ آیهٔ ${removing.verseKey} برای همیشه پاک می‌شود؛ پشتیبان گرفتن تنها راه بازگرداندن آن است.`,
                      `The note on ayah ${removing.verseKey} is gone for good; only a backup can bring it back.`,
                    ),
                    `«${removing.body.slice(0, 120)}${removing.body.length > 120 ? '…' : ''}»`,
                  ]}
                  confirmLabel={tr('حذف کن', 'Delete it')}
                  busy={busy}
                  onConfirm={() => void remove(removing)}
                />
              </Panel>
            ) : null}
          </div>
        )}
      </StateBoundary>
    </div>
  );
}

export const routes: readonly RouteDef[] = [
  {
    path: '/me/notes',
    title: (t: Tr) => t('یادداشت‌ها', 'Notes'),
    section: 'me',
    component: NotesScreen,
  },
];
