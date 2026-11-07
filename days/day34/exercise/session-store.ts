// 第 19 天：会话的持久化与恢复。每一轮结束就把会话存成一个 JSON 文件；程序退出、崩溃、换一天，都可以接着聊。
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from './types.ts';
import { emptyUsage, type Usage } from './usage.ts';

export interface SavedSession {
  id: string;
  /** 第一个问题的开头，列出会话时用 */
  title: string;
  /** 最后用的模型，比如 openai:my-model。恢复时只是提示，不强制用同一个 */
  model: string;
  messages: Message[];
  usage: Usage;
  turns: number;
  created: string;
  updated: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  turns: number;
  updated: string;
}

/** 文件格式的版本。格式变了就加一，读到不认识的版本时明确地报错 */
const VERSION = 1;

/** 新会话的 id：时间加几位随机数，按字母排序就是按时间排序 */
export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 用第一个问题做标题。问题前面的 <date> 之类的动态信息去掉 */
export function titleOf(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user')?.content ?? '';
  const question = first.replace(/<(\w+)>[\s\S]*?<\/\1>\s*/g, '').replace(/\s+/g, ' ').trim();
  return question.length > 30 ? `${question.slice(0, 30)}…` : question || '（空会话）';
}

/**
 * 修补历史：最后一条 assistant 消息发起的工具调用，如果没有对应的结果（比如程序在执行工具时崩溃了），
 * 补上「没有执行」的结果。否则恢复以后的第一个请求，接口会因为工具调用没有结果而报错
 */
export function repairHistory(messages: Message[]): Message[] {
  const repaired = [...messages];
  const answered = new Set(repaired.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id));
  const lastAssistant = repaired.findLastIndex((m) => m.role === 'assistant');
  if (lastAssistant === -1) return repaired;
  const calls = (repaired[lastAssistant] as { tool_calls?: { id: string }[] }).tool_calls ?? [];
  for (const call of calls) {
    if (!answered.has(call.id)) repaired.push({ role: 'tool', tool_call_id: call.id, content: '没有执行：会话在执行工具时中断了' });
  }
  return repaired;
}

export interface SessionStore {
  readonly dir: string;
  save(session: SavedSession): Promise<void>;
  /** 读出一个会话。找不到、文件坏了，都抛出错误，说明原因 */
  load(id: string): Promise<SavedSession>;
  /** 所有会话的摘要，最近更新的在前面。坏掉的文件跳过 */
  list(): Promise<SessionSummary[]>;
  remove(id: string): Promise<void>;
}

export function createSessionStore(dir: string): SessionStore {
  const file = (id: string) => join(dir, `${id}.json`);
  const checkId = (id: string) => {
    // id 会拼进文件路径，不能让它带着 ../ 跑到目录外面去
    if (!/^[\w-]+$/.test(id)) throw new Error(`会话 id「${id}」的格式不对`);
  };
  return {
    dir,
    async save(session) {
      checkId(session.id);
      await mkdir(dir, { recursive: true });
      // 先写临时文件，再改名：改名是原子的，写到一半程序崩溃了，原来的文件也还是完整的
      const tmp = `${file(session.id)}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: VERSION, ...session }));
      await rename(tmp, file(session.id));
    },
    async load(id) {
      checkId(id);
      let data: SavedSession & { version?: number };
      try {
        data = JSON.parse(await readFile(file(id), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`没有 id 为 ${id} 的会话。用 /sessions 看看有哪些`);
        throw new Error(`会话 ${id} 的文件坏了：${(error as Error).message}`);
      }
      if (data.version !== VERSION) throw new Error(`会话 ${id} 的文件格式是第 ${data.version} 版，这个程序只认第 ${VERSION} 版`);
      const { version: _, ...session } = data;
      return { ...session, usage: { ...emptyUsage(), ...session.usage }, messages: repairHistory(session.messages ?? []) };
    },
    async list() {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const summaries: SessionSummary[] = [];
      for (const f of files) {
        try {
          const data = JSON.parse(await readFile(join(dir, f), 'utf8')) as SavedSession;
          summaries.push({ id: data.id, title: data.title, turns: data.turns, updated: data.updated });
        } catch {
          // 坏掉的文件跳过，不影响列出其他的会话
        }
      }
      return summaries.sort((a, b) => b.updated.localeCompare(a.updated));
    },
    async remove(id) {
      checkId(id);
      await rm(file(id), { force: true });
    },
  };
}
