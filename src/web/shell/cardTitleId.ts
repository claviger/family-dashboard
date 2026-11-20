import type { PanelId } from '../../shared/panels.js';

/** The id of a home card's title (its heading, which holds the link to the drill-down). */
export function cardTitleId(id: PanelId): string {
  return `card-${id}-title`;
}
