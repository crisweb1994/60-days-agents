import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { db } from './db.ts';

export interface User {
  id: string;
  role: 'user' | 'admin';
}

/** 校验 Authorization: Bearer <token>，通过了返回用户 */
export function verifyToken(header: string | undefined): User | undefined {
  const token = header?.replace(/^Bearer\s+/i, '') ?? '';
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return undefined;
  const expected = createHmac('sha256', config.tokenSecret).update(payload).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as User;
}

export function issueToken(user: User): string {
  const payload = Buffer.from(JSON.stringify(user)).toString('base64url');
  return `${payload}.${createHmac('sha256', config.tokenSecret).update(payload).digest('base64url')}`;
}

export async function checkPassword(email: string, password: string): Promise<User | undefined> {
  const [row] = await db.query<User & { password_hash: string }>('select id, role, password_hash from users where email = $1', [email]);
  // 示例项目：真实项目用 scrypt 或 argon2 比较
  return row && row.password_hash === password ? { id: row.id, role: row.role } : undefined;
}
