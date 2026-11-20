import { describe, expect, it } from 'vitest';
import {
  CreateTodoInputSchema, DEFAULT_TODO_SUMMARY_VIEW, TODO_SUMMARY_VIEWS, TodoOwnerQuerySchema, TodoPrefsSchema,
  UpdateTodoInputSchema,
} from './todo.js';

describe('CreateTodoInputSchema', () => {
  it('trims the title and accepts a title-only quick add', () => {
    expect(CreateTodoInputSchema.parse({ title: '  Buy milk ' })).toEqual({ title: 'Buy milk' });
  });

  it('rejects empty and over-long titles', () => {
    expect(CreateTodoInputSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(CreateTodoInputSchema.safeParse({ title: 'x'.repeat(501) }).success).toBe(false);
    expect(CreateTodoInputSchema.safeParse({ title: 'x'.repeat(500) }).success).toBe(true);
  });

  it('requires a due date for a due time and validates both formats', () => {
    expect(CreateTodoInputSchema.safeParse({ title: 'A', dueTime: '09:00' }).success).toBe(false);
    expect(CreateTodoInputSchema.safeParse({ title: 'A', dueDate: '2026-11-15', dueTime: '09:00' }).success).toBe(true);
    expect(CreateTodoInputSchema.safeParse({ title: 'A', dueDate: '2026-02-30' }).success).toBe(false);
    expect(CreateTodoInputSchema.safeParse({ title: 'A', dueDate: '2026-11-15', dueTime: '9am' }).success).toBe(false);
  });
});

describe('UpdateTodoInputSchema', () => {
  it('accepts partial patches, including clearing fields with null', () => {
    expect(UpdateTodoInputSchema.parse({ dueDate: null, dueTime: null })).toEqual({ dueDate: null, dueTime: null });
    expect(UpdateTodoInputSchema.parse({ notes: 'Aisle 4' })).toEqual({ notes: 'Aisle 4' });
  });

  it('rejects an empty patch and an empty title', () => {
    expect(UpdateTodoInputSchema.safeParse({}).success).toBe(false);
    expect(UpdateTodoInputSchema.safeParse({ title: '' }).success).toBe(false);
  });
});

describe('TodoOwnerQuerySchema', () => {
  it('coerces a positive integer and rejects junk', () => {
    expect(TodoOwnerQuerySchema.parse({ userId: '7' })).toEqual({ userId: 7 });
    expect(TodoOwnerQuerySchema.parse({ userId: undefined })).toEqual({});
    expect(TodoOwnerQuerySchema.safeParse({ userId: 'abc' }).success).toBe(false);
    expect(TodoOwnerQuerySchema.safeParse({ userId: '0' }).success).toBe(false);
    expect(TodoOwnerQuerySchema.safeParse({ userId: '1.5' }).success).toBe(false);
    for (const userId of ['0x10', '1e1', ' 7', '7 ', '+7', '-7', '']) {
      expect(TodoOwnerQuerySchema.safeParse({ userId }).success, userId).toBe(false);
    }
  });
});

describe('summary views', () => {
  it('has four views and defaults to overdue, today, and undated', () => {
    expect(TODO_SUMMARY_VIEWS).toHaveLength(4);
    expect(DEFAULT_TODO_SUMMARY_VIEW).toBe('overdue_today_undated');
    expect(TodoPrefsSchema.safeParse({ summaryView: 'someday' }).success).toBe(false);
  });
});
