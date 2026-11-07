// 第 46 天：研究助手的数据按用户放进数据库。记忆（第 19 天）、文档和向量索引（第 17、18 天）、会话（第 10 天）都换成数据库的实现，
// 接口不变：MemoryStore 和 Retriever 还是原来的接口，研究助手的代码不用改，只是 makeSetup 按用户创建它们。
// 每个函数都做两件事：用 withTenant 以这个用户的身份执行（数据库层的防线），SQL 里也写明 user_id = $1（应用层的防线）。
// RAG 检索串到别人的数据，是多租户 Agent 最容易出、也最严重的事故：检索结果会进上下文，模型会把它原样说出来。
import { createBM25Index } from './rag/bm25.ts';
import { chunkMarkdown, embeddingText, type Chunk } from './rag/chunk.ts';
import type { Embedder } from './rag/embeddings.ts';
import { reciprocalRankFusion, type Retriever } from './rag/hybrid.ts';
import { cosine, type SearchHit } from './rag/vector-store.ts';
import { withTenant, type Db } from './db.ts';
import { findSecrets, MAX_MEMORY_CHARS, MEMORY_TYPES, type Memory, type MemoryStore } from './memory.ts';
import type { Message } from './types.ts';

// ---------- 记忆 ----------

type MemoryRow = { name: string; type: Memory['type']; content: string; created: Date | string; updated: Date | string; expires: Date | string | null };
const iso = (value: Date | string) => new Date(value).toISOString();
const toMemory = (r: MemoryRow): Memory => ({ name: r.name, type: r.type, content: r.content, created: iso(r.created), updated: iso(r.updated), ...(r.expires ? { expires: iso(r.expires) } : {}) });
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 一个用户的记忆，存在 memories 表里。规则和第 19 天的文件版一样：名字的格式、长度、不能有敏感信息、同名的更新 */
export function createTenantMemoryStore(db: Db, userId: string, now: () => Date = () => new Date()): MemoryStore {
  const list = () =>
    withTenant(db, userId, async (tx) => {
      await tx.query('delete from memories where user_id = $1 and expires is not null and expires <= $2', [userId, now().toISOString()]);
      const { rows } = await tx.query<MemoryRow>('select name, type, content, created, updated, expires from memories where user_id = $1 order by updated desc', [userId]);
      return rows.map(toMemory);
    });
  return {
    dir: `db:memories/${userId}`,
    list,
    async remember({ name, type, content, ttlDays }) {
      if (!NAME.test(name)) throw new Error(`记忆的名字「${name}」不行：只能用小写字母、数字和短横线`);
      if (!MEMORY_TYPES.includes(type)) throw new Error(`记忆的类型只能是 ${MEMORY_TYPES.join('、')}`);
      const text = content.trim();
      if (!text) throw new Error('记忆的内容是空的');
      if (text.length > MAX_MEMORY_CHARS) throw new Error(`记忆太长了（${text.length} 个字符，最多 ${MAX_MEMORY_CHARS}）`);
      const secrets = findSecrets(text);
      if (secrets.length) throw new Error(`内容里像是有${secrets.join('、')}，这类敏感信息不能写进记忆`);
      const time = now().toISOString();
      const expires = ttlDays ? new Date(now().getTime() + ttlDays * 86_400_000).toISOString() : null;
      return withTenant(db, userId, async (tx) => {
        const { rows } = await tx.query<MemoryRow & { inserted: boolean }>(
          `insert into memories (user_id, name, type, content, created, updated, expires) values ($1, $2, $3, $4, $5, $5, $6)
           on conflict (user_id, name) do update set type = excluded.type, content = excluded.content, updated = excluded.updated, expires = excluded.expires
           returning name, type, content, created, updated, expires, (xmax = 0) as inserted`,
          [userId, name, type, text, time, expires],
        );
        return { memory: toMemory(rows[0]), updated: !rows[0].inserted };
      });
    },
    async forget(name) {
      return withTenant(db, userId, async (tx) => (await tx.query('delete from memories where user_id = $1 and name = $2 returning name', [userId, name])).rows.length > 0);
    },
    async search(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return (await list()).filter((m) => terms.every((t) => `${m.name} ${m.content}`.toLowerCase().includes(t)));
    },
  };
}

// ---------- 文档和检索 ----------

/**
 * 给一个用户加一篇文档：切块（第 17 天的 chunkMarkdown）、算向量、写进 documents 和 chunks。
 * 同一个用户同一个路径的文档已经有了，先删掉旧的（chunks 跟着级联删掉）。返回切出来的块数
 */
export async function addDocument(db: Db, userId: string, input: { path: string; markdown: string }, embedder: Embedder): Promise<number> {
  const chunks = chunkMarkdown(input.markdown, input.path);
  const vectors = chunks.length ? await embedder.embed(chunks.map(embeddingText)) : [];
  await withTenant(db, userId, async (tx) => {
    await tx.query('delete from documents where user_id = $1 and path = $2', [userId, input.path]);
    const documentId = `${userId}:${input.path}`;
    await tx.query('insert into documents (id, user_id, path) values ($1, $2, $3)', [documentId, userId, input.path]);
    for (const [i, chunk] of chunks.entries()) {
      await tx.query('insert into chunks (id, user_id, document_id, path, heading, text, embedding) values ($1, $2, $3, $4, $5, $6, $7)', [chunk.id, userId, documentId, chunk.path, chunk.heading, chunk.text, vectors[i]]);
    }
  });
  return chunks.length;
}

type ChunkRow = { id: string; path: string; heading: string; text: string; embedding: number[] };

/** 这个用户的所有块和向量 */
async function loadChunks(db: Db, userId: string): Promise<ChunkRow[]> {
  return withTenant(db, userId, async (tx) => (await tx.query<ChunkRow>('select id, path, heading, text, embedding from chunks where user_id = $1', [userId])).rows);
}

/**
 * 一个用户的检索器，实现第 18 天的 Retriever：向量、关键词、混合三种方式，只在这个用户的块里找。
 * 每次检索都从数据库读这个用户的块（小规模够用；线上用 pgvector 在数据库里算，加上 where user_id = $1 和 RLS）
 */
export function createTenantRetriever(db: Db, userId: string, embedder: Embedder): Retriever {
  return {
    refresh() {},
    async search(query, { mode = 'hybrid', k = 5, signal } = {}) {
      const rows = await loadChunks(db, userId);
      const chunks: Chunk[] = rows.map(({ id, path, heading, text }) => ({ id, path, heading, text }));
      const keyword = () => createBM25Index(chunks).search(query, mode === 'hybrid' ? k * 3 : k);
      if (mode === 'keyword') return keyword();
      const [vector] = await embedder.embed([query], { signal });
      const byVector: SearchHit[] = rows
        .map((r, i) => ({ chunk: chunks[i], score: cosine(vector, r.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, mode === 'hybrid' ? k * 3 : k);
      if (mode === 'vector') return byVector;
      return reciprocalRankFusion([byVector, keyword()]).slice(0, k);
    },
  };
}

// ---------- 会话 ----------

export interface SessionRecord {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
}

/**
 * 保存会话。id 已经存在、但属于别的用户：on conflict 的 where 不成立，什么都不改，returning 也拿不到行。
 * 这时抛出错误，而不是悄悄地什么都没做（调用方以为保存成功了，下次读出来却是空的）
 */
export async function saveSession(db: Db, userId: string, session: Omit<SessionRecord, 'updatedAt'>): Promise<void> {
  const { rows } = await withTenant(db, userId, (tx) =>
    tx.query(
      `insert into sessions (id, user_id, title, messages, updated_at) values ($1, $2, $3, $4, now())
       on conflict (id) do update set title = excluded.title, messages = excluded.messages, updated_at = now() where sessions.user_id = $2
       returning id`,
      [session.id, userId, session.title, JSON.stringify(session.messages)],
    ),
  );
  if (!rows.length) throw new Error(`会话编号 ${session.id} 已经被占用了`);
}

export async function loadSession(db: Db, userId: string, id: string): Promise<SessionRecord | undefined> {
  return withTenant(db, userId, async (tx) => {
    const { rows } = await tx.query<{ id: string; title: string; messages: Message[]; updated_at: Date | string }>('select id, title, messages, updated_at from sessions where user_id = $1 and id = $2', [userId, id]);
    return rows[0] && { id: rows[0].id, title: rows[0].title, messages: rows[0].messages, updatedAt: iso(rows[0].updated_at) };
  });
}

export async function listSessions(db: Db, userId: string): Promise<{ id: string; title: string }[]> {
  return withTenant(db, userId, async (tx) => (await tx.query<{ id: string; title: string }>('select id, title from sessions where user_id = $1 order by updated_at desc', [userId])).rows);
}
