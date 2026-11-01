import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { Tool } from '../solution/tool.ts';

const { createFileTools, MAX_READ_CHARS } = await loadTarget<typeof import('../solution/tools/files.ts')>(
  import.meta.url,
  'tools/files.ts',
);
const { createHttpTool } = await loadTarget<typeof import('../solution/tools/http.ts')>(import.meta.url, 'tools/http.ts');

/** 直接执行工具。用 async 包一层，同步抛出的错误也会变成被拒绝的 Promise */
const run = async (tool: Tool, input: unknown) => tool.execute(input, {});

let workspace: string;
let readTool: Tool;
let writeTool: Tool;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'day05-'));
  [readTool, writeTool] = createFileTools(workspace);
});

describe('第 5 天：read_file（TODO 4）', () => {
  test('读取工作目录里的文件，包括子目录里的', async () => {
    await writeFile(join(workspace, 'a.txt'), '第一行\n第二行');
    expect(readTool.name).toBe('read_file');
    expect(await run(readTool, { path: 'a.txt' })).toBe('第一行\n第二行');
    await writeTool.execute({ path: 'notes/b.md', content: '# 笔记' }, {});
    expect(await run(readTool, { path: 'notes/b.md' })).toBe('# 笔记');
  });

  test('不能读工作目录以外的文件', async () => {
    await expect(run(readTool, { path: '../secret.txt' }), '用 ../ 跳出工作目录').rejects.toThrow('工作目录');
    await expect(run(readTool, { path: '/etc/passwd' }), '绝对路径').rejects.toThrow('工作目录');
    await expect(run(readTool, { path: 'notes/../../secret.txt' }), '绕一圈再跳出去').rejects.toThrow('工作目录');
    const sibling = `../${basename(workspace)}-evil/secret.txt`;
    await expect(
      run(readTool, { path: sibling }),
      '名字以工作目录开头的兄弟目录：只用 startsWith(root) 判断会被骗过去',
    ).rejects.toThrow('工作目录');
  });

  test('文件不存在时，错误信息里带上路径', async () => {
    await expect(run(readTool, { path: 'missing.txt' })).rejects.toThrow('missing.txt');
  });

  test('文件太长时截断，并注明总长度', async () => {
    await writeFile(join(workspace, 'big.txt'), '字'.repeat(MAX_READ_CHARS + 500));
    const content = String(await run(readTool, { path: 'big.txt' }));
    expect(content.length, `最多保留 ${MAX_READ_CHARS} 个字符，再加一句说明`).toBeLessThan(MAX_READ_CHARS + 100);
    expect(content, '告诉模型内容被截断了，原文有多长').toContain(String(MAX_READ_CHARS + 500));
  });
});

describe('第 5 天：write_file（TODO 5）', () => {
  test('写入文件，目录不存在时自动创建', async () => {
    expect(writeTool.name).toBe('write_file');
    const message = await run(writeTool, { path: 'out/deep/result.txt', content: '答案是 42' });
    expect(await readFile(join(workspace, 'out/deep/result.txt'), 'utf8')).toBe('答案是 42');
    expect(String(message), '返回一句确认，带上写入的路径').toContain('out/deep/result.txt');
  });

  test('文件已存在时覆盖', async () => {
    await run(writeTool, { path: 'a.txt', content: '旧内容' });
    await run(writeTool, { path: 'a.txt', content: '新内容' });
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('新内容');
  });

  test('不能写到工作目录以外', async () => {
    await expect(run(writeTool, { path: '../evil.txt', content: 'x' })).rejects.toThrow('工作目录');
  });
});

describe('第 5 天：http_request（TODO 6）', () => {
  const received: { method?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, body });
    if (req.url === '/slow') await new Promise((resolve) => setTimeout(resolve, 1000));
    if (req.url === '/missing') res.statusCode = 404;
    res.end(req.url === '/long' ? 'x'.repeat(5000) : `你请求的是 ${req.url}`);
  });
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  beforeEach(() => {
    received.length = 0;
  });

  const http = createHttpTool({ timeoutMs: 200, maxChars: 1000 });

  test('GET 请求：返回状态码和响应内容', async () => {
    expect(http.name).toBe('http_request');
    const result = String(await run(http, { url: `${base}/hello`, method: 'GET', body: null }));
    expect(result).toContain('200');
    expect(result).toContain('你请求的是 /hello');
  });

  test('POST 请求：带上请求体', async () => {
    await run(http, { url: `${base}/api`, method: 'POST', body: '{"name":"潮汐"}' });
    expect(received[0]).toEqual({ method: 'POST', body: '{"name":"潮汐"}' });
  });

  test('404 不算工具出错：照常返回状态码，让模型知道', async () => {
    expect(String(await run(http, { url: `${base}/missing`, method: 'GET', body: null }))).toContain('404');
  });

  test('只允许 http 和 https', async () => {
    await expect(run(http, { url: 'file:///etc/passwd', method: 'GET', body: null })).rejects.toThrow();
  });

  test('超时就报错，错误信息里说明是超时', async () => {
    await expect(run(http, { url: `${base}/slow`, method: 'GET', body: null })).rejects.toThrow('超时');
  });

  test('响应太长时截断', async () => {
    const result = String(await run(http, { url: `${base}/long`, method: 'GET', body: null }));
    expect(result.length).toBeLessThan(1100);
    expect(result).toContain('5000');
  });
});
