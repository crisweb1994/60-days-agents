import { db } from '../db.ts';

export async function todosWithTags(userId: string) {
  const todos = await db.query<{ id: string; title: string; tags?: unknown[] }>('select id, title from todos where owner = $1', [userId]);
  for (const todo of todos) {
    todo.tags = await db.query('select name from tags where todo_id = $1', [todo.id]);
  }
  return todos;
}
