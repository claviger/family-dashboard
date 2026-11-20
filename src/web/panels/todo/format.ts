import { addDays } from '../../../shared/dates.js';
import type { TodoItem } from '../../../shared/todo.js';

/** "Today", "Tomorrow", "Yesterday", or a short date like "Wed, Nov 18" (with the year if it differs). */
function formatDate(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

/** "07:30" in the viewer's locale, e.g. "7:30 AM". */
function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, 0, 1, h ?? 0, m ?? 0)),
  );
}

/** Due label for an item, or null when it has no due date. Dates are family-local, so no zone conversion. */
export function formatDue(item: Pick<TodoItem, 'dueDate' | 'dueTime'>, today: string): string | null {
  if (!item.dueDate) return null;
  const date = formatDate(item.dueDate, today);
  return item.dueTime ? `${date}, ${formatTime(item.dueTime)}` : date;
}

export function isOverdue(item: Pick<TodoItem, 'dueDate' | 'completedAt'>, today: string): boolean {
  return item.completedAt === null && item.dueDate !== null && item.dueDate < today;
}
