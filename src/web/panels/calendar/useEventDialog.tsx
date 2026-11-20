import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CALENDAR_CONFLICT_MESSAGE, eventIdFromBytes, type CalendarEvent, type CalendarEventDetail, type CalendarEventInput, type CalendarWindow, type EditScope } from '../../../shared/calendar.js';
import { ApiError } from '../../api.js';
import { useMe } from '../../shell/useMe.js';
import { EventDetail, ScopeChoice } from './EventDetail.js';
import { EventForm } from './EventForm.js';
import { createdDiffers, createMayHaveLanded, eventValues, newEventValues, updateBody, type FormMode } from './eventFormValues.js';
import { cachedEventNote } from './format.js';
import { Modal } from './Modal.js';
import { useCalendarEvent, useCalendarMutations, type CalendarAction } from './queries.js';

/** What the dialog shows, besides an event's detail (which the open id shows) and a new event. */
type Step =
  | null
  | { kind: 'scope'; action: 'edit' | 'delete' }
  | { kind: 'edit'; scope: EditScope };

/**
 * A change to the dialog's part of the query string. `event` is the open event, under whatever
 * key the page uses for it (`event` on the drill-down, `calendarEvent` on the home card); `new` is
 * New event's dialog. A key left out stays as it is; a key set to undefined is removed.
 */
export type DialogSearch = { event?: string | undefined; new?: 1 | undefined };

interface DialogOptions {
  /** The event open in the dialog, from the page's query string. */
  openId: string | null;
  /** Changes the dialog's keys in the page's query string (see `DialogSearch`). */
  navigate: (next: DialogSearch, opts?: { replace?: boolean }) => void;
  /** The page's window: whether events can be changed, and the events it fetched, for the read-only fallback (R5-M12). */
  window: CalendarWindow | undefined;
  /** Today in the family time zone, as the window says it. */
  today: string;
  /** Where focus goes when the button that opened the event is gone, or after a delete or an "All events" save. */
  fallbackFocus: () => HTMLElement | null;
  /** The button for an event opened by a link, if the page shows one, so focus can go back to it. */
  openerFor?: (id: string) => HTMLElement | null;
  /** The page's status line: "Saved X.", "Deleted X.", or '' to clear it. */
  onStatus: (text: string) => void;
}

/** New event, which only the drill-down offers: whether its dialog is open (`?new=1`), and its first day. */
type CreateOptions =
  | { createOpen: boolean; newEventDate: (today: string) => string }
  | { createOpen?: false; newEventDate?: undefined };

export type EventDialogOptions = DialogOptions & CreateOptions;

export interface EventDialog {
  /** Opens an event from its button, which focus goes back to on close. */
  openEvent: (event: CalendarEvent, from: HTMLElement) => void;
  /** Opens New event (the drill-down's button). Does nothing on a page without `newEventDate`. */
  startCreate: (from: HTMLElement | null) => void;
  /** The calendar is linked and writable, so events can be added and changed. */
  canChange: boolean;
  /** The dialog, or null while nothing is open. The page renders it. */
  dialog: ReactNode;
}

function newEventId(): string {
  return eventIdFromBytes(crypto.getRandomValues(new Uint8Array(16)));
}

const ERROR_PREFIX: Record<CalendarAction, string> = { create: "Couldn't add the event. ", update: "Couldn't save the event. ", delete: "Couldn't delete the event. " };
const CREATE_UNFINISHED = "Saving didn't finish. Press Save to try again.";
const CREATE_READ_BACK = 'This event was already saved by an earlier try, and this is how Google Calendar has it, which differs from the form. Edit it if anything needs changing.';
const CONFLICT_NOT_LOADED = "Couldn't load the latest version. Try again.";

/**
 * The event dialog, shared by the drill-down and the home card so they can't drift: an event's
 * detail, Edit and Delete, "This event" or "All events" for a repeating one, the form with its
 * repeat editor, conflicts, and (for the drill-down) New event. The page keeps the open event in
 * its query string and renders `dialog`.
 *
 * History (R5-I3): opening an event or New event adds a history entry, so Back closes the dialog.
 * Closing it goes back over the entry this page added; a dialog opened by a link (a deep link to
 * the event or to `?new=1`) is closed by replacing its entry instead. New event's draft, and the
 * id the browser chose for it (I1), last while its dialog is open.
 *
 * From the detail an event can be edited or deleted, and a repeating one asks "This event" or
 * "All events" first. A series opened by its own id (a link to it) offers only "All events", and
 * says so before deleting (M-5). Saving with an etag that's gone stale (spec §9.6) reloads the
 * event into the form with "This event changed. Review and save again.", once the latest version
 * has loaded (R5-M1); nothing else reloads an open form (M-1). Cancel or Escape with unsaved
 * changes asks first (R5-M5). When Google can't be reached or the link needs reconnecting, an
 * event opens as the page's window last fetched it, read-only, with a note (R5-M12). When the
 * calendar is read-only (spec §9.2), nothing offers to change it.
 *
 * Focus goes back to the button that opened the dialog. After a delete or an "All events" save
 * (which can give the series' events new ids, R5-M10), or when that button is gone, it goes to
 * `fallbackFocus`. Every change refreshes every calendar query (`useCalendarMutations`).
 */
export function useEventDialog({ openId, createOpen = false, navigate, window: win, today, fallbackFocus, openerFor, onStatus, newEventDate }: EventDialogOptions): EventDialog {
  const me = useMe().data!;
  const router = useRouter();
  const detail = useCalendarEvent(openId);
  const [stepState, setStep] = useState<Step>(null);
  // New event's draft (R5-I3): its id and first day, chosen when the dialog opens.
  const [draft, setDraft] = useState<{ id: string; date: string } | null>(null);
  // A create whose answer was lost: the form is locked until Save sends it again (R5-M14).
  const [createLock, setCreateLock] = useState<string | null>(null);
  // What the edit form was opened with (M-1): its etags go with the save, and only a conflict replaces it.
  const [editBase, setEditBase] = useState<CalendarEventDetail | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [detailNotice, setDetailNotice] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // The last event open, for `openerFor` once the dialog has closed.
  const lastOpenId = useRef<string | null>(openId);
  const dialogHeading = useRef<string | null>(null);
  // This page added the open dialog's history entry, so closing goes back over it (R5-I3).
  const pushedDialog = useRef(false);
  const formDirty = useRef(false);
  const onFormChange = useCallback((changed: boolean) => {
    formDirty.current = changed;
  }, []);

  const { create, update, remove } = useCalendarMutations({
    onError: (action, err) => {
      if (action === 'create' && err instanceof ApiError && createMayHaveLanded(err.status, err.code)) {
        // It may have been saved: a retry has to send exactly this event again (R5-M14).
        setCreateLock(CREATE_UNFINISHED);
        setError(ERROR_PREFIX.create + err.message);
        return;
      }
      // Only an etag conflict reloads the event. A create's id already taken, or the link changing
      // during the call, is a 409 too, and is shown as it says.
      if (err instanceof ApiError && err.code === 'conflict' && err.message === CALENDAR_CONFLICT_MESSAGE && action !== 'create') {
        // Spec §9.6: load the event again, and say why. Only a version that loaded replaces the form (R5-M1).
        setError(null);
        void detail.refetch().then((r) => {
          if (r.isError || !r.data) {
            setConflict(false);
            setError(CONFLICT_NOT_LOADED);
            return;
          }
          setConflict(true);
          if (action === 'delete') setError(CALENDAR_CONFLICT_MESSAGE);
          if (action !== 'update') return;
          setEditBase(r.data);
          setFormVersion((n) => n + 1);
        });
        return;
      }
      setError(ERROR_PREFIX[action] + err.message);
    },
  });

  function reset() {
    setStep(null);
    setEditBase(null);
    setError(null);
    setConflict(false);
    setDetailNotice(null);
    formDirty.current = false;
  }

  /** Leaves the dialog's history entry: back over it if this page added it, else replacing it. */
  function leaveDialog() {
    if (pushedDialog.current) {
      pushedDialog.current = false;
      router.history.back();
      return;
    }
    navigate({ event: undefined, new: undefined }, { replace: true });
  }

  useEffect(() => {
    if (openId) lastOpenId.current = openId;
  }, [openId]);

  // Back (or anything else) closed the dialog: nothing it showed carries over (R5-I3).
  const wasOpen = useRef(openId !== null || createOpen);
  useEffect(() => {
    const open = openId !== null || createOpen;
    if (wasOpen.current && !open) {
      pushedDialog.current = false;
      setStep(null);
      setEditBase(null);
      setError(null);
      setConflict(false);
      setDetailNotice(null);
      formDirty.current = false;
    }
    if (!createOpen) {
      setDraft(null);
      setCreateLock(null);
    }
    wasOpen.current = open;
  }, [openId, createOpen]);

  function openEvent(event: CalendarEvent, from: HTMLElement) {
    opener.current = from;
    reset();
    onStatus('');
    pushedDialog.current = true;
    navigate({ event: event.id, new: undefined });
  }

  function startCreate(from: HTMLElement | null) {
    if (!newEventDate) return;
    opener.current = from;
    reset();
    onStatus('');
    setDraft({ id: newEventId(), date: newEventDate(today) });
    setCreateLock(null);
    pushedDialog.current = true;
    navigate({ new: 1, event: undefined });
  }

  /** Cancel and Escape with unsaved changes ask first (R5-M5). */
  function discardOk(): boolean {
    return !formDirty.current || window.confirm('Discard your changes?');
  }

  function close() {
    const formOpen = stepState?.kind === 'edit' || createOpen;
    if (formOpen && !discardOk()) return;
    reset();
    if (openId || createOpen) leaveDialog();
  }

  // Focus follows the dialog's content: each step's heading once it's on screen. A form's title
  // field takes focus itself.
  const stepKey = createOpen
    ? 'create'
    : stepState?.kind ?? (openId ? `detail:${detail.data ? 'ready' : detail.error ? 'error' : 'loading'}` : 'none');
  useEffect(() => {
    if (stepKey === 'none' || stepKey === dialogHeading.current) return;
    dialogHeading.current = stepKey;
    if (stepKey !== 'edit' && stepKey !== 'create') document.querySelector<HTMLElement>('.calendar-dialog h3')?.focus();
  }, [stepKey]);
  useEffect(() => {
    if (stepKey === 'none') dialogHeading.current = null;
  }, [stepKey]);

  const data = win;
  const canChange = data?.freshness.connected === true && data.freshness.readOnly === null;
  // An event deleted in Google meanwhile is a 404; the detail that was loaded before isn't shown then.
  const gone = detail.error instanceof ApiError && detail.error.status === 404;
  const d = gone ? undefined : detail.data;
  // Google out of reach, or the link needing a reconnect: the event as the window last fetched it (R5-M12).
  const unavailable = detail.error instanceof ApiError && detail.error.status === 503;
  const cached = !d && unavailable ? data?.events.find((ev) => ev.id === openId) : undefined;

  // Opened by the series' own id: "This event" would mean the whole series, so only "All events" is offered.
  const isSeries = d !== undefined && d.event.seriesId === d.event.id;

  // `?new=1` from a link or a reload: a draft once events can be added, or no dialog if they can't.
  useEffect(() => {
    if (!createOpen || !newEventDate || draft || !data) return;
    if (canChange) setDraft({ id: newEventId(), date: newEventDate(data.today) });
    else navigate({ new: undefined }, { replace: true });
  });

  function beginEdit(scope: EditScope) {
    if (!d) return;
    setEditBase(d);
    setFormVersion((n) => n + 1);
    setStep({ kind: 'edit', scope });
  }

  function startEdit() {
    if (!d) return;
    setError(null);
    setConflict(false);
    setDetailNotice(null);
    if (isSeries) beginEdit('all');
    else if (d.event.seriesId) setStep({ kind: 'scope', action: 'edit' });
    else beginEdit('this');
  }

  function startDelete() {
    if (!d) return;
    setError(null);
    if (isSeries) {
      if (!window.confirm(`Delete every "${d.event.title}" event? The whole series is deleted from Google Calendar.`)) return;
      doDelete('all');
      return;
    }
    if (d.event.seriesId) {
      setStep({ kind: 'scope', action: 'delete' });
      return;
    }
    if (!window.confirm(`Delete "${d.event.title}"? It's deleted from Google Calendar.`)) return;
    doDelete('this');
  }

  function doDelete(scope: EditScope) {
    if (!d) return;
    const title = d.event.title;
    remove.mutate({ id: d.event.id, scope, etag: d.event.etag, seriesEtag: scope === 'all' ? d.series?.etag : undefined }, {
      onSuccess: () => {
        reset();
        opener.current = fallbackFocus();
        leaveDialog();
        onStatus(`Deleted ${title}.`);
      },
    });
  }

  function save(input: CalendarEventInput) {
    setError(null);
    if (createOpen && draft) {
      const retried = createLock !== null;
      create.mutate({ ...input, id: draft.id }, {
        onSuccess: (event) => {
          setCreateLock(null);
          if (retried && createdDiffers(input, event)) {
            // The first try was saved, and it isn't what's on screen now: show it, and say so (R5-M14).
            reset();
            setDetailNotice(CREATE_READ_BACK);
            navigate({ new: undefined, event: event.id }, { replace: true });
            return;
          }
          reset();
          leaveDialog();
          onStatus(`Added ${event.title}.`);
        },
      });
      return;
    }
    const base = editBase;
    if (!base || stepState?.kind !== 'edit') return;
    const scope = stepState.scope;
    update.mutate({ id: base.event.id, body: updateBody(input, scope, base.event, base.series) }, {
      onSuccess: () => {
        onStatus(`Saved ${input.title}.`);
        if (scope === 'all') {
          // A series that moved has new instance ids, so the one that was open may be gone: close,
          // and focus goes to the page's fallback, such as the range heading (R5-M10).
          reset();
          opener.current = fallbackFocus();
          leaveDialog();
          return;
        }
        setStep(null);
        setEditBase(null);
        setConflict(false);
        formDirty.current = false;
        void detail.refetch();
      },
    });
  }

  const dialogOpen = openId !== null || (createOpen && draft !== null);
  const e = editBase;
  const formMode: FormMode | null = createOpen
    ? { kind: 'create' }
    : stepState?.kind === 'edit' && e
      ? stepState.scope === 'all'
        ? { kind: 'edit', scope: 'all', repeatEditable: e.series?.repeatEditable ?? false, moveBlocked: e.series?.moveBlocked ?? null, seriesStart: e.series?.startDate ?? e.event.startDate }
        : { kind: 'edit', scope: 'this', instance: e.event.seriesId !== null }
      : null;

  const dialog = dialogOpen ? (
    <Modal
      labelledBy="calendar-dialog-title"
      onClose={close}
      returnFocus={() => {
        if (opener.current?.isConnected) return opener.current;
        const linked = lastOpenId.current && openerFor ? openerFor(lastOpenId.current) : null;
        return linked ?? fallbackFocus();
      }}
    >
      {createOpen && draft && formMode && (
        <EventForm
          titleId="calendar-dialog-title"
          heading="New event"
          initial={newEventValues(draft.date)}
          mode={formMode}
          repeatReadOnly={null}
          descriptionLocked={false}
          timeZone={me.family.timeZone}
          busy={create.isPending}
          locked={createLock}
          error={error}
          onSubmit={save}
          onCancel={close}
          onChange={onFormChange}
        />
      )}
      {openId && !d && !cached && detail.isPending && <p id="calendar-dialog-title" className="muted">Loading…</p>}
      {openId && !d && !cached && detail.error && (
        <div className="event-detail">
          <h3 id="calendar-dialog-title" tabIndex={-1}>Event</h3>
          <p className="error" role="alert">{detail.error.message}</p>
          <button type="button" onClick={close}>Close</button>
        </div>
      )}
      {openId && cached && (
        <EventDetail
          detail={{ event: cached, series: null }}
          today={today}
          titleId="calendar-dialog-title"
          canChange={false}
          notice={cachedEventNote(data?.freshness.readOnly ?? null, detail.error?.message)}
          error={null}
          busy={false}
          onEdit={() => {}}
          onDelete={() => {}}
          onClose={close}
        />
      )}
      {openId && d && stepState === null && (
        <EventDetail
          detail={d}
          today={today}
          titleId="calendar-dialog-title"
          canChange={canChange}
          notice={detailNotice}
          error={error}
          busy={remove.isPending}
          onEdit={startEdit}
          onDelete={startDelete}
          onClose={close}
        />
      )}
      {openId && d && stepState?.kind === 'scope' && (
        <ScopeChoice
          titleId="calendar-dialog-title"
          action={stepState.action}
          title={d.event.title}
          onCancel={() => setStep(null)}
          onPick={(scope) => {
            if (stepState.action === 'edit') beginEdit(scope);
            else {
              setStep(null);
              doDelete(scope);
            }
          }}
        />
      )}
      {openId && e && stepState?.kind === 'edit' && formMode && (
        <EventForm
          // Starts again only when a conflict reloaded the event (M-1), not when it was fetched again.
          key={formVersion}
          titleId="calendar-dialog-title"
          heading={stepState.scope === 'all' ? `Edit all "${e.event.title}" events` : `Edit "${e.event.title}"`}
          initial={eventValues(e.event, stepState.scope === 'all' ? e.series : e.event.seriesId ? null : e.series)}
          mode={formMode}
          repeatReadOnly={
            stepState.scope === 'this' && e.event.seriesId
              ? { text: e.series?.repeatText ?? null, note: 'This changes only this event, so its repeat stays as it is.' }
              : stepState.scope === 'all' && e.series && (!e.series.repeatEditable || e.series.moveBlocked)
                ? { text: e.series.repeatText, note: 'Edit the repeat in Google Calendar.' }
                : null
          }
          descriptionLocked={e.event.descriptionIsHtml}
          timeZone={me.family.timeZone}
          busy={update.isPending}
          notice={conflict ? CALENDAR_CONFLICT_MESSAGE : null}
          error={error}
          onSubmit={save}
          onCancel={() => {
            if (!discardOk()) return;
            setStep(null);
            setEditBase(null);
            setError(null);
            setConflict(false);
            formDirty.current = false;
          }}
          onChange={onFormChange}
        />
      )}
    </Modal>
  ) : null;

  return { openEvent, startCreate, canChange, dialog };
}
