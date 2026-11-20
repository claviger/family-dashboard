import { z } from 'zod';

export const PANEL_IDS = ['calendar', 'todo', 'chores', 'spend', 'savings'] as const;
export const PanelIdSchema = z.enum(PANEL_IDS, { error: 'Unknown panel' });
export type PanelId = z.infer<typeof PanelIdSchema>;

export const PANEL_TITLES: Record<PanelId, string> = {
  calendar: 'Calendar',
  todo: 'To-do',
  chores: 'Chores',
  spend: 'Spend',
  savings: 'Savings',
};

/** Returns the given panels in fixed display order, without duplicates. */
export function orderPanels(panels: readonly PanelId[]): PanelId[] {
  const set = new Set(panels);
  return PANEL_IDS.filter((id) => set.has(id));
}
