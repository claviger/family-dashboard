import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { connections, todos, users } from '../db/schema.js';
import { todoistUnconfiguredWarning } from './todoistUnconfigured.js';

const NOW = new Date('2026-11-15T12:00:00Z');

function addUserRow(db: Db, email: string): number {
  return db.insert(users).values({ email, displayName: 'Kid', color: '#378ADD', role: 'member', createdAt: NOW }).returning({ id: users.id }).get().id;
}

function addTodo(db: Db, owner: number, backend: 'internal' | 'todoist', deletedAt: Date | null = null): void {
  db.insert(todos).values({ ownerUserId: owner, backend, title: 'Item', createdAt: NOW, updatedAt: NOW, deletedAt }).run();
}

describe('todoistUnconfiguredWarning', () => {
  it('is null when nobody is linked and no to-dos live in Todoist', () => {
    const { db } = openDb(':memory:');
    const kid = addUserRow(db, 'kid@example.com');
    addTodo(db, kid, 'internal');
    addTodo(db, kid, 'todoist', NOW); // deleted: nothing hidden
    expect(todoistUnconfiguredWarning(db)).toBeNull();
  });

  it('counts each person once, whether they have a saved link, Todoist to-dos, or both', () => {
    const { db } = openDb(':memory:');
    const linked = addUserRow(db, 'linked@example.com');
    const rowsOnly = addUserRow(db, 'rows@example.com');
    db.insert(connections).values({ kind: 'todoist', scope: 'user', ownerUserId: linked, credentialsEnc: 'v1.x', createdAt: NOW, updatedAt: NOW }).run();
    addTodo(db, linked, 'todoist');
    addTodo(db, linked, 'todoist');
    addTodo(db, rowsOnly, 'todoist');
    expect(todoistUnconfiguredWarning(db)).toBe(
      "2 people are linked to Todoist but Todoist isn't configured. Their Todoist to-dos are hidden until it's configured again. Nothing was deleted.",
    );
  });

  it('says "1 person" for one', () => {
    const { db } = openDb(':memory:');
    const linked = addUserRow(db, 'linked@example.com');
    db.insert(connections).values({ kind: 'todoist', scope: 'user', ownerUserId: linked, credentialsEnc: 'v1.x', createdAt: NOW, updatedAt: NOW }).run();
    expect(todoistUnconfiguredWarning(db)).toMatch(/^1 person is linked to Todoist but Todoist isn't configured\. Their Todoist to-dos/);
  });
});
