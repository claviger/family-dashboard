import type { ComponentType } from 'react';
import { PANEL_TITLES, type PanelId } from '../../shared/panels.js';
import { CalendarDrillDown } from './calendar/CalendarDrillDown.js';
import { CalendarSummary } from './calendar/CalendarSummary.js';
import { ChoresDrillDown } from './chores/ChoresDrillDown.js';
import { ChoresSummary } from './chores/ChoresSummary.js';
import { SavingsDrillDown } from './savings/SavingsDrillDown.js';
import { SavingsSummary } from './savings/SavingsSummary.js';
import { SpendDrillDown } from './spend/SpendDrillDown.js';
import { SpendSummary } from './spend/SpendSummary.js';
import { TodoDrillDown } from './todo/TodoDrillDown.js';
import { TodoSummary } from './todo/TodoSummary.js';

export interface WebPanel {
  id: PanelId;
  title: string;
  Summary: ComponentType;
  DrillDown: ComponentType;
}

export const WEB_PANELS: Record<PanelId, WebPanel> = {
  calendar: { id: 'calendar', title: PANEL_TITLES.calendar, Summary: CalendarSummary, DrillDown: CalendarDrillDown },
  todo: { id: 'todo', title: PANEL_TITLES.todo, Summary: TodoSummary, DrillDown: TodoDrillDown },
  chores: { id: 'chores', title: PANEL_TITLES.chores, Summary: ChoresSummary, DrillDown: ChoresDrillDown },
  spend: { id: 'spend', title: PANEL_TITLES.spend, Summary: SpendSummary, DrillDown: SpendDrillDown },
  savings: { id: 'savings', title: PANEL_TITLES.savings, Summary: SavingsSummary, DrillDown: SavingsDrillDown },
};
