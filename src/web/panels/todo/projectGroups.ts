import type { TodoistFreshness } from '../../../shared/integrations.js';
import type { TodoGroups, TodoItem } from '../../../shared/todo.js';

export interface TodoSection {
  key: string;
  label: string;
  items: TodoItem[];
}

/**
 * True when the open items are in more than one Todoist project, the only time grouping by
 * project tells the person anything. Since only the Inbox and chore to-dos sync, that's when chore
 * to-dos live outside the Inbox. Items not in Todoist yet aren't a project.
 */
export function spansProjects(groups: TodoGroups): boolean {
  const projects = new Set<string>();
  for (const item of [...groups.overdue, ...groups.today, ...groups.upcoming, ...groups.none]) {
    if (item.todoistProjectId !== null) projects.add(item.todoistProjectId);
    if (projects.size > 1) return true;
  }
  return false;
}

/**
 * Spec §10.4: for someone linked to Todoist, the drill-down can group open items by Todoist
 * project instead of by date. Projects come in the list's order (Inbox first, then by name);
 * within each, items keep the date order (overdue, today, upcoming, no date). A project the
 * cached names don't know yet comes after, and items not in Todoist yet (still moving there
 * after linking) come last.
 */
export function groupByProject(groups: TodoGroups, todoist: TodoistFreshness): TodoSection[] {
  const byProject = new Map<string | null, TodoItem[]>();
  for (const item of [...groups.overdue, ...groups.today, ...groups.upcoming, ...groups.none]) {
    const list = byProject.get(item.todoistProjectId) ?? [];
    list.push(item);
    byProject.set(item.todoistProjectId, list);
  }
  const known = new Set(todoist.projects.map((p) => p.id));
  const sections: TodoSection[] = todoist.projects
    .filter((p) => byProject.has(p.id))
    .map((p) => ({ key: `project-${p.id}`, label: p.name, items: byProject.get(p.id)! }));
  for (const [id, items] of byProject) {
    if (id !== null && !known.has(id)) sections.push({ key: `project-${id}`, label: 'Other project', items });
  }
  const notYet = byProject.get(null);
  if (notYet) sections.push({ key: 'project-none', label: 'Not in Todoist yet', items: notYet });
  return sections;
}
