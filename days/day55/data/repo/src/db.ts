// 数据库连接。query 的第二个参数是参数化查询的值：永远不要把用户输入拼进 SQL
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const db = {
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await pool.query(sql, params);
    return rows as T[];
  },
};
