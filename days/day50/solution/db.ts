// 第 46 天：多用户的数据放进 PostgreSQL，用行级安全（Row Level Security，RLS）让数据库自己保证用户之间看不到彼此的数据。
// 两道防线：
//   1. 应用层：每个查询都带上 where user_id = 当前用户（tenant-store.ts）
//   2. 数据库层：每张带 user_id 的表都开启 RLS，策略是「user_id 等于这次事务里设置的 app.user_id」；应用用一个没有特权的角色连接。
//      哪天有人写漏了 where，数据库也只返回当前用户的行；插入别人的 user_id 直接报错
// 测试用 PGlite（编译成 WebAssembly 的 PostgreSQL，跑在进程里，不用装数据库），线上用 pg 连真正的 PostgreSQL，SQL 一样。
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/** 最小的数据库接口：查询和事务。PGlite 和 pg 都包成它 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** 在一个事务里执行 fn：fn 正常返回就提交，抛出错误就回滚 */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** 进程内的 PostgreSQL，测试和本地开发用。不传 dataDir 就只在内存里 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const db = await PGlite.create(dataDir);
  const wrap = (q: { query: PGlite['query'] }): Omit<Db, 'transaction' | 'close'> => ({
    async query<T>(sql: string, params: unknown[] = []) {
      return { rows: (await q.query<T>(sql, params)).rows };
    },
  });
  return {
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn({ ...wrap(tx), transaction: () => Promise.reject(new Error('不支持嵌套事务')), close: async () => {} })),
    close: () => db.close(),
  };
}

/** 真正的 PostgreSQL。DATABASE_URL 形如 postgres://app:密码@localhost:5432/research */
export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return { rows: (await pool.query(sql, params)).rows as T[] };
    },
    async transaction(fn) {
      const client = await pool.connect();
      const tx: Db = {
        async query<T>(sql: string, params: unknown[] = []) {
          return { rows: (await client.query(sql, params)).rows as T[] };
        },
        transaction: () => Promise.reject(new Error('不支持嵌套事务')),
        close: async () => {},
      };
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** 应用平时用的角色：没有超级用户权限，不能绕过 RLS */
export const APP_ROLE = 'research_app';

/** 带 user_id 的表，每一张都要有 RLS */
export const TENANT_TABLES = ['api_keys', 'memories', 'documents', 'chunks', 'sessions', 'usage_daily'] as const;

/**
 * 表结构。users 没有 user_id（它的主键就是 id），登录要在知道是谁之前查它，所以不开 RLS，应用也只能读（见下面的授权）。
 * 向量这里用 real[] 存、在应用里算相似度，因为 PGlite 默认不带 pgvector；线上换成 pgvector 的 vector(维数) 列和 <=> 运算符，
 * RLS 策略完全一样
 */
export const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists api_keys (
  hash text primary key,
  user_id text not null references users(id) on delete cascade,
  label text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists memories (
  user_id text not null references users(id) on delete cascade,
  name text not null,
  type text not null,
  content text not null,
  created timestamptz not null,
  updated timestamptz not null,
  expires timestamptz,
  primary key (user_id, name)
);
create table if not exists documents (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  path text not null,
  created_at timestamptz not null default now()
);
create table if not exists chunks (
  id text not null,
  user_id text not null references users(id) on delete cascade,
  document_id text not null references documents(id) on delete cascade,
  path text not null,
  heading text not null default '',
  text text not null,
  embedding real[] not null,
  primary key (user_id, id)
);
create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  title text not null default '',
  messages jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
create table if not exists usage_daily (
  user_id text not null references users(id) on delete cascade,
  day date not null,
  requests integer not null default 0,
  cost double precision not null default 0,
  primary key (user_id, day)
);
`;

/**
 * 建表、建角色、开 RLS。可以重复执行。
 * - 每张租户表：enable row level security，再 force（表的所有者也要遵守），建一条策略：
 *   using 和 with check 都是 user_id = current_setting('app.user_id', true)。没设置 app.user_id 时这个值是空的，一行都看不到（默认拒绝）
 * - 应用角色只有增删改查的权限；users 表只能读
 * - 迁移要用管理员角色执行（PGlite 里是超级用户 postgres；线上是一个有 BYPASSRLS 的迁移专用角色），应用平时用 APP_ROLE
 */
export async function migrate(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    // 多副本同时启动时用事务级咨询锁排队，避免 drop/create policy 并发冲突
    await tx.query('select pg_advisory_xact_lock(74430046)');
    await tx.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then create role ${APP_ROLE} nologin; end if; end $$`);
    for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await tx.query(statement);
    await tx.query(`grant select on users to ${APP_ROLE}`);
    for (const table of TENANT_TABLES) {
      await tx.query(`alter table ${table} enable row level security`);
      await tx.query(`alter table ${table} force row level security`);
      await tx.query(`drop policy if exists tenant_isolation on ${table}`);
      await tx.query(`create policy tenant_isolation on ${table} using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true))`);
      await tx.query(`grant select, insert, update, delete on ${table} to ${APP_ROLE}`);
    }
    // 登录前按 API Key 的哈希找用户：security definer 函数以所有者的身份执行，只能做这一件事（auth.ts 的 findUserByApiKey）。
    // search_path 固定住，免得被人用同名的表或函数劫持
    await tx.query(`create or replace function lookup_api_key(key_hash text) returns text language sql stable security definer set search_path = public as $fn$ select user_id from api_keys where hash = key_hash $fn$`);
    await tx.query(`grant execute on function lookup_api_key(text) to ${APP_ROLE}`);
  });
}

/**
 * 以某个用户的身份执行 fn：开一个事务，切换到应用角色（set local role），设置 app.user_id（set_config 的第三个参数 true 表示只在这个事务里有效）。
 * 用 set local / set_config(..., true) 而不是 set：连接会被连接池复用，会话级的设置会漏给下一个请求
 */
export function withTenant<T>(db: Db, userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (!userId) return Promise.reject(new Error('withTenant 需要用户编号'));
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${APP_ROLE}`);
    await tx.query(`select set_config('app.user_id', $1, true)`, [userId]);
    return fn(tx);
  });
}

/**
 * 检查有没有表漏开了 RLS：public 下所有带 user_id 列的表，都要 relrowsecurity 和 relforcerowsecurity，而且至少有一条策略。
 * 返回有问题的表名（排好序）。新加一张表忘了开 RLS，这个检查会在测试里失败
 */
export async function findUnprotectedTables(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ table: string }>(`
    select c.relname as table
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'user_id')
      and (not c.relrowsecurity or not c.relforcerowsecurity or not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname))
    order by c.relname`);
  return rows.map((r) => r.table);
}
