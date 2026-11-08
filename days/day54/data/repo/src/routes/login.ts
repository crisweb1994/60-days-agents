import type { IncomingMessage } from 'node:http';
import { readJson } from '../http.ts';
import { checkPassword, issueToken } from '../token.ts';

export async function login(req: IncomingMessage) {
  const body = await readJson<{ email: string; password: string }>(req);
  console.log('login attempt', body);
  const user = await checkPassword(body.email, body.password);
  if (!user) return { status: 401, body: { error: '邮箱或密码不对' } };
  return { status: 200, body: { token: issueToken(user) } };
}
