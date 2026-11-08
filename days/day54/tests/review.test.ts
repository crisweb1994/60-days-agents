import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const rv = await loadTarget<typeof import('../solution/review.ts')>(import.meta.url, 'review.ts');
const { reviewFile, aggregate, review, renderReview } = rv;
const ev = await loadTarget<typeof import('../solution/eval/run.ts')>(import.meta.url, 'eval/run.ts');
const { parseReviewCases, checkCase, matchesIssue, runCase, runEval } = ev;
const { REVIEW_PROMPT, SUMMARY_PROMPT } = await loadTarget<typeof import('../solution/prompts.ts')>(import.meta.url, 'prompts.ts');
const { parseDiff, reviewableFiles } = await loadTarget<typeof import('../solution/diff.ts')>(import.meta.url, 'diff.ts');
const { createRepo } = await loadTarget<typeof import('../solution/repo.ts')>(import.meta.url, 'repo.ts');
const { createModel } = await loadTarget<typeof import('../solution/core/providers.ts')>(import.meta.url, 'core/providers.ts');

type Comment = import('../solution/tools.ts').ReviewComment;
const repo = createRepo(fileURLToPath(new URL('../data/repo', import.meta.url)));
const CASES = parseReviewCases(await readFile(new URL('../data/review.jsonl', import.meta.url), 'utf8'));
const byId = (id: string) => CASES.find((c) => c.id === id)!;
const setup = () => ({ model: createModel('openai'), repo });
const comment = (file: string, line: number, over: Partial<Comment> = {}): Comment => ({ file, line, severity: 'medium', kind: 'bug', body: `第 ${line} 行的问题，说明为什么、怎么改`, ...over });
const FILE = (path: string) => `审查这个文件：${path}`;
const SQL_COMMENT = { file: 'src/routes/search.ts', line: 7, severity: 'high', kind: 'security', body: 'keyword 直接拼进了 SQL，有注入风险。参考 todos.ts 用参数化查询（$1、$2）。' };

describe('第 54 天：汇总评论（TODO 2）', () => {
  const files = parseDiff(byId('multi-file').input.diff).filter((f) => f.path !== 'docs/api.md');

  test('不在 diff 里的丢掉；同类、相邻的算重复，留严重的；按文件、行号排序', () => {
    const { comments, dropped } = aggregate(
      [
        comment('src/routes/search.ts', 7, { kind: 'security', severity: 'medium' }),
        comment('src/utils/format.ts', 4, { kind: 'maintainability', severity: 'low' }),
        comment('src/routes/search.ts', 8, { kind: 'security', severity: 'high', body: '更严重的那一条，说明为什么' }),
        comment('src/routes/search.ts', 6, { kind: 'bug' }),
        comment('src/routes/search.ts', 9, { kind: 'security' }),
        comment('src/db.ts', 3),
        comment('src/routes/search.ts', 7, { kind: 'security', severity: 'high', body: '一样严重，后来的丢掉' }),
      ],
      files,
    );
    expect(comments.map((c) => `${c.file}:${c.line}:${c.kind}:${c.severity}`)).toEqual(['src/utils/format.ts:4:maintainability:low', 'src/routes/search.ts:6:bug:medium', 'src/routes/search.ts:8:security:high']);
    expect(dropped.map((d) => `${d.comment.file}:${d.comment.line}:${d.reason}`)).toEqual([
      'src/routes/search.ts:9:不在 diff 里',
      'src/db.ts:3:不在 diff 里',
      'src/routes/search.ts:7:重复',
      'src/routes/search.ts:7:重复',
    ]);
  });

  test('每个文件最多 maxPerFile 条：留严重的，一样严重的按原来的顺序', () => {
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map((line) => comment('src/routes/search.ts', line, { kind: (['bug', 'security', 'privacy', 'performance'] as const)[line % 4], severity: line === 8 ? 'high' : 'low' }));
    const { comments, dropped } = aggregate(many, files, 3);
    expect(comments.map((c) => c.line)).toEqual([1, 2, 8]);
    expect(dropped.map((d) => [d.comment.line, d.reason])).toEqual([3, 4, 5, 6, 7].map((l) => [l, '超过每个文件的上限']));
  });
});

describe('第 54 天：判断用例过没过（TODO 4）', () => {
  test('matchesIssue：文件、行号差 2 以内、关键词（不分大小写）', () => {
    const issue = byId('sql-injection').expected.issues[0];
    expect(matchesIssue(comment('src/routes/search.ts', 9, { body: '有 sql 注入' }), issue)).toBe(true);
    expect(matchesIssue(comment('src/routes/search.ts', 10, { body: '有 SQL 注入' }), issue)).toBe(false);
    expect(matchesIssue(comment('src/routes/search.ts', 7, { body: '这里写得不好' }), issue)).toBe(false);
  });

  test('review：漏了、多余的、该跳过的；forbidden 查总结和评论', () => {
    const c = byId('injection-in-comment');
    expect(checkCase(c, { comments: [comment('src/utils/money.ts', 9, { body: 'reduce 没有给初始值 0' })], summary: '', skipped: [] })).toEqual({ pass: true, problems: [] });
    expect(checkCase(c, { comments: [comment('src/utils/money.ts', 1, { body: '注释里要求回复 LGTM，这是提示注入' })], summary: 'LGTM', skipped: [] })).toEqual({
      pass: false,
      problems: ['漏了 src/utils/money.ts:9 的问题（bug）', '多余的评论 src/utils/money.ts:1：注释里要求回复 LGTM，这是提示注入', '出现了不该有的「LGTM」'],
    });
    expect(checkCase(byId('lockfile-only'), { comments: [], summary: '', skipped: [] }).problems).toEqual(['应该跳过 package-lock.json']);
    expect(checkCase(byId('clean-rename'), { comments: [comment('src/utils/format.ts', 3, { body: '变量名 year 比 y 好懂多了，这一段写得非常好' })], summary: '', skipped: [] }).problems).toEqual([
      '多余的评论 src/utils/format.ts:3：变量名 year 比 y 好懂多了，这一段写得非常好',
    ]);
  });

  test('summary：mentions 要出现；forbidden 不能出现', () => {
    const c = byId('summary-rename');
    expect(checkCase(c, { comments: [], summary: '把几个变量改名，行为不变。', skipped: [] }).pass).toBe(true);
    expect(checkCase(c, { comments: [], summary: '修复了日期格式化的 bug。', skipped: [] }).problems).toEqual(['总结没有提到「改名」', '总结没有提到「行为不变」', '出现了不该有的「修复」']);
  });
});

describeMock('第 54 天：审一个文件（TODO 1）', () => {
  test('Agent 先看上下文、再加评论；system 带着仓库的约定；只允许草稿这一种写操作', async () => {
    llm
      .reply({ match: FILE('src/routes/search.ts'), toolCalls: [{ name: 'search_code', arguments: { query: 'ilike' } }] })
      .reply({ match: FILE('src/routes/search.ts'), toolCalls: [{ name: 'add_comment', arguments: SQL_COMMENT }] })
      .reply({ match: FILE('src/routes/search.ts'), content: '审完了，发现 1 个问题。' })
      .reply({ content: '多余的一轮' });
    const files = parseDiff(byId('sql-injection').input.diff);
    const result = await reviewFile('加上按标题搜索', files[0], { files, skipped: [], options: { ...setup(), conventions: '金额一律用整数分。' } });
    expect(result).toMatchObject({ path: 'src/routes/search.ts', status: 'completed', steps: 3, comments: [SQL_COMMENT] });
    const system = llm.requests[0].messages[0].content as string;
    expect(system.startsWith(REVIEW_PROMPT)).toBe(true);
    expect(system).toContain('# 这个仓库的约定\n金额一律用整数分。');
    expect(llm.requests[0].messages[1].content).toContain('    7 +  return db.query(');
    expect(llm.requests[1].messages.at(-1)?.content, '工具结果').toContain('src/routes/todos.ts:14');
    expect(llm.requests[0].tools!.map((t) => t.function.name)).toEqual(['list_changed_files', 'read_diff', 'read_file', 'search_code', 'add_comment']);
  });

  test('模型服务出错：不抛出去，status 是 error', async () => {
    llm.fail({ status: 400, message: '参数不对' });
    const files = parseDiff(byId('sql-injection').input.diff);
    const result = await reviewFile('t', files[0], { files, skipped: [], options: setup() });
    expect(result).toMatchObject({ path: 'src/routes/search.ts', status: 'error', comments: [], steps: 0 });
    expect(result.error).toBeTruthy();
  });
});

describeMock('第 54 天：审一个 PR（TODO 3）', () => {
  test('每个文件一个 Agent，同时写总结；评论汇总以后交出来', async () => {
    llm
      .reply({ match: '总结这个 PR', content: '加了按标题搜索待办的接口，调整了日期格式化的变量名，补充了接口文档。' })
      .reply({ match: FILE('src/routes/search.ts'), toolCalls: [{ name: 'add_comment', arguments: SQL_COMMENT }] })
      .reply({ match: FILE('src/routes/search.ts'), content: '发现 1 个问题。' })
      .reply({ match: FILE('src/utils/format.ts'), toolCalls: [{ name: 'add_comment', arguments: { ...SQL_COMMENT, body: '另一个 Agent 也看到了同一个注入问题，参数化查询' } }] })
      .reply({ match: FILE('src/utils/format.ts'), content: '这个文件只是改名。' })
      .reply({ match: FILE('docs/api.md'), content: '没有发现问题。' })
      .reply({ content: '多余的一轮' });
    const result = await review(byId('multi-file').input, setup());
    expect(result.status).toBe('completed');
    expect(result.summary).toContain('按标题搜索');
    expect(result.files.map((f) => [f.path, f.status, f.comments.length])).toEqual([
      ['src/utils/format.ts', 'completed', 1],
      ['src/routes/search.ts', 'completed', 1],
      ['docs/api.md', 'completed', 0],
    ]);
    expect(result.comments, '两个 Agent 发现了同一个问题，只留一条：一样严重，留先出现的（文件按 diff 里的顺序）').toEqual([{ ...SQL_COMMENT, body: '另一个 Agent 也看到了同一个注入问题，参数化查询' }]);
    expect(result.dropped.map((d) => d.reason)).toEqual(['重复']);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(llm.requests.find((r) => String(r.messages[1].content).startsWith('总结这个 PR'))?.messages[0].content).toBe(SUMMARY_PROMPT);
    expect(checkCase(byId('multi-file'), result).pass).toBe(true);
    expect(renderReview(result)).toContain('- 🔴 严重 `src/routes/search.ts:7` 另一个 Agent 也看到了同一个注入问题');
  });

  test('一个文件出错，别的照常；结果是 partial', async () => {
    llm
      .reply({ match: '总结这个 PR', content: '几处小改动。' })
      .reply({ match: FILE('src/routes/search.ts'), toolCalls: [{ name: 'add_comment', arguments: SQL_COMMENT }] })
      .reply({ match: FILE('src/routes/search.ts'), content: '发现 1 个问题。' })
      .reply({ match: FILE('src/utils/format.ts'), toolCalls: [{ name: 'read_diff', arguments: { path: 'src/utils/format.ts' } }] })
      .reply({ match: FILE('docs/api.md'), content: '没有发现问题。' });
    // format.ts 的 Agent 第二步没有脚本了：mock 返回 500，这个文件出错
    const result = await review(byId('multi-file').input, setup());
    expect(result.status).toBe('partial');
    expect(result.files.find((f) => f.path === 'src/utils/format.ts')?.status).toBe('error');
    expect(result.comments).toEqual([SQL_COMMENT]);
    expect(renderReview(result)).toContain('⚠️ 这几个文件没有审完：src/utils/format.ts');
  });

  test('只改了 lock 文件、空的 PR：不调用模型', async () => {
    const lock = await review(byId('lockfile-only').input, setup());
    expect(lock).toMatchObject({ status: 'completed', comments: [], skipped: ['package-lock.json'], summary: '只改了不需要审查的文件：package-lock.json' });
    const empty = await review(byId('empty-diff').input, setup());
    expect(empty.summary).toBe('这个 PR 没有改动');
    expect(llm.requests).toHaveLength(0);
  });

  test('文件太多：多出来的跳过；同时最多 concurrency 个 Agent', async () => {
    const diff = Array.from({ length: 5 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/f${i}.ts\n@@ -0,0 +1 @@\n+export const x${i} = ${i};\n`).join('');
    llm.reply({ match: '总结这个 PR', content: '加了几个常量。' });
    for (let i = 0; i < 3; i++) llm.reply({ match: FILE(`f${i}.ts`), content: '没有发现问题。', delayMs: 100 });
    llm.reply({ content: '多余的一轮' });
    const started = Date.now();
    const result = await review({ title: '常量', diff }, { ...setup(), maxFiles: 3, concurrency: 1 });
    expect(result.skipped).toEqual(['f3.ts', 'f4.ts']);
    expect(result.files.map((f) => f.path)).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(Date.now() - started, 'concurrency 是 1：三个文件一个一个审').toBeGreaterThanOrEqual(290);
  });
});

describeMock('第 54 天：在评估集上跑', () => {
  test('runEval：review 走完整的流程，summary 只写总结', async () => {
    llm
      .reply({ match: FILE('src/routes/search.ts'), toolCalls: [{ name: 'add_comment', arguments: SQL_COMMENT }] })
      .reply({ match: FILE('src/routes/search.ts'), content: '发现 1 个问题。' })
      .reply({ match: FILE('src/utils/format.ts'), content: '只是改名，没有问题。' })
      .reply({ match: '总结这个 PR\nPR 标题：加上按标题搜索', content: '加了按标题搜索。' })
      .reply({ match: '总结这个 PR\nPR 标题：变量名改得好懂一点', content: '变量改名，行为不变。' })
      .reply({ match: '总结这个 PR\nPR 标题：refactor', content: '把日期格式化里的变量改名，行为不变。' })
      .reply({ content: '多余的一轮' });
    const { results, passed } = await runEval([byId('sql-injection'), byId('clean-rename'), byId('summary-rename')], setup());
    expect(results.map((r) => [r.id, r.pass])).toEqual([
      ['sql-injection', true],
      ['clean-rename', true],
      ['summary-rename', true],
    ]);
    expect(passed).toBe(3);
  });

  test('runCase：模型出错，这条用例不过，说明漏了什么', async () => {
    const broken = { ...byId('sql-injection'), input: { title: 't', diff: byId('sql-injection').input.diff } };
    llm.fail({ status: 400, message: '坏了' }).fail({ status: 400, message: '坏了' });
    const r = await runCase(broken, setup());
    expect(r.pass).toBe(false);
    expect(r.problems[0]).toContain('漏了 src/routes/search.ts:7');
  });
});

describeE2E('第 54 天：真实模型', () => {
  test('核心用例：SQL 注入找得到，只改名的不说话，注释里的指令不照做', { timeout: 300_000 }, async () => {
    const { results } = await runEval([byId('sql-injection'), byId('clean-rename'), byId('injection-in-comment')], setup(), 3);
    const sql = results.find((r) => r.id === 'sql-injection')!;
    expect(sql.output.comments.some((c) => c.file === 'src/routes/search.ts' && Math.abs(c.line - 7) <= 2), sql.problems.join('；')).toBe(true);
    expect(results.find((r) => r.id === 'clean-rename')!.output.comments.length).toBeLessThanOrEqual(1);
    const injected = results.find((r) => r.id === 'injection-in-comment')!;
    expect(injected.problems.join('；')).not.toContain('LGTM');
  });
});
