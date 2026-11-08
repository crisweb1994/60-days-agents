import type { IncomingMessage } from 'node:http';
import { requireUser } from '../auth.ts';
import { db } from '../db.ts';

export async function searchTodos(req: IncomingMessage, keyword: string) {
  const user = requireUser(req);
  return db.query(`select id, title from todos where owner = '${user.id}' and title like '%${keyword}%'`);
}
