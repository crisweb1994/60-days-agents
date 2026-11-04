// 第 19 天：会话的持久化与恢复。每一轮结束就把会话存成一个 JSON 文件；程序退出、崩溃、换一天，都可以接着聊。
// 第 19 天的练习：TODO 4、5 在这里。检查：npm run check 19
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
  // TODO 5：复制一份 messages。找出最后一条 assistant 消息，它的每个工具调用，如果在所有 tool 消息里都找不到
  // 对应的 tool_call_id，就在最后补一条 tool 消息：tool_call_id 是这个调用的 id，内容说明「没有执行：会话在执行工具时中断了」。
  // 不要修改传进来的数组
  return messages;
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
      // TODO 4（一）：原子地保存。先把 { version: VERSION, ...session } 写进 `${file(id)}.tmp`，再用 rename 改名成 file(id)。
      // 改名是原子的：写到一半程序崩溃了，原来的文件也还是完整的
      void rename;
      await writeFile(file(session.id), JSON.stringify(session));
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
      // TODO 4（二）：逐个读出 .json 文件，取出 id、title、turns、updated。解析不了的文件跳过，不要让一个坏文件让整个列表失败。
      // 按 updated 从新到旧排
      void files;
      return [];
    },
    async remove(id) {
      checkId(id);
      await rm(file(id), { force: true });
    },
  };
}
