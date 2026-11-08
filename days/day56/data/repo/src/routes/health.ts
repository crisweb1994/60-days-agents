import { db } from '../db.ts';

/** 健康检查：数据库能连上就是 200 */
export async function health() {
  try {
    await db.query('select 1');
    return { status: 200, body: { status: 'ok' } };
  } catch {
    return { status: 503, body: { status: 'database unavailable' } };
  }
}
