// 第 29 天：把暂停的运行存进文件。用户可能一个小时以后才回来，程序可能早就重启了，现场不能只放在内存里。
// 每次运行一个 JSON 文件：问题、暂停时的现场、在等用户做什么、用户说过「以后都可以」的工具。
// runResumable 开始一次可以暂停的运行，resumeRun 带着用户的答复接着跑，暂停了就再存一次，跑完就删掉。
// 运行（模拟一个后台任务）：
//   node days/day29/solution/run-store.ts start "把潮汐协议 3.0 的变化整理成 notes.md"
//   node days/day29/solution/run-store.ts list
//   node days/day29/solution/run-store.ts resume <运行的 id> <工具调用的 id>=y|n|a|回答的内容 ...
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resumeAgent, runAgent, type AgentOptions, type AgentResult, type PausedRun, type Resolution } from './agent.ts';
import { describeRisk } from './permissions.ts';
import type { Interrupt } from './tool.ts';

export interface SavedRun {
  id: string;
  question: string;
  created: string;
  updated: string;
  paused: PausedRun;
  /** 用户说过「以后都可以」的工具，恢复时带上 */
  grants: string[];
}

/** 在等用户做的一件事 */
export interface WaitingItem {
  /** 工具调用的 id，答复时用它 */
  callId: string;
  kind: Interrupt['kind'];
  /** 给人看的说明 */
  description: string;
}

/** 给人看的中断：「批准执行 write_file（可写）：{"path":"a.md"}」或者「回答问题：哪个版本？（可选：2.x / 3.0）」 */
export function describeInterrupt(interrupt: Interrupt): string {
  if (interrupt.kind === 'input') {
    const options = interrupt.options?.length ? `（可选：${interrupt.options.join(' / ')}）` : '';
    return `回答问题：${interrupt.question}${options}`;
  }
  const input = JSON.stringify(interrupt.input);
  return `批准执行 ${interrupt.tool}（${describeRisk(interrupt.risk)}）：${input.length > 200 ? `${input.slice(0, 200)}……` : input}`;
}

/** 暂停的现场里，在等用户的那几件事 */
export function waitingOf(paused: PausedRun): WaitingItem[] {
  return paused.calls.flatMap(({ call, interrupt }) => (interrupt ? [{ callId: call.id, kind: interrupt.kind, description: describeInterrupt(interrupt) }] : []));
}

export interface RunStore {
  save(run: SavedRun): Promise<void>;
  /** 读出一次运行。没有就抛出错误 */
  load(id: string): Promise<SavedRun>;
  /** 所有暂停中的运行，最近更新的在前 */
  list(): Promise<SavedRun[]>;
  remove(id: string): Promise<void>;
}

export function newRunId(now = new Date()): string {
  return `run-${now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createRunStore(dir: string): RunStore {
  const file = (id: string) => {
    if (!/^[\w-]+$/.test(id)) throw new Error(`运行的 id 不合法：${id}`);
    return join(dir, `${id}.json`);
  };
  return {
    async save(run) {
      await mkdir(dir, { recursive: true });
      // 先写到临时文件再改名：写到一半程序崩了，也不会留下一个坏掉的文件
      const tmp = `${file(run.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(run, null, 2));
      await rename(tmp, file(run.id));
    },
    async load(id) {
      const text = await readFile(file(id), 'utf8').catch(() => {
        throw new Error(`没有这次运行：${id}`);
      });
      return JSON.parse(text) as SavedRun;
    },
    async list() {
      const names = await readdir(dir).catch(() => []);
      const runs = await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as SavedRun));
      return runs.sort((a, b) => b.updated.localeCompare(a.updated));
    },
    async remove(id) {
      await rm(file(id), { force: true });
    },
  };
}

export interface ResumableOptions extends AgentOptions {
  store: RunStore;
  now?: () => Date;
}

export interface ResumableResult {
  id: string;
  result: AgentResult;
  /** 暂停时，在等用户做的事；跑完了就是空的 */
  waiting: WaitingItem[];
}

/** 保存或者清理：暂停了就存起来，跑完了就删掉 */
async function checkpoint(run: Omit<SavedRun, 'paused' | 'updated'>, result: AgentResult, options: ResumableOptions): Promise<ResumableResult> {
  const { store, now = () => new Date() } = options;
  if (!result.paused) {
    await store.remove(run.id);
    return { id: run.id, result, waiting: [] };
  }
  await store.save({ ...run, paused: result.paused, updated: now().toISOString(), grants: [...(options.grants ?? run.grants)] });
  return { id: run.id, result, waiting: waitingOf(result.paused) };
}

/** 开始一次可以暂停的运行：没人可问时不当作拒绝，而是暂停、存起来 */
export async function runResumable(question: string, options: ResumableOptions): Promise<ResumableResult> {
  const { now = () => new Date() } = options;
  const grants = options.grants ?? new Set<string>();
  const run = { id: newRunId(now()), question, created: now().toISOString(), grants: [] as string[] };
  const result = await runAgent(question, { ...options, grants, pausable: true });
  return checkpoint(run, result, { ...options, grants });
}

/** 带着用户的答复接着跑一次暂停的运行。又暂停了就再存一次 */
export async function resumeRun(id: string, resolutions: Record<string, Resolution>, options: ResumableOptions): Promise<ResumableResult> {
  const saved = await options.store.load(id);
  const grants = new Set([...saved.grants, ...(options.grants ?? [])]);
  const result = await resumeAgent(saved.paused, resolutions, { ...options, grants, pausable: true });
  return checkpoint(saved, result, { ...options, grants });
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { resolve } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const { createModel, providerFromEnv } = await import('./providers.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { createResearchTools } = await import('./research.ts');
  const { RESEARCH_PROMPT } = await import('./prompts.ts');
  const { DEFAULT_POLICY } = await import('./permissions.ts');
  const workspace = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = createRunStore(join(workspace, '.mini-agent', 'runs'));
  const { tools } = createResearchTools({ workspace, search: searchProviderFromEnv(), askUser: true });
  const options: ResumableOptions = { store, model: createModel(providerFromEnv()), tools, system: RESEARCH_PROMPT, policy: DEFAULT_POLICY, maxSteps: 15 };
  const report = ({ id, result, waiting }: ResumableResult) => {
    if (waiting.length === 0) return console.log(result.answer);
    console.log(`运行 ${id} 暂停了，在等你：`);
    for (const w of waiting) console.log(`  ${w.callId}：${w.description}`);
    console.log(`答复：node ${process.argv[1]} resume ${id} ${waiting.map((w) => `${w.callId}=${w.kind === 'approval' ? 'y' : '回答'}`).join(' ')}`);
  };
  const [command, ...args] = process.argv.slice(2);
  if (command === 'start' && args.length) report(await runResumable(args.join(' '), options));
  else if (command === 'list') {
    for (const run of await store.list()) console.log(`${run.id}  ${run.updated.slice(0, 16)}  ${run.question}\n${waitingOf(run.paused).map((w) => `  ${w.callId}：${w.description}`).join('\n')}`);
  } else if (command === 'resume' && args.length >= 2) {
    const resolutions: Record<string, Resolution> = {};
    for (const pair of args.slice(1)) {
      const [callId, ...rest] = pair.split('=');
      const value = rest.join('=');
      const saved = await store.load(args[0]);
      const kind = saved.paused.calls.find((c) => c.call.id === callId)?.interrupt?.kind;
      resolutions[callId] = kind === 'input' ? { answer: value } : { approved: value === 'y' || value === 'a', always: value === 'a' };
    }
    report(await resumeRun(args[0], resolutions, options));
  } else console.error('用法：run-store.ts start <问题> | list | resume <运行的 id> <调用的 id>=<答复> ...');
}
