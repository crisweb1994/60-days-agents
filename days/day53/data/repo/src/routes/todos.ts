import type { IncomingMessage } from 'node:http';
import { requireUser } from '../auth.ts';
import { db } from '../db.ts';
import { paginate } from '../utils/paginate.ts';

export async function listTodos(req: IncomingMessage, page = 1) {
  const user = requireUser(req);
  const todos = await db.query('select id, title, done from todos where owner = $1 order by created_at', [user.id]);
  return paginate(todos, page, 20);
}

export async function searchByTitle(req: IncomingMessage, keyword: string) {
  const user = requireUser(req);
  return db.query('select id, title from todos where owner = $1 and title ilike $2', [user.id, `%${keyword}%`]);
}
