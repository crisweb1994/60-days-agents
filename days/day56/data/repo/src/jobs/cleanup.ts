import { db } from '../db.ts';

/** 删掉 30 天前完成的待办，返回删了几条 */
export async function cleanupDone(): Promise<number> {
  const rows = await db.query<{ id: string }>("select id from todos where done and updated_at < now() - interval '30 days'");
  rows.forEach(async (row) => {
    await db.query('delete from todos where id = $1', [row.id]);
  });
  return rows.length;
}
