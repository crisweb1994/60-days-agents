import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const d = await loadTarget<typeof import('../solution/design.ts')>(import.meta.url, 'design.ts');
const { extractDesign, findTrifecta, reviewDesign, estimateCost, monthlyCost, renderToolTable, ToolSpecSchema } = d;

type ToolSpec = import('../solution/design.ts').ToolSpec;
type Design = import('../solution/design.ts').Design;
const example = extractDesign(await readFile(new URL('../example/design.md', import.meta.url), 'utf8'));
const tool = (name: string, over: Partial<ToolSpec> = {}): ToolSpec => ToolSpecSchema.parse({ name, description: `${name} 的描述，写清楚什么时候用、返回什么`, risk: 'read', ...over });
const design = (tools: ToolSpec[], over: Partial<Design> = {}): Design => ({ name: 'demo', mode: 'agent', maxSteps: 8, tools, ...over });

/** 一个邮件助手：读邮件（不可信）、读通讯录（私有）、发 HTTP 请求（外传） */
const mailAgent = () => [
  tool('read_inbox', { touches: ['private-data', 'untrusted-content'] }),
  tool('read_contacts', { touches: ['private-data'] }),
  tool('http_get', { touches: ['external-send', 'untrusted-content'] }),
];

describe('第 52 天：读出设计（已经写好）', () => {
  test('示例项目的设计能读出来；默认值补上了', () => {
    expect(example.mode).toBe('hybrid');
    expect(example.tools.map((t) => t.name)).toEqual(['list_changed_files', 'read_diff', 'read_file', 'search_code', 'add_comment']);
    expect(example.tools[0].approval).toBe('never');
    expect(example.tools[4].touches).toEqual([]);
    expect(() => extractDesign('```json\n{"name":"x","mode":"auto","tools":[],"maxSteps":3}\n```')).toThrow('mode');
  });

  test('renderToolTable：每个工具一行', () => {
    const table = renderToolTable(example.tools);
    expect(table.split('\n')).toHaveLength(7);
    expect(table).toContain('| `read_diff` | 只读 | 私有数据、不可信内容 | 不用 |');
    expect(table).toContain('| `add_comment` | 可写 | — | 不用 |');
  });
});

describe('第 52 天：致命三要素（TODO 1）', () => {
  test('三类来自不同的工具也算；按清单的顺序列出', () => {
    expect(findTrifecta(mailAgent())).toEqual({ privateData: ['read_inbox', 'read_contacts'], untrusted: ['read_inbox', 'http_get'], externalSend: ['http_get'] });
  });

  test('缺任何一类都是 null；示例项目没有外传的工具', () => {
    expect(findTrifecta(mailAgent().slice(0, 2))).toBeNull();
    expect(findTrifecta([tool('a', { touches: ['private-data', 'external-send'] })])).toBeNull();
    expect(findTrifecta([])).toBeNull();
    expect(findTrifecta(example.tools), 'review-bot 把外传留给了流程代码').toBeNull();
  });
});

describe('第 52 天：审一遍设计（TODO 2）', () => {
  test('示例项目只有一条 warn：草稿评论不用确认', () => {
    expect(reviewDesign(example)).toEqual([{ level: 'warn', rule: 'write-unattended', message: 'add_comment 会写东西、不用确认，而 Agent 会读到不可信的内容：确认它被骗了也不要紧' }]);
  });

  test('三要素齐了是 error；外传的工具每次都确认就降成 warn', () => {
    const [finding] = reviewDesign(design(mailAgent()));
    expect(finding).toEqual({
      level: 'error',
      rule: 'lethal-trifecta',
      message: '同时具备致命三要素：私有数据（read_inbox、read_contacts）、不可信内容（read_inbox、http_get）、外传渠道（http_get）。去掉其中一类，或者让外传的工具每次都要人确认',
    });
    const gated = mailAgent().map((t) => (t.name === 'http_get' ? { ...t, approval: 'always' as const } : t));
    expect(reviewDesign(design(gated))[0]).toMatchObject({ level: 'warn', rule: 'lethal-trifecta' });
    expect(reviewDesign(design(gated))[0].message).toMatch(/。外传的工具每次都要人确认：确认时把要发出去的内容完整给人看$/);
    const half = mailAgent().map((t) => (t.name === 'http_get' ? { ...t, approval: 'first-time' as const } : t));
    expect(reviewDesign(design(half))[0].level, '只确认第一次不够').toBe('error');
  });

  test('按顺序报出所有问题', () => {
    const tools = [
      tool('send_email', { risk: 'irreversible', approval: 'first-time' }),
      tool('send_email', { risk: 'irreversible', approval: 'always' }),
      tool('save_note', { risk: 'write' }),
      tool('fetch', { touches: ['untrusted-content'], description: '抓网页' }),
      tool('delete_file', { risk: 'irreversible' }),
    ];
    expect(reviewDesign(design(tools)).map((f) => [f.level, f.rule, f.message])).toEqual([
      ['error', 'duplicate-tool', '工具名重复：send_email'],
      ['error', 'irreversible-approval', 'send_email 是不可逆的，要每次都确认（approval: always）'],
      ['error', 'irreversible-approval', 'delete_file 是不可逆的，要每次都确认（approval: always）'],
      ['warn', 'write-unattended', 'save_note 会写东西、不用确认，而 Agent 会读到不可信的内容：确认它被骗了也不要紧'],
      ['warn', 'short-description', 'fetch 的描述太短：写清楚什么时候用、返回什么'],
    ]);
  });

  test('没有不可信内容就不提醒 write；工具太多只提醒 Agent', () => {
    expect(reviewDesign(design([tool('save_note', { risk: 'write' })]))).toEqual([]);
    const many = Array.from({ length: 13 }, (_, i) => tool(`tool_${i}`));
    expect(reviewDesign(design(many))).toEqual([{ level: 'warn', rule: 'too-many-tools', message: '13 个工具太多了：考虑按需检索工具，或者拆给子 Agent' }]);
    expect(reviewDesign(design(many, { mode: 'workflow' })), '固定流程不让模型选工具').toEqual([]);
    expect(reviewDesign(design(many.slice(0, 12)))).toEqual([]);
  });
});

describe('第 52 天：成本估算（TODO 3）', () => {
  const base = { steps: 4, systemTokens: 1200, toolTokens: 900, userTokens: 1500, outputPerStep: 250, resultPerStep: 1000, cacheHitRate: 0.8, price: { input: 2, cachedInput: 0.2, output: 8 } };

  test('示例项目：每一步的输入随历史累加，缓存命中上一步的 80%', () => {
    const e = estimateCost(base);
    expect(e.perStep).toEqual([
      { step: 1, inputTokens: 3600, cachedTokens: 0 },
      { step: 2, inputTokens: 4850, cachedTokens: 2880 },
      { step: 3, inputTokens: 6100, cachedTokens: 3880 },
      { step: 4, inputTokens: 7350, cachedTokens: 4880 },
    ]);
    expect(e).toMatchObject({ inputTokens: 21900, cachedTokens: 11640, outputTokens: 1000 });
    expect(e.cost).toBeCloseTo(0.030848, 9);
    expect(monthlyCost(e.cost, 90)).toBeCloseTo(83.2896, 6);
  });

  test('步数翻倍，输入差不多翻四倍；没有缓存价时按输入价算', () => {
    const flat = { ...base, systemTokens: 0, toolTokens: 0, userTokens: 0, outputPerStep: 0, resultPerStep: 1000, cacheHitRate: 0 };
    const four = estimateCost({ ...flat, steps: 4 }).inputTokens;
    const eight = estimateCost({ ...flat, steps: 8 }).inputTokens;
    expect(eight / four).toBeCloseTo(28 / 6, 6);
    const noCachedPrice = estimateCost({ ...base, price: { input: 2, output: 8 } });
    expect(noCachedPrice.cost).toBeCloseTo((21900 * 2 + 1000 * 8) / 1_000_000, 9);
    expect(estimateCost({ ...base, steps: 1 }).perStep).toEqual([{ step: 1, inputTokens: 3600, cachedTokens: 0 }]);
  });
});
