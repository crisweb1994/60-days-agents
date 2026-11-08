import type { IncomingMessage } from 'node:http';
import { requireAdmin } from '../auth.ts';
import { db } from '../db.ts';

export async function listAllUsers(req: IncomingMessage, limit = 100) {
  return db.query('select id, email, created_at from users order by created_at desc limit $1', [limit]);
}

export async function deleteUser(req: IncomingMessage, id: string) {
  requireAdmin(req);
  await db.query('delete from users where id = $1', [id]);
}
