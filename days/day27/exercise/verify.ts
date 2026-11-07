// 第 24 天：反思与自检。研究助手写完回答，回头核查每一句带引用的话，是不是真的出自它引用的来源。
// 第 20 天的检查只看格式（有没有引用、编号对不对）；今天检查内容：[1] 里真的写了这件事吗？
// 能用代码客观判断的先用代码判断（数字对不对得上），判断不了的才交给模型；模型的判断也要用代码再校验一遍（它给的原文在来源里吗）。
// 发现问题以后，把问题交回模型改一遍，再核查，直到没有问题、轮数用完，或者改了也没有变好。
import { citedIds, splitSentences } from './citations.ts';
import { mapLimit } from './parallel.ts';
import type { Model } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';
import type { Source, SourceRegistry } from './web.ts';

/** 一句带引用的话 */
export interface Claim {
  sentence: string;
  /** 它引用的编号 */
  ids: number[];
}

/** 回答里带引用的句子。没有引用的句子不在这里核查：「该有引用却没有」由第 20 天的格式检查负责 */
export function extractClaims(answer: string): Claim[] {
  return splitSentences(answer)
    .map((sentence) => ({ sentence, ids: citedIds(sentence) }))
    .filter((claim) => claim.ids.length > 0);
}

/** 句子里的数字，比如 2026、7443、99.95。先去掉 [编号]，编号不是句子的内容 */
export function numbersIn(text: string): string[] {
  const plain = text.replace(/\[\d+(?:\s*[,，]\s*\d+)*\]/g, '');
  return [...new Set(plain.match(/\d+(?:\.\d+)?/g) ?? [])];
}

/** text 里有没有这个数字。要是一个完整的数：找 18 时，2018 和 18.5 都不算 */
export function containsNumber(text: string, number: string): boolean {
  const escaped = number.replace('.', '\\.');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d]|\\.\\d)`).test(text);
}

/** 客观校验：句子里的每个数字，都要在它引用的来源里出现过。返回没出现的数字 */
export function missingNumbers(claim: Claim, sources: Source[]): string[] {
  const text = sources.map((s) => s.content ?? '').join('\n');
  return numbersIn(claim.sentence).filter((n) => !containsNumber(text, n));
}

export const VERDICTS = ['supported', 'partial', 'unsupported'] as const;
/** supported：来源支撑这句话；partial：只支撑一部分；unsupported：来源里没有，或者矛盾；unverifiable：没法核查 */
export type Verdict = (typeof VERDICTS)[number] | 'unverifiable';

export interface ClaimCheck {
  claim: Claim;
  verdict: Verdict;
  reason: string;
  /** 来源里支撑这句话的原文 */
  quote?: string;
  /** 谁做的判断：numbers 是代码对照数字，judge 是模型评审，none 是没法核查 */
  method: 'numbers' | 'judge' | 'none';
}

export const JUDGE_PROMPT = `你负责核查一句话是不是真的出自它引用的来源。用户消息里有这句话和来源的内容。
只输出 JSON，格式是 {"verdict": "supported", "quote": "……", "reason": "……"}，不要别的文字。
- verdict 是 supported、partial、unsupported 之一。supported：来源里明确写了这个意思，数字、日期、名称都对得上；partial：来源只支撑了一部分，或者这句话说得比来源更绝对；unsupported：来源里没有这个意思，或者和来源矛盾
- quote 是来源里支撑这句话的原文，要逐字复制，不要改写；unsupported 时写空字符串
- reason 用一句话说明
- 只根据给出的来源判断，不要用你自己知道的知识`;

/** 解析评审的输出。格式不对返回 undefined */
export function parseVerdict(text: string): { verdict: (typeof VERDICTS)[number]; quote: string; reason: string } | undefined {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const data = JSON.parse(json) as { verdict?: unknown; quote?: unknown; reason?: unknown };
    if (!VERDICTS.includes(data.verdict as (typeof VERDICTS)[number])) return undefined;
    return {
      verdict: data.verdict as (typeof VERDICTS)[number],
      quote: typeof data.quote === 'string' ? data.quote : '',
      reason: typeof data.reason === 'string' ? data.reason : '',
    };
  } catch {
    return undefined;
  }
}

/** 来源的内容排成一段文字给评审看，每个来源最多 maxChars 个字符 */
export function formatExcerpts(sources: Source[], maxChars = 4000): string {
  return sources
    .map((s) => {
      const content = s.content ?? '';
      const text = content.length > maxChars ? `${content.slice(0, maxChars)}……（后面省略）` : content;
      return `[${s.id}] ${s.title || s.url}\n${text}`;
    })
    .join('\n\n');
}

const squash = (text: string) => text.replace(/\s+/g, '');

export interface JudgeOptions {
  /** 每个来源最多给评审看多少个字符，默认 4000 */
  maxChars?: number;
  signal?: AbortSignal;
}

/**
 * 让模型判断一句话有没有来源支撑。再用代码校验它的判断：说支撑，就要给出原文，而且原文真的在来源里（忽略空白）。
 * 给不出、或者原文是它编的，就改判 unsupported。评审也是模型，也会出错，也会编
 */
export async function judgeClaim(claim: Claim, sources: Source[], model: Model, options: JudgeOptions = {}): Promise<{ check: ClaimCheck; usage: Usage }> {
  const { maxChars, signal } = options;
  const result = await model.chat(
    {
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user', content: `要核查的句子：${claim.sentence}\n\n来源：\n\n${formatExcerpts(sources, maxChars)}` },
      ],
    },
    { signal },
  );
  const usage = result.usage;
  const parsed = parseVerdict(result.message.content ?? '');
  if (!parsed) return { check: { claim, verdict: 'unverifiable', reason: '评审的输出解析不了', method: 'judge' }, usage };
  const { verdict, quote, reason } = parsed;
  if (verdict !== 'unsupported') {
    const found = quote.trim() !== '' && sources.some((s) => squash(s.content ?? '').includes(squash(quote)));
    if (!found) {
      const why = quote.trim() ? `评审给的原文在来源里找不到：「${quote}」` : '评审说有来源支撑，但没有给出原文';
      return { check: { claim, verdict: 'unsupported', reason: why, quote, method: 'judge' }, usage };
    }
  }
  return { check: { claim, verdict, reason, quote: quote || undefined, method: 'judge' }, usage };
}

export interface VerificationReport {
  checks: ClaimCheck[];
  /** 有问题的：partial 和 unsupported。没法核查的不算问题，但会列在 checks 里 */
  problems: ClaimCheck[];
  ok: boolean;
  usage: Usage;
}

export interface VerifyOptions extends JudgeOptions {
  /** 评审用的模型 */
  model: Model;
  /** 同时核查几句，默认 3 */
  concurrency?: number;
}

/**
 * 核查回答里每一句带引用的话：
 * 1. 引用的来源都没有内容（比如编号不存在）：unverifiable
 * 2. 句子里有来源里没有的数字：unsupported，不用再问模型。客观检查能判断的，就不花钱请模型判断
 * 3. 其余的交给 judgeClaim，几句同时核查
 */
export async function verifyCitations(answer: string, sources: SourceRegistry, options: VerifyOptions): Promise<VerificationReport> {
  const { model, concurrency = 3, ...judgeOptions } = options;
  const claims = extractClaims(answer);
  const settled = await mapLimit(
    claims,
    concurrency,
    async (claim): Promise<{ check: ClaimCheck; usage?: Usage }> => {
      const readable = claim.ids.map((id) => sources.get(id)).filter((s): s is Source => Boolean(s?.content));
      if (readable.length === 0) return { check: { claim, verdict: 'unverifiable', reason: '引用的来源没有可以对照的内容', method: 'none' } };
      const missing = missingNumbers(claim, readable);
      if (missing.length) return { check: { claim, verdict: 'unsupported', reason: `来源里没有这些数字：${missing.join('、')}`, method: 'numbers' } };
      return judgeClaim(claim, readable, model, judgeOptions);
    },
    judgeOptions.signal,
  );
  let usage = emptyUsage();
  const checks = settled.map((r, i): ClaimCheck => {
    if (r.status === 'rejected') return { claim: claims[i], verdict: 'unverifiable', reason: `核查出错：${(r.reason as Error).message}`, method: 'none' };
    if (r.value.usage) usage = addUsage(usage, r.value.usage);
    return r.value.check;
  });
  const problems = checks.filter((c) => c.verdict === 'partial' || c.verdict === 'unsupported');
  return { checks, problems, ok: problems.length === 0, usage };
}

const MARKS: Record<Verdict, string> = { supported: '✓', partial: '~', unsupported: '✗', unverifiable: '?' };

/** 核查的结果，一句一行：✓ 有支撑，~ 部分支撑，✗ 没有支撑，? 没法核查。最后一行是统计 */
export function formatVerification(report: VerificationReport): string {
  if (report.checks.length === 0) return '回答里没有带引用的句子，没有可以核查的';
  const lines = report.checks.map((c) => `${MARKS[c.verdict]} ${c.claim.sentence}${c.verdict === 'supported' ? '' : `（${c.reason}）`}`);
  const supported = report.checks.filter((c) => c.verdict === 'supported').length;
  return [...lines, `核查了 ${report.checks.length} 句，${supported} 句有来源支撑`].join('\n');
}

// ---------- 生成 → 核查 → 修改 ----------

export const REVISE_PROMPT = `你是研究助手。你之前的回答里，有几句话和引用的来源对不上，用户消息里列出了这些句子、核查的结果和来源的内容。
改写你的回答：
- 对不上的句子：按来源改正；来源里没有的，删掉；来源只支撑一部分的，改得和来源一致
- 其他句子和引用编号保持不变，不要加入来源里没有的内容
- 只输出改好的回答，不要解释你改了什么`;

export interface ReviseOptions {
  /** 修改回答用的模型 */
  model: Model;
  /** 核查用的模型，默认和 model 一样。可以换成更便宜的 */
  judge?: Model;
  /** 最多改几轮，默认 2 */
  maxRounds?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface ReviseResult {
  /** 最终的回答：问题最少的那一版 */
  answer: string;
  /** 每一版的核查结果，第一个是原来的回答 */
  reports: VerificationReport[];
  /** 改了几轮 */
  rounds: number;
  /** 为什么停下：verified 没有问题了；max_rounds 轮数用完了；no_improvement 改了以后问题没有变少 */
  stopped: 'verified' | 'max_rounds' | 'no_improvement';
  usage: Usage;
}

/** 修改时交给模型的内容：问题、原来的回答、有问题的句子和原因、这些句子引用的来源 */
export function describeProblems(question: string, answer: string, report: VerificationReport, sources: SourceRegistry): string {
  const problems = report.problems.map((c) => `- 「${c.claim.sentence}」：${c.reason}`).join('\n');
  const ids = [...new Set(report.problems.flatMap((c) => c.claim.ids))];
  const cited = ids.map((id) => sources.get(id)).filter((s): s is Source => Boolean(s?.content));
  return `问题：${question}\n\n你之前的回答：\n${answer}\n\n核查发现的问题：\n${problems}\n\n这些句子引用的来源：\n\n${formatExcerpts(cited)}`;
}

/**
 * 生成 → 核查 → 修改的循环。三个停止条件：
 * - 核查没有问题了
 * - 改了 maxRounds 轮
 * - 改完以后问题没有变少：再改多半也是白花钱。这时返回改之前的那一版
 */
export async function reviseUntilSupported(question: string, answer: string, sources: SourceRegistry, options: ReviseOptions): Promise<ReviseResult> {
  const { model, judge = model, maxRounds = 2, concurrency, signal } = options;
  const reports: VerificationReport[] = [];
  let usage = emptyUsage();
  let best = { answer, problems: Infinity };
  let current = answer;
  let stopped: ReviseResult['stopped'];
  while (true) {
    const report = await verifyCitations(current, sources, { model: judge, concurrency, signal });
    reports.push(report);
    usage = addUsage(usage, report.usage);
    if (report.problems.length >= best.problems) {
      stopped = 'no_improvement';
      break;
    }
    best = { answer: current, problems: report.problems.length };
    if (report.ok) {
      stopped = 'verified';
      break;
    }
    if (reports.length > maxRounds) {
      stopped = 'max_rounds';
      break;
    }
    const revised = await model.chat(
      {
        messages: [
          { role: 'system', content: REVISE_PROMPT },
          { role: 'user', content: describeProblems(question, current, report, sources) },
        ],
      },
      { signal },
    );
    usage = addUsage(usage, revised.usage);
    current = revised.message.content ?? '';
  }
  return { answer: best.answer, reports, rounds: reports.length - 1, stopped, usage };
}
