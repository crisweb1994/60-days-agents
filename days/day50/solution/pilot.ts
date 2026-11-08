// 第 50 天：试用记录。邀请 3 位真实用户试用，每看到一件事记一条笔记（JSONL，一行一条），最后分拣：
//   wrong-answer（回答错了）→ 评估集的候选：和第 49 天的差评一样，进待审核的文件，人补上期望
//   ux（用起来别扭）、bug、feature（想要的新功能）→ 产品的待办，按「几个人遇到 × 有多严重」排序
//   praise（做对了的）→ 记下来，以后改版别把它改坏
// 笔记只写代号（P1、P2），不写真名；原话里的手机号、邮箱进报告之前打码。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EvalCaseSchema, type EvalCase } from './eval/dataset.ts';
import { maskPII } from './guardrails.ts';

export const PILOT_KINDS = ['wrong-answer', 'bug', 'ux', 'feature', 'praise'] as const;

export const PilotNoteSchema = z
  .strictObject({
    /** 试用者的代号，比如 P1。不写真名 */
    user: z.string().min(1),
    /** 哪天，YYYY-MM-DD */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期写成 YYYY-MM-DD'),
    /** 他想做什么 */
    task: z.string().min(1),
    kind: z.enum(PILOT_KINDS),
    /** 一个短的主题，同一件事用同一个主题，分拣时按它合并，比如「看不出在干什么」 */
    topic: z.string().min(1),
    /** 看到了什么：写事实（他停在哪里、点了什么、等了多久），不写你的解读 */
    observation: z.string().min(1),
    /** 用户的原话 */
    quote: z.string().optional(),
    /** 1 轻微，2 影响使用，3 用不下去 */
    severity: z.number().int().min(1).max(3).default(2),
    /** wrong-answer 时必填：当时问的问题 */
    question: z.string().optional(),
  })
  .refine((n) => n.kind !== 'wrong-answer' || !!n.question?.trim(), { message: 'wrong-answer 要写上当时问的问题（question）', path: ['question'] });

export type PilotNote = z.infer<typeof PilotNoteSchema>;

/** 读 JSONL 的笔记。空行跳过；哪一行不对，错误信息里带上行号和字段 */
export function parsePilotNotes(text: string): PilotNote[] {
  const notes: PilotNote[] = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`第 ${index + 1} 行不是合法的 JSON`);
    }
    const parsed = PilotNoteSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`第 ${index + 1} 行：${issue.path.join('.') || '（整条）'}：${issue.message}`);
    }
    notes.push(parsed.data);
  });
  return notes;
}

export interface BacklogItem {
  kind: 'bug' | 'ux' | 'feature';
  topic: string;
  /** 遇到的试用者，去重、排好序 */
  users: string[];
  /** 最严重的一次 */
  severity: number;
  /** 排序用的分数：人数 × 严重程度，bug 再加 1 */
  score: number;
  /** 合并进来的观察 */
  observations: string[];
}

export interface PilotTriage {
  /** 参加试用的人，去重、排好序 */
  users: string[];
  counts: Record<(typeof PILOT_KINDS)[number], number>;
  /** 回答错了的问题，变成待审核的评估用例 */
  evalCandidates: EvalCase[];
  backlog: BacklogItem[];
  praise: PilotNote[];
}

/** 试用发现的用例编号：pilot- 加上问题的 sha256 前 10 位 */
export function pilotCaseId(question: string): string {
  return `pilot-${createHash('sha256').update(question.trim()).digest('hex').slice(0, 10)}`;
}

const KIND_ORDER = { bug: 0, ux: 1, feature: 2 } as const;

/**
 * 分拣试用笔记（TODO 7）：
 * - users、counts：参加的人（去重排序）、每一类各几条（五类都要有，没有的是 0）
 * - evalCandidates：每条 wrong-answer 变成一条用例（EvalCaseSchema.parse 校验）：
 *   id 是 pilotCaseId(问题)，question 是脱敏的问题，tags 是 ['pilot', 'user:代号']，
 *   notes 是「试用观察：观察」，有原话再换行加「原话：原话」（都脱敏），最后换行加「待审核：补上 expected 以后挪进正式的评估集」。
 *   同一个问题只留第一条
 * - backlog：bug、ux、feature 按「kind + topic」合并：users 去重排序，severity 取最大，observations 按出现顺序；
 *   score = 人数 × severity，bug 再加 1。按 score 从高到低排，一样的按 bug、ux、feature，再一样的按 topic
 * - praise：好评原样留下
 */
export function triagePilot(notes: PilotNote[]): PilotTriage {
  const users = [...new Set(notes.map((n) => n.user))].sort();
  const counts = Object.fromEntries(PILOT_KINDS.map((k) => [k, notes.filter((n) => n.kind === k).length])) as PilotTriage['counts'];
  const evalCandidates: EvalCase[] = [];
  const seen = new Set<string>();
  const groups = new Map<string, { kind: BacklogItem['kind']; topic: string; users: Set<string>; severity: number; observations: string[] }>();
  for (const note of notes) {
    if (note.kind === 'wrong-answer') {
      const id = pilotCaseId(note.question!);
      if (seen.has(id)) continue;
      seen.add(id);
      const lines = [`试用观察：${maskPII(note.observation).text}`];
      if (note.quote) lines.push(`原话：${maskPII(note.quote).text}`);
      lines.push('待审核：补上 expected 以后挪进正式的评估集');
      evalCandidates.push(EvalCaseSchema.parse({ id, question: maskPII(note.question!).text, tags: ['pilot', `user:${note.user}`], notes: lines.join('\n') }));
    } else if (note.kind !== 'praise') {
      const key = `${note.kind}\u0000${note.topic}`;
      const group = groups.get(key) ?? { kind: note.kind, topic: note.topic, users: new Set(), severity: 0, observations: [] };
      group.users.add(note.user);
      group.severity = Math.max(group.severity, note.severity);
      group.observations.push(note.observation);
      groups.set(key, group);
    }
  }
  const backlog = [...groups.values()]
    .map((g): BacklogItem => ({ kind: g.kind, topic: g.topic, users: [...g.users].sort(), severity: g.severity, score: g.users.size * g.severity + (g.kind === 'bug' ? 1 : 0), observations: g.observations }))
    .sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.topic.localeCompare(b.topic));
  return { users, counts, evalCandidates, backlog, praise: notes.filter((n) => n.kind === 'praise') };
}

const KIND_LABEL = { bug: 'bug', ux: '体验', feature: '新功能' } as const;

/** 试用报告：概况、待办（表格）、进评估集的问题、好评的原话（脱敏）。给自己和团队看，也是第 51 天选题时的参考 */
export function renderPilotReport(triage: PilotTriage, title = '研究助手试用报告'): string {
  const { users, counts, backlog, evalCandidates, praise } = triage;
  const lines = [`# ${title}`, '', `${users.length} 位试用者（${users.join('、') || '无'}）：回答错了 ${counts['wrong-answer']} 条，bug ${counts.bug} 条，体验 ${counts.ux} 条，新功能 ${counts.feature} 条，好评 ${counts.praise} 条。`];
  if (users.length < 3) lines.push('', `> 试用者不到 3 位，结论可能只代表个别人。`);
  lines.push('', '## 待办', '');
  if (backlog.length) {
    lines.push('| 优先级 | 类型 | 主题 | 遇到的人 | 严重程度 |', '|---|---|---|---|---|');
    backlog.forEach((item, i) => lines.push(`| ${i + 1} | ${KIND_LABEL[item.kind]} | ${item.topic} | ${item.users.join('、')} | ${item.severity} |`));
  } else lines.push('（没有）');
  lines.push('', '## 进评估集（待审核）', '');
  lines.push(...(evalCandidates.length ? evalCandidates.map((c) => `- \`${c.id}\` ${c.question}`) : ['（没有）']));
  lines.push('', '## 做对了的', '');
  lines.push(...(praise.length ? praise.map((p) => `- ${p.user}：${maskPII(p.quote ?? p.observation).text}`) : ['（没有）']));
  return `${lines.join('\n')}\n`;
}
