// 第 47 天：上传以后在后台建索引。上传接口只做「验、存、记」，马上返回；解析 PDF、读图片、算向量放进后台（第 45 天的思路），
// 文件的状态从 uploaded → indexing → ready（或者 failed），界面轮询或者订阅它。
// 建好的块写进第 46 天的 documents 和 chunks 表，按用户隔离；研究助手的 search_docs 用 createTenantRetriever 就能查到。
// 第 47 天的练习：TODO 4 在这里。检查：npm run check 47
import { randomUUID } from 'node:crypto';
import { withTenant, APP_ROLE, type Db } from './db.ts';
import { extractPdfPages, pdfToChunks } from './pdf.ts';
import type { Chunk } from './rag/chunk.ts';
import { embeddingText } from './rag/chunk.ts';
import type { Embedder } from './rag/embeddings.ts';
import { objectKey, type FileKind, type ObjectStore, type Upload } from './uploads.ts';
import { describeImage, type VisionConfig } from './vision.ts';

export type FileStatus = 'uploaded' | 'indexing' | 'ready' | 'failed';

export interface FileRecord {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
  status: FileStatus;
  /** PDF 的页数；图片是 1 */
  pages: number | null;
  /** 建了几块 */
  chunks: number | null;
  /** 给用户看的提示，比如「第 3、4 页没有文字，可能是扫描件」 */
  note: string | null;
  createdAt: string;
}

/** 在第 46 天的表结构上加一张 files 表，同样开 RLS（findUnprotectedTables 会检查它） */
export async function migrateFiles(db: Db): Promise<void> {
  await db.query(`create table if not exists files (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    name text not null,
    kind text not null,
    size integer not null,
    object_key text not null,
    status text not null default 'uploaded',
    pages integer,
    chunks integer,
    note text,
    error text,
    created_at timestamptz not null default now()
  )`);
  await db.query('alter table files enable row level security');
  await db.query('alter table files force row level security');
  await db.query('drop policy if exists tenant_isolation on files');
  await db.query(`create policy tenant_isolation on files using (user_id = current_setting('app.user_id', true)) with check (user_id = current_setting('app.user_id', true))`);
  await db.query(`grant select, insert, update, delete on files to ${APP_ROLE}`);
}

type FileRow = { id: string; name: string; kind: FileKind; size: number; status: FileStatus; pages: number | null; chunks: number | null; note: string | null; created_at: Date | string; object_key: string };
const toRecord = (r: FileRow): FileRecord => ({ id: r.id, name: r.name, kind: r.kind, size: r.size, status: r.status, pages: r.pages, chunks: r.chunks, note: r.note, createdAt: new Date(r.created_at).toISOString() });

/** 存一个上传的文件：内容进对象存储，元数据进 files 表（status 是 uploaded）。返回记录 */
export async function saveUpload(db: Db, store: ObjectStore, userId: string, upload: Upload): Promise<FileRecord> {
  const key = objectKey(userId, upload.bytes);
  await store.put(key, upload.bytes);
  const id = randomUUID();
  const { rows } = await withTenant(db, userId, (tx) =>
    tx.query<FileRow>('insert into files (id, user_id, name, kind, size, object_key) values ($1, $2, $3, $4, $5, $6) returning *', [id, userId, upload.name, upload.kind, upload.bytes.byteLength, key]),
  );
  return toRecord(rows[0]);
}

export async function getFile(db: Db, userId: string, id: string): Promise<(FileRecord & { objectKey: string }) | undefined> {
  const { rows } = await withTenant(db, userId, (tx) => tx.query<FileRow>('select * from files where user_id = $1 and id = $2', [userId, id]));
  return rows[0] && { ...toRecord(rows[0]), objectKey: rows[0].object_key };
}

export async function listFiles(db: Db, userId: string): Promise<FileRecord[]> {
  const { rows } = await withTenant(db, userId, (tx) => tx.query<FileRow>('select * from files where user_id = $1 order by created_at desc', [userId]));
  return rows.map(toRecord);
}

/** 一组块写进 documents 和 chunks（第 46 天的表）。同一个文件重新建索引时先删掉旧的 */
export async function saveChunks(db: Db, userId: string, documentId: string, path: string, chunks: Chunk[], embedder: Embedder): Promise<void> {
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += 32) vectors.push(...(await embedder.embed(chunks.slice(i, i + 32).map(embeddingText))));
  await withTenant(db, userId, async (tx) => {
    await tx.query('delete from documents where user_id = $1 and id = $2', [userId, documentId]);
    await tx.query('insert into documents (id, user_id, path) values ($1, $2, $3)', [documentId, userId, path]);
    for (const [i, c] of chunks.entries()) {
      await tx.query('insert into chunks (id, user_id, document_id, path, heading, text, embedding) values ($1, $2, $3, $4, $5, $6, $7)', [`${documentId}:${c.id}`, userId, documentId, c.path, c.heading, c.text, vectors[i]]);
    }
  });
}

export interface IngestOptions {
  embedder: Embedder;
  /** 读图片用的视觉模型。没有就不能处理图片 */
  vision?: VisionConfig;
  signal?: AbortSignal;
}

/**
 * 给一个文件建索引：
 * 1. 改成 indexing；从对象存储读出内容
 * 2. PDF：按页取文字、pdfToChunks；没有文字的页写进 note（「第 3、4 页没有文字，可能是扫描件」）；一块都没有就失败
 *    图片：describeImage 读出来，整段作为一块，path 是文件名，heading 是「图片」
 * 3. saveChunks（documentId 是 file:文件编号）；改成 ready，记下页数和块数
 * 4. 任何一步出错：改成 failed，错误记在 error 里（不给用户看），note 写一句给用户看的话；不往外抛（这是后台任务，结局记在文件的状态里）
 */
export async function ingestFile(db: Db, store: ObjectStore, userId: string, fileId: string, options: IngestOptions): Promise<FileRecord> {
  const { embedder, vision, signal } = options;
  const file = await getFile(db, userId, fileId);
  if (!file) throw new Error(`没有文件 ${fileId}`);
  const update = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    return withTenant(db, userId, (tx) => tx.query(`update files set ${sets} where user_id = $1 and id = $2`, [userId, fileId, ...keys.map((k) => fields[k])]));
  };
  // TODO 4：按上面注释的四步实现。update({ 字段: 值 }) 已经写好了，会以这个用户的身份更新 files 表。
  // PDF：extractPdfPages → pdfToChunks(file.name, 每页的文字)；note 写「第 3、4 页没有文字，可能是扫描件，这几页的内容查不到」；一块都没有就抛错
  // 图片：没有 vision 就抛错；describeImage(vision, { kind, bytes }, '请读这张图片', signal)，整段是一块：{ id: `${file.name}#image`, path: file.name, heading: '图片', text }
  // 然后 saveChunks(db, userId, `file:${fileId}`, file.name, 块, embedder)，update 成 ready（pages、chunks、note）
  // catch：update 成 failed，error 是错误信息，note 是「这个文件处理失败了，可以换一个文件再试」
  void update; void store; void extractPdfPages; void pdfToChunks; void describeImage; void saveChunks; void embedder; void vision; void signal;
  return (await getFile(db, userId, fileId))!;
}
