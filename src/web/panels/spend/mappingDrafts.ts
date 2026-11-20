import type { MappingBatchChange, MappingView } from '../../../shared/plaid.js';
import type { CategoryRef } from '../../../shared/spend.js';
import { spendViewFromSearch } from './spendSearch.js';

/**
 * The mapping editor's unsaved picks (review G4-I3, the owner's rule from 6a: one Save that saves
 * every field edited by hand). Changing a code's select only changes its draft; the Save bar sends
 * every draft at once, in one request that saves all or none (PATCH /mappings). A detailed code's
 * select also offers its main category's, which deletes its own row when saved. Pure, so it's
 * unit-tested; modeled on drafts.ts, the drill-down's.
 */
export interface MappingDraft {
  /** The category picked, or null to delete the code's own row (it then uses its main category's). */
  value: number | null;
  /** What was stored when it was picked: the code's category, or null for no row of its own. */
  base: number | null;
  /** What someone else has stored since (seen in a fresh view, or in the server's 409): flagged. */
  changedTo?: number | null;
  /** The code as people read it, for messages. */
  label: string;
  /** Why the server refused this pick (an archived category, say), shown beside the row until it's picked again. */
  problem?: string;
}

export type MappingDrafts = ReadonlyMap<string, MappingDraft>;

export const NO_MAPPING_DRAFTS: MappingDrafts = new Map();

/** What a code holds now: its own row's category, null for none (a code Plaid sent), or undefined when the view doesn't have it at all. */
export function storedValue(view: MappingView, code: string): number | null | undefined {
  const row = view.rows.find((r) => r.code === code);
  if (row) return row.category.id;
  return view.unmapped.some((u) => u.code === code) ? null : undefined;
}

/**
 * A pick in a code's select. Picking what's stored again clears its draft. A new pick is made
 * against what's stored now (`saved`), so picking again on a flagged code clears the flag and any
 * refusal. The same map comes back when nothing changes.
 */
export function setMappingDraft(drafts: MappingDrafts, code: string, value: number | null, saved: number | null, label: string): MappingDrafts {
  const d = drafts.get(code);
  if (value === saved) {
    if (!d) return drafts;
    const next = new Map(drafts);
    next.delete(code);
    return next;
  }
  if (d && d.value === value && d.base === saved && d.changedTo === undefined && d.problem === undefined) return drafts;
  return new Map(drafts).set(code, { value, base: saved, label });
}

/**
 * Against a fresh view (a refetch, or the person's own Save's answer): a draft that now holds the
 * stored value goes (`matched`), and so does one for a code the view no longer has (`gone`). A code
 * someone else changed to a third value keeps its draft, flagged with `changedTo`, until it's picked
 * again, saved, or changed back. `ownSave`: the view the person's own Save answered, so a pick made
 * while it was out is now made against what was saved, not flagged, and nothing counts as matched.
 */
export function settleMappingDrafts(drafts: MappingDrafts, view: MappingView, ownSave = false): { drafts: MappingDrafts; matched: number; gone: number } {
  let next: Map<string, MappingDraft> | null = null;
  let matched = 0;
  let gone = 0;
  const put = (code: string, d: MappingDraft | null) => {
    next ??= new Map(drafts);
    if (d === null) next.delete(code);
    else next.set(code, d);
  };
  for (const [code, d] of drafts) {
    const stored = storedValue(view, code);
    if (stored === undefined) {
      put(code, null);
      gone++;
    } else if (stored === d.value) {
      put(code, null);
      if (!ownSave) matched++;
    } else if (ownSave) {
      if (stored !== d.base || d.changedTo !== undefined) put(code, { value: d.value, base: stored, label: d.label });
    } else {
      const changedTo = stored === d.base ? undefined : stored;
      if (changedTo !== d.changedTo) {
        const { changedTo: _old, ...rest } = d;
        put(code, changedTo === undefined ? rest : { ...rest, changedTo });
      }
    }
  }
  return { drafts: next ?? drafts, matched, gone };
}

/** Flags the codes the server refused because someone else changed them, with what's stored now. */
export function markMappingConflicts(drafts: MappingDrafts, conflicts: readonly { code: string; current: number | null }[]): MappingDrafts {
  const next = new Map(drafts);
  for (const c of conflicts) {
    const d = next.get(c.code);
    if (d) next.set(c.code, { ...d, changedTo: c.current });
  }
  return next;
}

/** Names the server's reason beside the code it refused. */
export function markMappingProblem(drafts: MappingDrafts, code: string, problem: string): MappingDrafts {
  const d = drafts.get(code);
  return d ? new Map(drafts).set(code, { ...d, problem }) : drafts;
}

/** Drops the codes the server says are gone. */
export function dropCodes(drafts: MappingDrafts, codes: readonly string[]): { drafts: MappingDrafts; removed: number } {
  const next = new Map(drafts);
  let removed = 0;
  for (const code of codes) if (next.delete(code)) removed++;
  return { drafts: removed === 0 ? drafts : next, removed };
}

/** The body of the one Save: each code with its pick and what it was last seen holding (flagged: "use my pick anyway"). */
export function mappingChanges(drafts: MappingDrafts): MappingBatchChange[] {
  return [...drafts].map(([code, d]) => ({ code, categoryId: d.value, expected: d.changedTo !== undefined ? d.changedTo : d.base }));
}

/** The codes whose rows are shown: the not-mapped list always, the folded list of every code only while it's open. */
export function shownMappingCodes(view: MappingView, open: boolean): Set<string> {
  return new Set([...view.unmapped.map((u) => u.code), ...(open ? view.rows.map((r) => r.code) : [])]);
}

/** A navigation that stays on Spend settings (its own search changes, say) keeps the drafts; anything else asks first. */
export function keepsMappingDrafts(next: { pathname: string; search: Record<string, unknown> }): boolean {
  return next.pathname.replace(/\/+$/, '') === '/spend' && spendViewFromSearch(next.search).tab === 'settings';
}

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

export const savedMappingsLine = (n: number) => `Saved ${changes(n)}. ${n === 1 ? 'It applies' : 'They apply'} to new transactions.`;

export const goneLine = (n: number) =>
  n === 1 ? "1 change was for a category code that isn't here anymore, so it was removed." : `${n} changes were for category codes that aren't here anymore, so they were removed.`;

/** A detailed code's choice to delete its own row: what it uses then, its main category's, or Uncategorized without one. */
export function fallbackOptionLabel(primaryLabel: string | null, fallback: Pick<CategoryRef, 'name'> | null): string {
  if (primaryLabel === null) return 'No mapping of its own (Uncategorized)';
  return `Use ${primaryLabel}'s category${fallback ? ` (${fallback.name})` : ''}`;
}

/**
 * A Save whose answer never came (review C-M5): the drafts now, settled against a fresh view by
 * what was sent. A sent code that now holds what was sent was saved (PATCH /mappings saves all or
 * none, so that's this Save, unless someone else chose the same): its draft goes, or, when it was
 * picked again since, stays as a pick made against what was saved. Every other draft is settled as
 * a refetch would be (not as the person's own save), so a code someone else changed meanwhile is
 * flagged. Codes the view no longer has go. The counts are for `unknownMappingLine`.
 */
export function settleSentMappingDrafts(
  drafts: MappingDrafts,
  sent: readonly MappingBatchChange[],
  view: MappingView,
): { drafts: MappingDrafts; saved: number; notSaved: number; flagged: number; gone: number; remaining: number } {
  const byCode = new Map(sent.map((c) => [c.code, c]));
  let saved = 0;
  let notSaved = 0;
  for (const c of sent) {
    const stored = storedValue(view, c.code);
    if (stored === undefined) continue;
    if (stored === c.categoryId) saved++;
    else notSaved++;
  }
  const next = new Map<string, MappingDraft>();
  let gone = 0;
  let flagged = 0;
  for (const [code, d] of drafts) {
    const stored = storedValue(view, code);
    if (stored === undefined) {
      gone++;
      continue;
    }
    const s = byCode.get(code);
    if (s && stored === s.categoryId) {
      // Saved as sent: gone, unless picked again since, which is now made against what was saved.
      if (d.value !== stored) next.set(code, { value: d.value, base: stored, label: d.label });
      continue;
    }
    if (stored === d.value) continue;
    const changedTo = stored === d.base ? undefined : stored;
    const { changedTo: _old, problem: _problem, ...rest } = d;
    next.set(code, changedTo === undefined ? { ...rest, ...(d.problem !== undefined ? { problem: d.problem } : {}) } : { ...rest, changedTo });
    if (changedTo !== undefined) flagged++;
  }
  return { drafts: next, saved, notSaved, flagged, gone, remaining: next.size };
}

/** What an unanswered Save shows once the view is fetched again, by what's left (review C-M5). */
export function unknownMappingLine(out: { saved: number; notSaved: number; flagged: number; remaining: number }): string {
  const late = "The server didn't answer in time";
  if (out.remaining === 0) return `${late}. Your changes now show as saved.`;
  if (out.saved > 0 && out.notSaved === 0) {
    return `${late}. Your changes now show as saved, except ${out.remaining === 1 ? '1 change made since, which isn\'t' : `${out.remaining} changes made since, which aren't`} saved yet.`;
  }
  if (out.flagged > 0) {
    return `${late}, and your changes don't show as saved. Someone else changed ${out.flagged} of them meanwhile. Check ${out.flagged === 1 ? 'it' : 'them'}, then save again.`;
  }
  return `${late}, and your changes don't show as saved. Save again.`;
}

/*
 * Storage (sessionStorage under the drafts prefix, like the drill-down's, review C-M7), so drafts
 * survive a reload and signing out clears them: codes, picks, what each was made against, a flag,
 * and the code's label (Plaid's category name, nothing of the family's). A refusal's reason isn't
 * kept: it's about a Save that's over.
 */

/** Where a person's mapping drafts are kept (`readStored`/`writeStored` add the drafts prefix). */
export const mappingDraftsKey = (userId: number) => `spend-mappings:${userId}`;

export function serializeMappingDrafts(drafts: MappingDrafts): string {
  return JSON.stringify({
    v: 1,
    codes: [...drafts].map(([code, d]) => [code, { value: d.value, base: d.base, label: d.label, ...(d.changedTo !== undefined ? { changedTo: d.changedTo } : {}) }]),
  });
}

const isPickId = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0);

/** Reads what `serializeMappingDrafts` wrote. Anything broken, foreign, or from another version reads as no drafts. */
export function parseMappingDrafts(text: string | null): MappingDrafts {
  let data: unknown;
  try {
    data = JSON.parse(text ?? '');
  } catch {
    return NO_MAPPING_DRAFTS;
  }
  const codes = (data as { v?: unknown; codes?: unknown } | null)?.codes;
  if ((data as { v?: unknown } | null)?.v !== 1 || !Array.isArray(codes)) return NO_MAPPING_DRAFTS;
  const out = new Map<string, MappingDraft>();
  for (const entry of codes) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0] === '' || entry[0].length > 200 || !entry[1] || typeof entry[1] !== 'object') return NO_MAPPING_DRAFTS;
    const raw = entry[1] as Record<string, unknown>;
    if (!isPickId(raw.value) || !isPickId(raw.base) || typeof raw.label !== 'string' || (raw.changedTo !== undefined && !isPickId(raw.changedTo))) return NO_MAPPING_DRAFTS;
    out.set(entry[0], { value: raw.value, base: raw.base, label: raw.label.slice(0, 200), ...(raw.changedTo !== undefined ? { changedTo: raw.changedTo as number | null } : {}) });
  }
  return out.size === 0 ? NO_MAPPING_DRAFTS : out;
}
