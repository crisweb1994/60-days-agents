import { cp, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const df = await loadTarget<typeof import('../solution/diff.ts')>(import.meta.url, 'diff.ts');
const { parseDiff, commentableLines, formatRanges, renderFileDiff, describeFile, isGenerated, reviewableFiles } = df;
const { createRepo, MAX_LINES } = await loadTarget<typeof import('../solution/repo.ts')>(import.meta.url, 'repo.ts');
const { createDraft, createReviewTools, REVIEW_POLICY } = await loadTarget<typeof import('../solution/tools.ts')>(import.meta.url, 'tools.ts');
const { toMcpServer, createReviewSession } = await loadTarget<typeof import('../solution/mcp-server.ts')>(import.meta.url, 'mcp-server.ts');
const { runToolCall, defineTool } = await loadTarget<typeof import('../solution/core/tool.ts')>(import.meta.url, 'core/tool.ts');

const REPO = fileURLToPath(new URL('../data/repo', import.meta.url));
const CASES = Object.fromEntries(
  (await readFile(new URL('../data/review.jsonl', import.meta.url), 'utf8'))
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('//'))
    .map((l) => JSON.parse(l))
    .map((c) => [c.id, c]),
) as Record<string, { input: { diff: string }; expected: any }>;
const diffOf = (id: string) => CASES[id].input.diff;
type Tool = import('../solution/core/tool.ts').Tool;
const call = (tools: Tool[], name: string, args: unknown) => runToolCall(tools, { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }, { policy: REVIEW_POLICY });

describe('第 53 天：解析 diff（TODO 1）', () => {
  test('新文件：全是加的行，行号从 1 开始', () => {
    const [file] = parseDiff(diffOf('sql-injection'));
    expect(file).toMatchObject({ path: 'src/routes/search.ts', status: 'added', binary: false, additions: 8, deletions: 0 });
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 8, section: '' });
    expect(file.hunks[0].lines[6]).toEqual({ type: 'add', text: "  return db.query(`select id, title from todos where owner = '${user.id}' and title like '%${keyword}%'`);", newLine: 7 });
  });

  test('修改：上下文、删除、新增各自的行号', () => {
    const [file] = parseDiff(diffOf('missing-auth'));
    expect(file).toMatchObject({ path: 'src/routes/admin.ts', status: 'modified', additions: 2, deletions: 3 });
    const lines = file.hunks[0].lines;
    expect(lines[0]).toEqual({ type: 'context', text: "import { requireAdmin } from '../auth.ts';", oldLine: 2, newLine: 2 });
    expect(lines.filter((l) => l.type === 'del').map((l) => l.oldLine)).toEqual([5, 6, 7]);
    expect(lines.filter((l) => l.type === 'add').map((l) => l.newLine)).toEqual([5, 6]);
    expect(lines.at(-1)).toMatchObject({ type: 'context', oldLine: 10, newLine: 9 });
    expect(lines[2], '只有一个空格的空行是 context').toEqual({ type: 'context', text: '', oldLine: 4, newLine: 4 });
  });

  test('多个文件、空的 diff', () => {
    expect(parseDiff(diffOf('multi-file')).map((f) => [f.path, f.status])).toEqual([
      ['src/utils/format.ts', 'modified'],
      ['src/routes/search.ts', 'added'],
      ['docs/api.md', 'modified'],
    ]);
    expect(parseDiff('')).toEqual([]);
  });

  test('删除、改名、二进制、没写行数的 hunk、\\ No newline、被去掉空格的空行、\\r\\n', () => {
    const text = [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '\\ No newline at end of file',
      'diff --git a/a.ts b/b.ts',
      'similarity index 90%',
      'rename from a.ts',
      'rename to b.ts',
      '--- a/a.ts',
      '+++ b/b.ts',
      '@@ -1,3 +1,3 @@ export function f() {',
      ' one',
      '',
      '-three',
      '+THREE',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\r\n');
    const [deleted, renamed, binary] = parseDiff(text);
    expect(deleted).toMatchObject({ path: 'old.txt', status: 'deleted', deletions: 1, additions: 0 });
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
    expect(renamed).toMatchObject({ path: 'b.ts', oldPath: 'a.ts', status: 'renamed', additions: 1, deletions: 1 });
    expect(renamed.hunks[0].section).toBe('export function f() {');
    expect(renamed.hunks[0].lines.map((l) => [l.type, l.text, l.newLine ?? null])).toEqual([
      ['context', 'one', 1],
      ['context', '', 2],
      ['del', 'three', null],
      ['add', 'THREE', 3],
    ]);
    expect(binary).toMatchObject({ path: 'logo.png', binary: true, hunks: [] });
  });
});

describe('第 53 天：能评论的行、给模型看的 diff（TODO 2）', () => {
  test('commentableLines：加的行和上下文，不含删掉的', () => {
    const [admin] = parseDiff(diffOf('missing-auth'));
    expect([...commentableLines(admin)].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(formatRanges([9, 1, 2, 3, 5, 7, 8, 8])).toBe('1–3、5、7–9');
  });

  test('renderFileDiff：新行号右对齐 5 位，删掉的行没有行号', () => {
    const [file] = parseDiff(diffOf('off-by-one'));
    expect(renderFileDiff(file)).toBe(
      [
        'src/utils/paginate.ts（修改，+2 −2）',
        '@@ -1,5 +1,5 @@',
        '    1  /** 第 page 页（从 1 开始），每页 size 条 */',
        '    2  export function paginate<T>(items: T[], page: number, size: number): T[] {',
        '      -  const start = (page - 1) * size;',
        '      -  return items.slice(start, start + size);',
        '    3 +  const first = Math.max(0, (page - 1) * size);',
        '    4 +  return items.slice(first, first + size - 1);',
        '    5  }',
      ].join('\n'),
    );
  });

  test('describeFile、生成的文件跳过', () => {
    const [lock] = parseDiff(diffOf('lockfile-only'));
    expect(describeFile(lock)).toBe('package-lock.json（修改，+3 −3）');
    expect(isGenerated('package-lock.json')).toBe(true);
    expect(isGenerated('web/dist/app.js')).toBe(true);
    expect(isGenerated('src/distance.ts')).toBe(false);
    const { review, skipped } = reviewableFiles([...parseDiff(diffOf('lockfile-only')), ...parseDiff(diffOf('docs-only'))]);
    expect(review.map((f) => f.path)).toEqual(['docs/api.md']);
    expect(skipped.map((f) => f.path)).toEqual(['package-lock.json']);
  });
});

describe('第 53 天：读仓库（TODO 3）', () => {
  const repo = createRepo(REPO);

  test('readLines：带行号；可以只读一段；超出范围报错', async () => {
    const all = await repo.readLines('src/auth.ts');
    expect(all).toMatchObject({ path: 'src/auth.ts', start: 1, end: 18, total: 18 });
    expect(all.text.split('\n')[6]).toBe(' 7 | export function requireUser(req: IncomingMessage): User {');
    const part = await repo.readLines('src/auth.ts', 13, 15);
    expect(part.text).toBe(['13 | /** 只有管理员能调用的接口用它 */', '14 | export function requireAdmin(req: IncomingMessage): User {', '15 |   const user = requireUser(req);'].join('\n'));
    await expect(repo.readLines('src/auth.ts', 30)).rejects.toThrow('只有 18 行');
    expect((await repo.readLines('src/auth.ts', 10, 999)).end).toBe(18);
  });

  test('路径和软链接都不能跑到仓库外面；目录、不存在、太大的文件报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'day53-'));
    const root = join(dir, 'repo');
    await cp(REPO, root, { recursive: true });
    await writeFile(join(dir, 'secret.txt'), 'TOKEN=abc');
    await symlink(join(dir, 'secret.txt'), join(root, 'innocent.ts'));
    await writeFile(join(root, 'big.json'), 'x'.repeat(300 * 1024));
    const r = createRepo(root);
    await expect(r.readLines('../secret.txt')).rejects.toThrow('在仓库之外');
    await expect(r.readLines('/etc/hosts')).rejects.toThrow('在仓库之外');
    await expect(r.readLines('innocent.ts'), 'PR 里可以提交指向外面的软链接').rejects.toThrow('指向仓库之外');
    await expect(r.readLines('src')).rejects.toThrow('是目录');
    await expect(r.readLines('nope.ts')).rejects.toThrow('仓库里没有 nope.ts');
    await expect(r.readLines('big.json')).rejects.toThrow('太大了');
  });

  test('一次最多读 MAX_LINES 行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'day53-'));
    await writeFile(join(dir, 'long.ts'), Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n'));
    const r = createRepo(dir);
    expect(await r.readLines('long.ts')).toMatchObject({ start: 1, end: MAX_LINES, total: 450 });
    expect(await r.readLines('long.ts', 401, 1000)).toMatchObject({ start: 401, end: 450 });
    expect((await r.readLines('long.ts', 1, 1000)).end).toBe(MAX_LINES);
  });

  test('search：不分大小写，按路径和行号排；listFiles 跳过 node_modules', async () => {
    const hits = await repo.search('REQUIREADMIN');
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual(['src/auth.ts:14', 'src/routes/admin.ts:2', 'src/routes/admin.ts:10']);
    expect(hits[0].text).toBe('export function requireAdmin(req: IncomingMessage): User {');
    expect(await repo.search('一个不存在的词')).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'day53-'));
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'needle');
    await writeFile(join(dir, 'a.ts'), 'needle');
    expect(await createRepo(dir).listFiles()).toEqual(['a.ts']);
  });
});

describe('第 53 天：审查工具和草稿（TODO 4）', () => {
  const setup = (id: string) => {
    const { review, skipped } = reviewableFiles(parseDiff(diffOf(id)));
    const draft = createDraft(review);
    return { draft, tools: createReviewTools({ files: review, skipped, repo: createRepo(REPO), draft }) };
  };

  test('五个工具，名字和顺序固定；没有策略时 add_comment 不会执行', async () => {
    const { tools } = setup('sql-injection');
    expect(tools.map((t) => t.name)).toEqual(['list_changed_files', 'read_diff', 'read_file', 'search_code', 'add_comment']);
    const args = { file: 'src/routes/search.ts', line: 7, severity: 'high', kind: 'security', body: 'keyword 拼进了 SQL，改用参数化查询' };
    const denied = await runToolCall(tools, { id: 'c1', type: 'function', function: { name: 'add_comment', arguments: JSON.stringify(args) } });
    expect(denied.isError, '可写的工具，没人确认就不执行').toBe(true);
  });

  test('add_comment：行号要在 diff 里；同一行同一类不重复；错误信息告诉模型怎么改', async () => {
    const { tools, draft } = setup('missing-auth');
    const ok = await call(tools, 'add_comment', { file: 'src/routes/admin.ts', line: 6, severity: 'high', kind: 'security', body: '  删掉了 requireAdmin：任何登录的用户都能列出所有人的邮箱。  ' });
    expect(ok).toEqual({ content: '已加入草稿（第 1 条）', isError: false });
    expect(draft.comments[0].body, '去掉首尾空白').toBe('删掉了 requireAdmin：任何登录的用户都能列出所有人的邮箱。');
    const outside = await call(tools, 'add_comment', { file: 'src/routes/admin.ts', line: 12, severity: 'low', kind: 'bug', body: '这一行不在 diff 里，不能评论' });
    expect(outside.isError).toBe(true);
    expect(outside.content).toContain('第 12 行不在 src/routes/admin.ts 的 diff 里，能评论的行：2–9');
    const dup = await call(tools, 'add_comment', { file: 'src/routes/admin.ts', line: 6, severity: 'medium', kind: 'security', body: '同一行同一类的评论又来一条' });
    expect(dup.content).toContain('已经有一条 security 的评论了');
    const other = await call(tools, 'add_comment', { file: 'src/db.ts', line: 1, severity: 'low', kind: 'bug', body: '没有改动的文件不能评论' });
    expect(other.content).toContain('src/db.ts 不在这次的改动里。改动的文件：src/routes/admin.ts');
    const short = await call(tools, 'add_comment', { file: 'src/routes/admin.ts', line: 5, severity: 'low', kind: 'bug', body: '不好' });
    expect(short.content, 'schema 校验').toContain('评论太短了');
    expect(draft.comments).toHaveLength(1);
  });

  test('其余四个工具', async () => {
    const { tools } = setup('lockfile-only');
    expect((await call(tools, 'list_changed_files', {})).content).toBe('不审：package-lock.json（生成的或者删掉的文件）');
    const multi = setup('multi-file').tools;
    expect((await call(multi, 'list_changed_files', {})).content).toBe(['- src/utils/format.ts（修改，+4 −4）', '- src/routes/search.ts（新增，+8 −0）', '- docs/api.md（修改，+6 −2）'].join('\n'));
    expect((await call(multi, 'read_diff', { path: 'src/routes/search.ts' })).content).toContain("    7 +  return db.query(`select id, title from todos where owner = '${user.id}'");
    expect((await call(multi, 'read_diff', { path: 'src/db.ts' })).isError).toBe(true);
    const file = await call(multi, 'read_file', { path: 'src/db.ts', start: 1, end: 2 });
    expect(file.content).toBe("src/db.ts 第 1–2 行：\n1 | // 数据库连接。query 的第二个参数是参数化查询的值：永远不要把用户输入拼进 SQL\n2 | import pg from 'pg';\n（共 11 行，还没读完，用 start=3 接着读）");
    expect((await call(multi, 'read_file', { path: '../../package.json' })).content).toContain('在仓库之外');
    expect((await call(multi, 'search_code', { query: 'ilike' })).content).toBe("src/routes/todos.ts:14: return db.query('select id, title from todos where owner = $1 and title ilike $2', [user.id, `%${keyword}%`]);");
  });

  test('read_diff 太长时分页', async () => {
    const big = Array.from({ length: 600 }, (_, i) => `+const x${i} = ${i};`).join('\n');
    const files = parseDiff(`diff --git a/big.ts b/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,600 @@\n${big}\n`);
    const tools = createReviewTools({ files, repo: createRepo(REPO), draft: createDraft(files), diffPageSize: 4000 });
    const first = await call(tools, 'read_diff', { path: 'big.ts' });
    expect(first.content).toMatch(/（第 1\/\d+ 页。用 page=2 读下一页）$/);
    expect((await call(tools, 'read_diff', { path: 'big.ts', page: 2 })).content).toContain('第 2/');
  });
});

describe('第 53 天：MCP 服务器（TODO 5）', () => {
  /** 不起端口：客户端的 fetch 直接交给 MCP 的 handler */
  async function connect(server: () => import('@modelcontextprotocol/server').McpServer) {
    const handler = createMcpHandler(server);
    const client = new Client({ name: 'day53-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    return client;
  }

  test('toMcpServer：工具按顺序列出，带着 schema 和注解；出错返回 isError', async () => {
    const tools = [
      defineTool({ name: 'echo', description: '原样返回', schema: (await import('zod')).z.object({ text: (await import('zod')).z.string() }), execute: ({ text }) => text }),
      defineTool({ name: 'boom', description: '总是出错', schema: (await import('zod')).z.object({}), risk: 'irreversible', execute: () => { throw new Error('坏了'); } }),
    ];
    const client = await connect(() => toMcpServer(tools));
    try {
      const { tools: listed } = await client.listTools();
      expect(listed.map((t) => [t.name, t.annotations?.readOnlyHint, t.annotations?.destructiveHint])).toEqual([
        ['echo', true, false],
        ['boom', false, true],
      ]);
      expect(listed[0].inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });
      const ok: any = await client.callTool({ name: 'echo', arguments: { text: '你好' } });
      expect(ok.content).toEqual([{ type: 'text', text: '你好' }]);
      expect(ok.isError).toBeFalsy();
      const bad: any = await client.callTool({ name: 'boom', arguments: {} });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain('坏了');
    } finally {
      await client.close();
    }
  });

  test('review-bot 的服务器：每个请求新建服务器，草稿还在', async () => {
    const session = createReviewSession(REPO, diffOf('sql-injection'));
    const client = await connect(session.server);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['list_changed_files', 'read_diff', 'read_file', 'search_code', 'add_comment']);
      const res: any = await client.callTool({ name: 'add_comment', arguments: { file: 'src/routes/search.ts', line: 7, severity: 'high', kind: 'security', body: 'keyword 直接拼进了 SQL，有注入风险。改用参数化查询。' } });
      expect(res.content[0].text).toBe('已加入草稿（第 1 条）');
      expect(session.draft.comments).toMatchObject([{ file: 'src/routes/search.ts', line: 7 }]);
    } finally {
      await client.close();
    }
  });
});
