import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { FAKE_PNG, makePdf, RELEASE_PDF } from './pdf-fixture.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const up = await loadTarget<typeof import('../solution/uploads.ts')>(import.meta.url, 'uploads.ts');
const { sniffType, safeFileName, objectKey, createFsObjectStore } = up;
const p = await loadTarget<typeof import('../solution/pdf.ts')>(import.meta.url, 'pdf.ts');
const { extractPdfPages, normalizePageText, isTableRow, pdfToChunks, pagePath } = p;
const v = await loadTarget<typeof import('../solution/vision.ts')>(import.meta.url, 'vision.ts');
const { describeImage, toDataUrl, SCREENSHOT_PROMPT } = v;
const ing = await loadTarget<typeof import('../solution/ingest.ts')>(import.meta.url, 'ingest.ts');
const { migrateFiles, saveUpload, ingestFile, listFiles } = ing;
const { startFilesApp, contentDisposition } = await loadTarget<typeof import('../solution/files-server.ts')>(import.meta.url, 'files-server.ts');
const { createPgliteDb, migrate, findUnprotectedTables } = await loadTarget<typeof import('../solution/db.ts')>(import.meta.url, 'db.ts');
const { createUser, issueApiKey } = await loadTarget<typeof import('../solution/auth.ts')>(import.meta.url, 'auth.ts');
const { createTenantRetriever } = await loadTarget<typeof import('../solution/tenant-store.ts')>(import.meta.url, 'tenant-store.ts');
const { createOpenAIEmbedder, embeddingConfigFromEnv } = await loadTarget<typeof import('../solution/rag/embeddings.ts')>(import.meta.url, 'rag/embeddings.ts');
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const embedder = () => createOpenAIEmbedder(embeddingConfigFromEnv());
const vision = () => ({ baseURL: process.env.OPENAI_BASE_URL!, apiKey: process.env.OPENAI_API_KEY!, model: process.env.VISION_MODEL || process.env.OPENAI_MODEL! });
async function world() {
  const db = await createPgliteDb();
  await migrate(db);
  await migrateFiles(db);
  const alice = (await createUser(db, 'alice@example.com', 'pw', { N: 1024, r: 8, p: 1 })).id;
  const bob = (await createUser(db, 'bob@example.com', 'pw', { N: 1024, r: 8, p: 1 })).id;
  const store = createFsObjectStore(await mkdtemp(join(tmpdir(), 'day47-')));
  return { db, alice, bob, store };
}

describe('第 47 天：验文件（TODO 1）', () => {
  test('sniffType：看文件开头，不看名字', () => {
    expect(sniffType(RELEASE_PDF())).toBe('pdf');
    expect(sniffType(FAKE_PNG())).toBe('png');
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpeg');
    expect(sniffType(new Uint8Array([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBPVP8 ')]))).toBe('webp');
    expect(sniffType(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeUndefined();
    expect(sniffType(new Uint8Array([]))).toBeUndefined();
  });

  test('safeFileName 和对象存储的键', async () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\a\\报告 "终版".pdf')).toBe('报告 终版.pdf');
    expect(safeFileName('..')).toBe('file');
    expect(objectKey('u1', new TextEncoder().encode('abc'))).toBe('u1/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const store = createFsObjectStore(await mkdtemp(join(tmpdir(), 'day47-')));
    await store.put('u1/abc', new Uint8Array([1, 2]));
    expect([...(await store.get('u1/abc'))]).toEqual([1, 2]);
    await expect(store.put('../escape', new Uint8Array())).rejects.toThrow('不合法');
  });
});

describe('第 47 天：解析 PDF（TODO 2）', () => {
  test('按页取文字；整理文字；表格的行不打散', async () => {
    const pages = await extractPdfPages(RELEASE_PDF());
    expect(pages).toHaveLength(3);
    expect(pages[1]).toContain('7443');
    expect(normalizePageText('hand-\nshake   takes\n\n\n\none  trip')).toBe('handshake takes\n\none trip');
    expect(normalizePageText('a | b | c   ')).toBe('a | b | c');
    expect(isTableRow('7443 | tide | default')).toBe(true);
    expect(isTableRow('Port    Protocol    Note')).toBe(true);
    expect(isTableRow('普通的一句话')).toBe(false);
  });

  test('pdfToChunks：每块记着页码；空页标出来；表格在同一块里', async () => {
    const { chunks, emptyPages } = pdfToChunks('release.pdf', await extractPdfPages(RELEASE_PDF()));
    expect(emptyPages).toEqual([3]);
    expect(chunks.map((c) => [c.id, c.path, c.heading])).toEqual([
      ['release.pdf#p1-1', 'release.pdf（第 1 页）', '第 1 页'],
      ['release.pdf#p2-1', 'release.pdf（第 2 页）', '第 2 页'],
    ]);
    expect(chunks[1].text).toContain('7443 | tide | default\n7444 | admin | internal');
    expect(pagePath('a.pdf', 9)).toBe('a.pdf（第 9 页）');
    const long = pdfToChunks('long.pdf', [Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'word '.repeat(20)}`).join('\n\n')], { maxChars: 300 });
    expect(long.chunks.length).toBeGreaterThan(3);
    expect(long.chunks.every((c) => c.text.length <= 300)).toBe(true);
  });
});

describeMock('第 47 天：读图片（TODO 3）', () => {
  test('describeImage：图片用 data URL 放在 user 消息里，文字在前', async () => {
    llm.reply({ content: '## 图片内容\n终端里的报错\n## 文字\nTIDE_E2077 handshake timeout' });
    const r = await describeImage(vision(), { kind: 'png', bytes: FAKE_PNG() }, '这是什么错误？');
    expect(r.text).toContain('TIDE_E2077');
    const [system, user] = llm.requests[0].messages as { role: string; content: unknown }[];
    expect(system).toEqual({ role: 'system', content: SCREENSHOT_PROMPT });
    expect(user.content).toEqual([
      { type: 'text', text: '这是什么错误？' },
      { type: 'image_url', image_url: { url: toDataUrl('png', FAKE_PNG()) } },
    ]);
    expect(toDataUrl('png', new Uint8Array([1, 2, 3]))).toBe('data:image/png;base64,AQID');
    llm.fail({ status: 429, message: '慢点' });
    await expect(describeImage(vision(), { kind: 'png', bytes: FAKE_PNG() })).rejects.toMatchObject({ name: 'ModelError', status: 429 });
  });
});

describeMock('第 47 天：后台建索引（TODO 4）', () => {
  test('PDF：ready，记下页数、块数和空页；只有自己检索得到', async () => {
    const { db, alice, bob, store } = await world();
    expect(await findUnprotectedTables(db), 'files 表也开了 RLS').toEqual([]);
    const file = await saveUpload(db, store, alice, { name: 'release.pdf', kind: 'pdf', bytes: RELEASE_PDF() });
    expect(file).toMatchObject({ status: 'uploaded', kind: 'pdf', name: 'release.pdf' });
    const done = await ingestFile(db, store, alice, file.id, { embedder: embedder() });
    expect(done).toMatchObject({ status: 'ready', pages: 3, chunks: 2 });
    expect(done.note).toContain('第 3 页');
    const hits = await createTenantRetriever(db, alice, embedder()).search('default port 7443', { k: 1 });
    expect(hits[0].chunk.path).toBe('release.pdf（第 2 页）');
    expect(await createTenantRetriever(db, bob, embedder()).search('default port 7443')).toEqual([]);
    expect(await listFiles(db, bob)).toEqual([]);
    await db.close();
  });

  test('图片：视觉模型读出来的文字进索引；没有视觉模型、坏的 PDF 都是 failed', async () => {
    const { db, alice, store } = await world();
    llm.reply({ content: '## 文字\nTIDE_E2077 handshake timeout on port 7443' });
    const png = await saveUpload(db, store, alice, { name: 'error.png', kind: 'png', bytes: FAKE_PNG() });
    expect(await ingestFile(db, store, alice, png.id, { embedder: embedder(), vision: vision() })).toMatchObject({ status: 'ready', pages: 1, chunks: 1 });
    expect((await createTenantRetriever(db, alice, embedder()).search('TIDE_E2077', { mode: 'keyword' }))[0].chunk).toMatchObject({ path: 'error.png', heading: '图片' });
    const noVision = await saveUpload(db, store, alice, { name: 'b.png', kind: 'png', bytes: new Uint8Array([...FAKE_PNG(), 9]) });
    expect(await ingestFile(db, store, alice, noVision.id, { embedder: embedder() })).toMatchObject({ status: 'failed', note: '这个文件处理失败了，可以换一个文件再试' });
    const blank = await saveUpload(db, store, alice, { name: 'scan.pdf', kind: 'pdf', bytes: makePdf([[], []]) });
    expect((await ingestFile(db, store, alice, blank.id, { embedder: embedder() })).status, '整个都是扫描件').toBe('failed');
    await db.close();
  });
});

describeMock('第 47 天：文件的接口和引用到页码（TODO 5）', () => {
  async function start() {
    const w = await world();
    const app = await startFilesApp({ db: w.db, store: w.store, embedder: embedder(), vision: vision(), maxBytes: 1024 * 1024 });
    const keys = { alice: await issueApiKey(w.db, w.alice), bob: await issueApiKey(w.db, w.bob) };
    const upload = (bytes: Uint8Array, name: string, key = keys.alice, field = 'file') => {
      const form = new FormData();
      form.append(field, new Blob([bytes]), name);
      return fetch(`${app.url}/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
    };
    const get = (path: string, key = keys.alice) => fetch(`${app.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
    return { ...w, app, keys, upload, get };
  }

  test('上传、查状态、下载；伪装的文件和太大的文件被拒绝；别人的文件 404', async () => {
    const s = await start();
    try {
      const res = await s.upload(RELEASE_PDF(), '发布说明.pdf');
      expect(res.status).toBe(202);
      const file = (await res.json()) as { id: string; status: string };
      expect(file.status).toBe('uploaded');
      await s.app.idle();
      expect(await (await s.get(`/v1/files/${file.id}`)).json()).toMatchObject({ status: 'ready', pages: 3, name: '发布说明.pdf' });
      const download = await s.get(`/v1/files/${file.id}/content`);
      expect(download.headers.get('content-type')).toBe('application/pdf');
      expect(download.headers.get('x-content-type-options')).toBe('nosniff');
      expect(download.headers.get('content-disposition')).toBe(contentDisposition('发布说明.pdf'));
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(RELEASE_PDF());
      expect((await s.get(`/v1/files/${file.id}`, s.keys.bob)).status).toBe(404);
      expect((await s.get(`/v1/files/${file.id}/content`, s.keys.bob)).status).toBe(404);
      expect(await (await s.get('/v1/files', s.keys.bob)).json()).toEqual([]);

      expect((await s.upload(new TextEncoder().encode('<html>hi</html>'), 'cat.png')).status, '名字叫 png，其实是 HTML').toBe(415);
      expect((await s.upload(new Uint8Array(2 * 1024 * 1024), 'big.pdf')).status).toBe(413);
      expect((await s.upload(RELEASE_PDF(), 'a.pdf', s.keys.alice, 'document')).status, '字段名不对').toBe(400);
      expect((await fetch(`${s.app.url}/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${s.keys.alice}`, 'content-type': 'application/pdf' }, body: RELEASE_PDF() })).status).toBe(415);
      expect((await s.get('/v1/files', 'ra_wrong')).status).toBe(401);
    } finally {
      await s.app.close();
      await s.db.close();
    }
  });

  test('研究助手回答时引用到具体页码', async () => {
    const s = await start();
    try {
      const { id } = (await (await s.upload(RELEASE_PDF(), 'release.pdf')).json()) as { id: string };
      await s.app.idle();
      expect(id).toBeTruthy();
      llm.reply({ toolCalls: [{ name: 'search_docs', arguments: { query: 'default port' } }] }).reply({ content: '3.0 的默认端口是 7443 [1]。' });
      const setup = await makeSetup(import.meta.url, fixture);
      const r = await research('我上传的发布说明里，默认端口是多少？', { ...setup, docs: { root: '/nonexistent', retriever: createTenantRetriever(s.db, s.alice, embedder()) } }, { model: createModel('openai') });
      expect(r.report.ok).toBe(true);
      expect(r.text).toContain('[1] 本地文档 release.pdf（第 2 页）');
    } finally {
      await s.app.close();
      await s.db.close();
    }
  });
});

describeE2E('第 47 天：真实模型读 PDF', () => {
  test('回答引用到第 2 页', { timeout: 300_000 }, async () => {
    const { db, alice, store } = await world();
    const file = await saveUpload(db, store, alice, { name: 'release.pdf', kind: 'pdf', bytes: RELEASE_PDF() });
    await ingestFile(db, store, alice, file.id, { embedder: embedder() });
    const setup = await makeSetup(import.meta.url, fixture);
    const r = await research('查一下我上传的 release.pdf：潮汐 3.0 的默认端口是多少？', { ...setup, search: undefined, docs: { root: '/nonexistent', retriever: createTenantRetriever(db, alice, embedder()) } }, { model: createModel('openai') });
    console.log(r.text);
    expect(r.answer).toContain('7443');
    expect(r.text).toContain('第 2 页');
    await db.close();
  });
});
