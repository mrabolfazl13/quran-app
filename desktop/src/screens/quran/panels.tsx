/**
 * In-page tafsir and note panels, mounted only when their disclosure is open.
 *
 * Both read and write through the gateway and nothing else, and both state the
 * absence of data honestly: an ayah with no tafsir row says so, an empty note is
 * refused rather than silently deleted, and a failed write is printed.
 */
import { useCallback, useState } from 'react';
import type { VerseKey } from '@quran/core';

import { useApp } from '../../app/app-state';
import type { Note } from '../../gateway/types';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, Chip, LinkButton, Spinner } from '../../ui/primitives';

/**
 * Typography only: does this stored string use the Arabic script block? It
 * decides the font column and `dir`, never the text itself.
 */
export function isArabicScript(text: string): boolean {
  return /\p{sc=Arabic}/u.test(text);
}

/**
 * The tafsir providers mark the word under explanation with inline HTML
 * (`<span class="green">…</span>`). React escapes it, so those tags would show
 * up as literal text in the middle of an Arabic paragraph. The markup carries no
 * meaning a reader needs, so it is dropped at the display boundary — the stored
 * row keeps exactly what was imported.
 */
function stripProviderMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([،؛:.!?])/g, '$1')
    .trim();
}

export function TafsirPanel({
  verseKey,
  titles,
}: {
  verseKey: VerseKey;
  titles: ReadonlyMap<string, string>;
}) {
  const { tr, gateway } = useApp();
  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    return gateway.tafsirFor(verseKey);
  }, [gateway, verseKey, tr]);

  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('تفسیری برای این آیه وارد نشده است', 'No tafsir has been imported for this ayah')}
      emptyBody={tr(
        'بستهٔ تفسیر را می‌توانید از بخش «سلامت داده» وارد کنید.',
        'Import a tafsir pack from the Data health screen.',
      )}
      emptyAction={
        <LinkButton to="/me/content" className="btn">
          {tr('سلامت داده', 'Data health')}
        </LinkButton>
      }
      isEmpty={(value) => value.length === 0}
      onRetry={() => state.refresh()}
      skeleton={<Spinner label={tr('خواندن تفسیر…', 'Reading tafsir…')} />}
    >
      {(passages) => (
        <div className="stack--tight tafr">
          {passages.map((passage, index) => (
            <article className="tafr__item" key={`${passage.packId}:${index}`}>
              <header className="row row--spread">
                <h4 className="tafr__title">{titles.get(passage.packId) ?? passage.packId}</h4>
                <span className="row">
                  {passage.coversVerseKeys.length > 1 ? (
                    <Chip tone="info" title={tr('این بند چند آیه را پوشش می‌دهد', 'This passage covers several ayat')}>
                      {`${passage.coversVerseKeys.length} ${tr('آیه', 'ayat')}`}
                    </Chip>
                  ) : null}
                  <span className="faint mono">{passage.packId}</span>
                </span>
              </header>
              <p
                className={`tafr__text ${isArabicScript(passage.text) ? 'arabic-inline' : 'persian'}`}
                dir={isArabicScript(passage.text) ? 'rtl' : undefined}
              >
                {stripProviderMarkup(passage.text)}
              </p>
            </article>
          ))}
        </div>
      )}
    </StateBoundary>
  );
}

export function NotePanel({ verseKey }: { verseKey: VerseKey }) {
  const { tr, gateway } = useApp();
  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    return gateway.notesFor(verseKey);
  }, [gateway, verseKey, tr]);

  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<Note | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    (next: Note[]) => {
      state.setValue(next);
    },
    [state],
  );

  const close = () => {
    setEditing(null);
    setDraft('');
  };

  async function save() {
    if (!gateway) return;
    const body = draft.trim();
    if (body === '') {
      setError(tr('یادداشت خالی ذخیره نمی‌شود.', 'An empty note is not saved.'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await gateway.saveNote({ id: editing?.id, verseKey, body });
      const previous = state.value ?? [];
      apply(previous.some((note) => note.id === saved.id) ? previous.map((n) => (n.id === saved.id ? saved : n)) : [...previous, saved]);
      close();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function remove(note: Note) {
    if (!gateway) return;
    setSaving(true);
    setError(null);
    try {
      await gateway.deleteNote(note.id);
      apply((state.value ?? []).filter((item) => item.id !== note.id));
      if (editing?.id === note.id) close();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const listId = `note-body-${verseKey.replace(':', '-')}`;

  return (
    <div className="stack--tight">
      <div className="row">
        <label className="field__label" htmlFor={listId}>
          {editing ? tr('ویرایش یادداشت', 'Edit note') : tr('یادداشت تازه', 'New note')}
        </label>
        {editing ? (
          <Button variant="ghost" onClick={close}>
            {tr('لغو', 'Cancel')}
          </Button>
        ) : null}
      </div>
      <textarea
        id={listId}
        className="textarea"
        rows={3}
        value={draft}
        placeholder={tr('یادداشت شما دربارهٔ این آیه', 'Your note about this ayah')}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="row">
        <Button variant="primary" busy={saving} onClick={() => void save()}>
          {editing ? tr('ذخیرهٔ تغییر', 'Save changes') : tr('ذخیرهٔ یادداشت', 'Save note')}
        </Button>
        {error ? <span className="field__error" role="alert">{error}</span> : null}
      </div>

      <StateBoundary
        state={state}
        emptyTitle={tr('یادداشتی برای این آیه نیست', 'This ayah has no notes yet')}
        isEmpty={(value) => value.length === 0}
        onRetry={() => state.refresh()}
        skeleton={<Spinner label={tr('خواندن یادداشت‌ها…', 'Reading notes…')} />}
      >
        {(notes) => (
          <ul className="list notelist">
            {notes.map((note) => (
              <li key={note.id} className="notelist__item">
                <span className="notelist__body persian" dir="rtl">
                  {note.body}
                </span>
                <span className="row notelist__tools">
                  <span className="faint mono">{note.updatedAt.slice(0, 16).replace('T', ' ')}</span>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(note);
                      setDraft(note.body);
                      setError(null);
                    }}
                  >
                    {tr('ویرایش', 'Edit')}
                  </Button>
                  <Button variant="danger" busy={saving} onClick={() => void remove(note)}>
                    {tr('حذف', 'Delete')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </StateBoundary>
    </div>
  );
}
