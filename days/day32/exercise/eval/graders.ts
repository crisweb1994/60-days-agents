// 第 32 天：评分器。第 31 天只有一种检查：事实出没出现，结果是对或错。今天把「怎么打分」拆成一个个评分器：
//   代码评分：事实（facts）、引用（citations）、调用轨迹（trajectory）。便宜、稳定、可以每次都跑
//   模型评审：按评分细则打分（rubric）、两两比较（pairwise）。能判断代码判断不了的东西，但它自己也要被校准
// 每个评分器给出 0 到 1 的分数、过没过、一句理由。一次评估可以同时用几个评分器，分开统计。
// 第 32 天的练习：TODO 1–6 都在这里。检查：npm run check 32
import { z } from 'zod';
import { mapLimit } from '../parallel.ts';
import type { Model } from '../types.ts';
import { addUsage, emptyUsage, type Usage } from '../usage.ts';
import type { EvalCase } from './dataset.ts';
import { checkExpectations, type EvalRun, type TargetOutput } from './run.ts';

export interface Score {
  /** 哪个评分器打的分 */
  grader: string;
  /** 0 到 1 */
  value: number;
  pass: boolean;
  /** 给人看的理由：哪几项没过 */
  reason: string;
  /** 模型评审花掉的用量。代码评分没有 */
  usage?: Usage;
}

export interface Grader {
  name: string;
  grade(c: EvalCase, output: TargetOutput, signal?: AbortSignal): Score | Promise<Score>;
}

/** 一项检查。代码评分器都是一组检查：分数是通过的比例，全部通过才算过 */
interface Check {
  label: string;
  ok: boolean;
}

/** 一组检查变成分数。没有任何检查时，分数是 1、算通过，理由是 none */
function fromChecks(grader: string, checks: Check[], none: string): Score {
  if (!checks.length) return { grader, value: 1, pass: true, reason: none };
  const failed = checks.filter((c) => !c.ok);
  return {
    grader,
    value: (checks.length - failed.length) / checks.length,
    pass: failed.length === 0,
    reason: failed.length ? failed.map((c) => c.label).join('；') : '全部通过',
  };
}

// ---------- 代码评分 ----------

/** 事实：每个 fact 一项，每个 forbidden 一项，unanswerable 一项（要说没查到）。和第 31 天的检查一样，只是不看来源 */
export const factsGrader: Grader = {
  name: 'facts',
  grade(c, output) {
    const check = checkExpectations(c, output);
    const missing = new Set(check.missing);
    const checks: Check[] = [
      ...c.expected.facts.map((fact) => {
        const label = Array.isArray(fact) ? fact.join('/') : fact;
        return { label: `缺少 ${label}`, ok: !missing.has(label) };
      }),
      ...c.expected.forbidden.map((f) => ({ label: `出现了 ${f}`, ok: !check.forbidden.includes(f) })),
      ...(c.expected.unanswerable ? [{ label: '没有说没查到', ok: check.admitsUnknown }] : []),
    ];
    return fromChecks('facts', checks, '没有事实上的期望');
  },
};

/**
 * 引用。检查这几项：
 * - expected.sources 里每个来源一项「没有引用 X」：cited 里有网址包含它就算过
 * - 回答引用了来源时（cited 不为空），引用检查没有发现问题，一项「引用格式有问题：……」（把 citationProblems 用；连起来）
 * - 资料里没有答案的用例（unanswerable），一项「资料里没有答案，却引用了来源」：cited 应该是空的。
 *   引用了来源却说没查到，说明它把不相干的来源当成了依据
 * 没有任何一项要检查时，理由是「没有引用上的期望」
 */
export const citationGrader: Grader = {
  name: 'citations',
  grade(c, output) {
    // TODO 2：按上面注释的三项检查，用 fromChecks('citations', checks, '没有引用上的期望') 算分
    void c;
    void output;
    return fromChecks('citations', [], '没有引用上的期望');
},
};

/** 一次工具调用的指纹：名字加上参数。用来找出一模一样的重复调用 */
const fingerprint = (call: TargetOutput['toolCalls'][number]) => `${call.name} ${JSON.stringify(call.arguments)}`;

/** expected 是不是 actual 的子序列：按顺序出现，中间可以夹着别的 */
export function isSubsequence(expected: string[], actual: string[]): boolean {
  let i = 0;
  for (const name of actual) if (name === expected[i]) i++;
  return i === expected.length;
}

/**
 * 调用轨迹。看的不是回答，而是它怎么得到回答的：
 * - expected.tools 里每个工具一项「没有调用 X」
 * - expected.tools 有两个以上时，一项「调用的顺序不对：应该是 A → B」：按这个顺序出现（isSubsequence）
 * - 有 maxToolCalls 时，一项「调用了 N 次工具，最多 M 次」
 * - 只要调用过工具，一项「重复调用：X」：名字和参数都一样的调用出现了两次以上（列出第一个重复的工具名）
 */
export const trajectoryGrader: Grader = {
  name: 'trajectory',
  grade(c, output) {
    // TODO 1：按上面注释的四项检查。工具名按调用的顺序是 output.toolCalls.map((call) => call.name)；
    // 判断重复用 fingerprint(call)。用 fromChecks('trajectory', checks, '没有轨迹上的期望') 算分
    void isSubsequence;
    void fingerprint;
    void c;
    void output;
    return fromChecks('trajectory', [], '没有轨迹上的期望');
},
};

// ---------- 模型评审：评分细则 ----------

export interface Criterion {
  name: string;
  /** 1 分和 5 分各是什么样，写得越具体，评审越稳定 */
  description: string;
}

/** 研究助手回答质量的评分细则。每一条都是可以单独判断的一件事，不要写「整体好不好」 */
export const QUALITY_RUBRIC: Criterion[] = [
  { name: '切题', description: '5 分：第一句就直接回答了问题；1 分：答非所问，或者绕了很久才说到' },
  { name: '准确', description: '5 分：和参考答案一致，没有编造参考答案之外的具体数字和事实；1 分：关键事实错了，或者编了数字' },
  { name: '诚实', description: '5 分：资料不足的地方明确说了；1 分：把不确定的说成确定的，或者查不到也硬答' },
  { name: '简洁', description: '5 分：没有客套话和重复，篇幅和问题相称；1 分：大段和问题无关的内容' },
];

export const RUBRIC_PROMPT = `你是一个严格的评审，按评分细则给一个研究助手的回答打分。用户消息里有问题、参考答案、评分细则和要评的回答。
只输出 JSON，格式是 {"scores": {"细则的名字": 分数}, "reason": "一两句话说明扣分的地方"}，不要别的文字。
- 每一条细则单独打 1 到 5 的整数分，不要因为别的细则好就给这一条高分
- 参考答案只列出了必须有的事实，回答可以比它详细；但回答里参考答案之外的具体数字和事实，你无法核实的，按编造处理
- 不要因为回答长就给高分`;

export interface RubricVerdict {
  /** 每条细则的分数，1 到 5 */
  scores: Record<string, number>;
  reason: string;
}

/**
 * 解析评审的输出。允许外面包着 ```json 代码块。
 * 每一条细则都要有 1 到 5 的整数分，少一条、多出不认识的、不是整数、超出范围，都返回 undefined
 */
export function parseRubricVerdict(text: string, rubric: Criterion[]): RubricVerdict | undefined {
  // TODO 3（一）：先去掉 ```json 代码块的包装，再 JSON.parse；按上面注释的规则检查 scores，reason 不是字符串就用空字符串
  void text;
  void rubric;
  return undefined;
}

/** 参考答案：评审只知道必须有的事实。资料里没有答案的用例，参考答案就是「应该说没查到」 */
export function referenceAnswer(c: EvalCase): string {
  if (c.expected.unanswerable) return '资料里没有这个问题的答案。好的回答应该明确说没有查到，不能编一个答案';
  const facts = c.expected.facts.map((f) => (Array.isArray(f) ? f.join(' 或 ') : f));
  return facts.length ? `必须有这些事实：${facts.join('；')}` : '（没有参考答案，按细则判断）';
}

export interface RubricGraderOptions {
  model: Model;
  rubric?: Criterion[];
  /** 平均分换算成 0 到 1 以后，达到多少算通过，默认 0.75（相当于平均 4 分） */
  threshold?: number;
  name?: string;
}

/**
 * 模型按评分细则打分。分数换算：每条细则 (分数 - 1) / 4，再取平均。
 * 解析不了：分数 0、不通过，理由「评审的输出解析不了」。评审出错（解析不了）不能当成回答好
 */
export function rubricGrader({ model, rubric = QUALITY_RUBRIC, threshold = 0.75, name = 'quality' }: RubricGraderOptions): Grader {
  return {
    name,
    async grade(c, output, signal) {
      const criteria = rubric.map((r) => `- ${r.name}：${r.description}`).join('\n');
      const result = await model.chat(
        {
          messages: [
            { role: 'system', content: RUBRIC_PROMPT },
            { role: 'user', content: `问题：${c.question}\n\n参考答案：${referenceAnswer(c)}\n\n评分细则：\n${criteria}\n\n要评的回答：\n${output.answer}` },
          ],
          temperature: 0,
        },
        { signal },
      );
      // TODO 3（二）：用 parseRubricVerdict 解析评审的输出：
      // - 解析不了：value 0、不通过、理由「评审的输出解析不了」
      // - 每条细则 (分数 - 1) / 4，取平均就是 value；value 达到 threshold 才通过
      // - reason 是「切题 5，准确 4，……。」加上评审给的理由；usage 是这次调用的用量
      void threshold;
      void result;
      throw new Error('TODO 3：还没有实现 rubricGrader 的打分');
    },
  };
}

// ---------- 模型评审：两两比较 ----------

export const PAIRWISE_PROMPT = `你是一个严格的评审，比较同一个问题的两个回答哪个更好。用户消息里有问题、参考答案、回答 A 和回答 B。
只输出 JSON，格式是 {"winner": "A", "reason": "一句话理由"}，winner 是 A、B 或 tie，不要别的文字。
- 先看准确：和参考答案矛盾、编造了数字的，直接判输
- 准确程度差不多时，再看是否直接回答了问题、是否简洁
- 不要因为回答长、或者排在前面就判它赢`;

export type Winner = 'a' | 'b' | 'tie';

export interface PairwiseResult {
  winner: Winner;
  /** 两次评审各自的判断：第一次 A 是 a，第二次交换了位置，已经换算回来 */
  votes: [Winner | undefined, Winner | undefined];
  usage: Usage;
}

/** 解析两两比较的输出，返回 A、B 或 tie（小写）。解析不了返回 undefined */
export function parseWinner(text: string): Winner | undefined {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const winner = String((JSON.parse(json) as { winner?: unknown }).winner ?? '').toLowerCase();
    return winner === 'a' || winner === 'b' || winner === 'tie' ? winner : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 两两比较：评审有「位置偏差」，常常偏向排在前面（或后面）的那个。所以比两次：
 * 第一次 a 放在 A、b 放在 B；第二次交换位置，再把结果换算回来（判 A 赢就是 b 赢）。
 * 两次一致才算数；不一致、或者有一次解析不了，就是 tie。两次评审可以同时发出
 */
export async function comparePair(c: EvalCase, a: string, b: string, model: Model, signal?: AbortSignal): Promise<PairwiseResult> {
  // TODO 4：
  // - 写一个 ask(first, second)：system 是 PAIRWISE_PROMPT，user 是「问题：…\n\n参考答案：…\n\n回答 A：\n…\n\n回答 B：\n…」
  //   （参考答案用 referenceAnswer(c)），temperature 是 0
  // - 同时发出 ask(a, b) 和 ask(b, a)，用 parseWinner 解析；第二次的结果要换算回来：a ↔ b，tie 不变
  // - 两次一致就是它，否则（包括有一次解析不了）是 tie；votes 是换算以后的两次判断；usage 是两次之和
  void c;
  void a;
  void b;
  void model;
  void signal;
  throw new Error('TODO 4：还没有实现 comparePair');
}

// ---------- 校准：评审和人的判断一致吗 ----------

export interface Agreement {
  /** 一共几条 */
  total: number;
  /** 判断一致的比例 */
  agreement: number;
  /** Cohen's kappa：扣掉「碰巧一致」以后的一致程度。1 是完全一致，0 和瞎猜差不多，负数比瞎猜还差 */
  kappa: number;
  /** 人说好、评审也说好；人说差、评审说好（评审放水）；人说好、评审说差（评审太严）；都说差 */
  confusion: { bothPass: number; judgeOnly: number; humanOnly: number; bothFail: number };
}

/**
 * 评审（judge）和人工标注（human）的一致程度，两个数组一一对应，true 表示「好」。
 * kappa = (实际一致率 - 碰巧一致率) / (1 - 碰巧一致率)，
 * 碰巧一致率 = 两边都说好的概率 + 两边都说差的概率 = pj × ph + (1 - pj) × (1 - ph)，pj、ph 是两边各自说好的比例。
 * 碰巧一致率是 1 时（比如两边全都说好），kappa 记为 1（完全一致）或 0（不一致）
 */
export function agreementWith(judge: boolean[], human: boolean[]): Agreement {
  if (judge.length !== human.length || judge.length === 0) throw new Error('评审和人工标注要一一对应，而且不能是空的');
  // TODO 5：数出 confusion 的四格，算出一致率和 kappa（公式在上面的注释里）
  return { total: judge.length, agreement: 0, kappa: 0, confusion: { bothPass: 0, judgeOnly: 0, humanOnly: 0, bothFail: 0 } };
}

// ---------- 给一次评估打分 ----------

export interface ScoredCase {
  id: string;
  tags: string[];
  /** 跑出错了：没有分数，每个评分器都算不通过 */
  error?: string;
  scores: Score[];
}

export interface ScoredRun {
  name: string;
  startedAt: string;
  cases: ScoredCase[];
  /** 评分本身花掉的用量（模型评审） */
  gradingUsage: Usage;
}

/**
 * 用几个评分器给一次评估的结果打分。cases 用来按 id 找到期望。
 * 出错的用例不交给评分器，每个评分器记一个 0 分、不通过、理由是「出错：……」的分数。
 * 模型评审要调用模型，用 mapLimit 同时给几条打分（concurrency 默认 4）
 */
export async function gradeRun(run: EvalRun, cases: EvalCase[], graders: Grader[], options: { concurrency?: number; signal?: AbortSignal } = {}): Promise<ScoredRun> {
  const { concurrency = 4, signal } = options;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const settled = await mapLimit(
    run.results,
    concurrency,
    async (r): Promise<ScoredCase> => {
      const c = byId.get(r.id);
      if (!c) throw new Error(`评估结果里的 ${r.id} 不在评估集里`);
      if (!r.output) {
        return { id: r.id, tags: r.tags, error: r.error, scores: graders.map((g) => ({ grader: g.name, value: 0, pass: false, reason: `出错：${r.error}` })) };
      }
      const scores: Score[] = [];
      for (const g of graders) scores.push(await g.grade(c, r.output, signal));
      return { id: r.id, tags: r.tags, scores };
    },
    signal,
  );
  const scored = settled.map((s) => {
    if (s.status === 'rejected') throw s.reason;
    return s.value;
  });
  const gradingUsage = scored.flatMap((c) => c.scores).reduce((sum, s) => (s.usage ? addUsage(sum, s.usage) : sum), emptyUsage());
  return { name: run.name, startedAt: run.startedAt, cases: scored, gradingUsage };
}

export interface GraderSummary {
  grader: string;
  /** 平均分 */
  mean: number;
  /** 通过的比例 */
  passRate: number;
}

/** 每个评分器的平均分和通过率。tag 不为空时只统计带这个标签的用例 */
export function summarizeScores(scored: ScoredRun, tag?: string): GraderSummary[] {
  const members = tag ? scored.cases.filter((c) => c.tags.includes(tag)) : scored.cases;
  const names = [...new Set(scored.cases.flatMap((c) => c.scores.map((s) => s.grader)))];
  return names.map((grader) => {
    const scores = members.flatMap((c) => c.scores.filter((s) => s.grader === grader));
    const n = scores.length || 1;
    return { grader, mean: scores.reduce((sum, s) => sum + s.value, 0) / n, passRate: scores.filter((s) => s.pass).length / n };
  });
}

/** 每个评分器一行：平均分和通过率 */
export function formatScores(summaries: GraderSummary[]): string {
  const rows = summaries.map((s) => `| ${s.grader} | ${s.mean.toFixed(2)} | ${Math.round(s.passRate * 100)}% |`);
  return ['| 评分器 | 平均分 | 通过率 |', '|---|---|---|', ...rows].join('\n');
}

// ---------- 多次运行：看方差 ----------

export interface Repeatability {
  /** 跑了几遍 */
  runs: number;
  /** 每一遍的通过率 */
  passRates: number[];
  mean: number;
  /** 标准差（总体标准差）。通过率每遍差多少 */
  stddev: number;
  /** 每遍都通过的用例 */
  stable: string[];
  /** 时而通过、时而不通过的用例：最值得看的就是它们 */
  flaky: { id: string; passed: number }[];
  /** 每遍都不通过的用例 */
  failing: string[];
}

/**
 * 同一个评估跑了几遍，看某个评分器的结果稳不稳。runs 里每一遍的用例相同（按 id 对上）。
 * flaky 按通过的次数从少到多排；stable、failing 保持第一遍里的顺序
 */
export function repeatability(runs: ScoredRun[], grader: string): Repeatability {
  if (!runs.length) throw new Error('至少要有一遍');
  // TODO 6：
  // - 用第一遍的用例 id；passOf(某一遍, id)：这一遍里这条用例、这个评分器的分数 pass 是不是 true
  // - passRates：每一遍通过的比例；mean 和 stddev（总体标准差：除以遍数，不是遍数 - 1）
  // - 每条用例通过了几遍：每遍都过是 stable，一遍都没过是 failing，其余的是 flaky（按通过的次数从少到多）
  void grader;
  throw new Error('TODO 6：还没有实现 repeatability');
}

// ---------- 人工标注 ----------

const LabelSchema = z.object({ id: z.string(), answer: z.string(), human: z.boolean(), note: z.string().optional() });
export type JudgeLabel = z.infer<typeof LabelSchema>;

/** 解析人工标注（JSONL，// 开头是注释） */
export function parseLabels(text: string): JudgeLabel[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .map((line, i) => {
      const parsed = LabelSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`人工标注的第 ${i + 1} 条格式不对：${parsed.error.issues[0].message}`);
      return parsed.data;
    });
}

export interface Calibration extends Agreement {
  /** 评审和人判断不一致的那几条：最值得看，往往说明评分细则写得不清楚 */
  disagreements: { label: JudgeLabel; score: Score }[];
}

/** 用人工标注检查一个评分器：把每条标注的回答交给它打分，和人的判断比较 */
export async function calibrate(grader: Grader, labels: JudgeLabel[], cases: EvalCase[], options: { concurrency?: number; signal?: AbortSignal } = {}): Promise<Calibration> {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const settled = await mapLimit(
    labels,
    options.concurrency ?? 4,
    async (label) => {
      const c = byId.get(label.id);
      if (!c) throw new Error(`人工标注里的 ${label.id} 不在评估集里`);
      const output: TargetOutput = { answer: label.answer, usage: emptyUsage(), toolCalls: [], cited: [], citationProblems: [], status: 'completed' };
      return grader.grade(c, output, options.signal);
    },
    options.signal,
  );
  const scores = settled.map((s) => {
    if (s.status === 'rejected') throw s.reason;
    return s.value;
  });
  const result = agreementWith(
    scores.map((s) => s.pass),
    labels.map((l) => l.human),
  );
  return { ...result, disagreements: labels.flatMap((label, i) => (scores[i].pass === label.human ? [] : [{ label, score: scores[i] }])) };
}
