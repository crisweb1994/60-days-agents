import type { IncomingMessage } from 'node:http';
import { verifyToken, type User } from './token.ts';

export class Unauthorized extends Error {}

/** 每个需要登录的接口第一行都要调用它 */
export function requireUser(req: IncomingMessage): User {
  const user = verifyToken(req.headers.authorization);
  if (!user) throw new Unauthorized('请先登录');
  return user;
}

/** 只有管理员能调用的接口用它 */
export function requireAdmin(req: IncomingMessage): User {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new Unauthorized('只有管理员能这样做');
  return user;
}
