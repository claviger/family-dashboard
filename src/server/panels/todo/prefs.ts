import { eq } from 'drizzle-orm';
import { DEFAULT_TODO_SUMMARY_VIEW, type TodoSummaryView } from '../../../shared/todo.js';
import type { Db } from '../../db/index.js';
import { userPrefs } from '../../db/schema.js';

export function getSummaryView(db: Db, userId: number): TodoSummaryView {
  return db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).get()?.todoSummaryView ?? DEFAULT_TODO_SUMMARY_VIEW;
}

export function setSummaryView(db: Db, userId: number, view: TodoSummaryView): void {
  db.insert(userPrefs)
    .values({ userId, todoSummaryView: view })
    .onConflictDoUpdate({ target: userPrefs.userId, set: { todoSummaryView: view } })
    .run();
}
