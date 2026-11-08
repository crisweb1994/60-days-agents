// 第 55 天：给失败分类。分数只告诉你「差多少」，分类告诉你「先改哪里」：
//   漏报多 → prompt 没说清要找什么，或者模型没去看上下文；位置不对 → 行号的格式、prompt 里落评论的规则；
//   多余的评论多 → prompt 没说清不要什么；Agent 出错 → 工具、步数上限、模型服务
// 每一类对应一种改法。先改数量最多的那一类，改完再跑一遍。
// 第 55 天的练习：TODO 2 在这里。检查：npm run check 55
import { LINE_TOLERANCE, matchesIssue, type CaseResult, type ReviewCase } from './run.ts';
import { matchComments } from './score.ts';

export const FAILURE_KINDS = ['agent-error', 'missed', 'wrong-line', 'false-alarm', 'not-skipped', 'injected', 'summary-gap'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export const FAILURE_LABELS: Record<FailureKind, { label: string; hint: string }> = {
  'agent-error': { label: 'Agent 出错', hint: '看 trace：工具报错、步数用完、模型服务出错' },
  missed: { label: '漏报', hint: 'prompt 里说清楚要找什么；看模型有没有去读上下文' },
  'wrong-line': { label: '位置不对', hint: '说对了问题，但行号差太多：检查 diff 的行号格式和 prompt 里落评论的规则' },
  'false-alarm': { label: '多余的评论', hint: 'prompt 里说清楚不要什么；汇总时限量' },
  'not-skipped': { label: '没跳过', hint: '跳过的规则（isGenerated）漏了这种文件' },
  injected: { label: '被注入', hint: '代码里的指令被照做了：prompt、工具的权限、输出的检查' },
  'summary-gap': { label: '总结漏了要点', hint: '总结的 prompt；给的 diff 是不是被截断了' },
};

/** 同一个文件、说对了问题（有关键词），只是行号差得比 LINE_TOLERANCE 远 */
function nearMiss(issue: ReviewCase['expected']['issues'][number], comment: { file: string; line: number; body: string }): boolean {
  // 把行号换成问题的行号再用 matchesIssue 比：剩下的就只有「文件对、关键词对」
  return comment.file === issue.file && Math.abs(comment.line - issue.line) > LINE_TOLERANCE && matchesIssue({ ...comment, line: issue.line, severity: 'low', kind: 'bug' }, issue);
}

/**
 * 一条用例的失败分成哪几类（TODO 2（一）），去重，按 FAILURE_KINDS 的顺序：
 * - agent-error：运行出错（result.error），或者有文件的 status 不是 completed
 * - review 用例：用 matchComments 对一遍。每个漏掉的问题，有评论「同文件、有关键词、只是行号差太多」就是 wrong-line，否则是 missed；
 *   多余的评论里，不是某个 wrong-line 的那条评论的，算 false-alarm
 * - not-skipped：expected.skipped 里有没跳过的
 * - injected：总结或者评论里出现了 forbidden（不分大小写）
 * - summary-gap：summary 用例的 mentions 有没出现的（不分大小写）
 * 过了的用例也可能有类别（比如 agent-error 但评论都对），照样返回
 */
export function classifyCase(c: ReviewCase, result: CaseResult): FailureKind[] {
  // TODO 2（一）：用一个 Set 收集类别，最后按 FAILURE_KINDS 的顺序过滤出来。
  // wrong-line 用上面的 nearMiss 判断；被算作 wrong-line 的评论，不再算 false-alarm
  void matchComments; void nearMiss; void c; void result;
  return [];
}

export interface Triage {
  /** 每一类有几条用例（每一类都有，没有的是 0） */
  counts: Record<FailureKind, number>;
  /** 每一类是哪几条用例 */
  cases: Record<FailureKind, string[]>;
  /** 数量不是 0 的类，按数量从多到少（一样多按 FAILURE_KINDS 的顺序） */
  top: [FailureKind, number][];
}

/** 给一组结果分类（TODO 2（二））。results 和 cases 按 id 对上，找不到用例的跳过 */
export function triage(results: CaseResult[], cases: ReviewCase[]): Triage {
  // TODO 2（二）：counts 和 cases 先把每一类都设成 0 和 []；每条结果用 classifyCase 分类、累加；
  // top 是数量不是 0 的类，按数量从多到少排（sort 是稳定的，一样多的保持 FAILURE_KINDS 的顺序）
  void classifyCase; void results; void cases;
  throw new Error('TODO 2：还没有实现 triage');
}

/** 给人看的分类：每类一行，带上是哪几条和改的方向 */
export function renderTriage(t: Triage): string {
  if (!t.top.length) return '没有失败的用例';
  return t.top.map(([k, n]) => `- ${FAILURE_LABELS[k].label} ${n} 条（${t.cases[k].join('、')}）：${FAILURE_LABELS[k].hint}`).join('\n');
}
