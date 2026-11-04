// 第 19 天：长期记忆。对话历史只在一次会话里有效，关掉就没了；记忆跨会话保留：用户的偏好、项目的背景、纠正过的错误。
// 记忆存成一个目录里的 Markdown 文件，一条记忆一个文件，再加一个 MEMORY.md 索引。人能直接打开看、直接改，
// 也能放进版本管理。这和 AGENTS.md、CLAUDE.md 这类「给 Agent 看的说明文件」是一个思路。
// 第 19 天的练习：TODO 1–3 在这里，TODO 4、5 在 session-store.ts。检查：npm run check 19
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DynamicSection } from './context.ts';

/**
 * 记忆的类型：
 * - user：用户是谁、有什么偏好（「回答要简短」「在用 Kubernetes」）
 * - feedback：用户纠正过的做法（「引用要放在句末，不要放在开头」）
 * - project：正在做的事、背景和约束（「报告周五要交给老板」）
 * - reference：外部资源的位置（「监控大盘在 grafana.example.com」）
 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface Memory {
  /** 短横线连接的英文名字，也是文件名，比如 prefers-short-answers */
  name: string;
  type: MemoryType;
  content: string;
  /** ISO 格式的日期时间 */
  created: string;
  updated: string;
  /** 过了这个时间就忘掉。不填就一直记着 */
  expires?: string;
}

// ---------- 隐私 ----------

/** 不该记下来的东西：密钥、证件号、银行卡号、手机号。记忆是明文存在硬盘上的，还会被放进每一次请求 */
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'API Key', pattern: /\b(sk|tvly|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{16,}/ },
  { name: 'AWS 密钥', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: '令牌', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: '私钥', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // TODO 1（一）：补上身份证号、银行卡号、手机号的正则：
  // - 身份证号：17 位数字，最后一位是数字或者 X（大小写都算）
  // - 银行卡号：16 到 19 位数字。注意不要把身份证号（17 位数字加 X）也当成银行卡号
  // - 手机号：1 开头，第二位是 3 到 9，一共 11 位
  // 前后都不能紧挨着别的数字（用 (?<!\d) 和 (?!\d)），不然一个很长的数字串里任何一段都会被当成手机号
];

/** 找出文字里像是敏感信息的东西，返回它们的种类。没有就返回空数组 */
export function findSecrets(text: string): string[] {
  // TODO 1（二）：用 SECRET_PATTERNS 逐个检查，返回匹配上的那些的 name
  void SECRET_PATTERNS;
  return text.includes('sk-') ? ['API Key'] : [];
}

// ---------- 文件格式 ----------

/** 一条记忆写成文件：开头是 --- 包起来的元数据，后面是内容 */
export function serializeMemory(memory: Memory): string {
  const meta = [`type: ${memory.type}`, `created: ${memory.created}`, `updated: ${memory.updated}`];
  if (memory.expires) meta.push(`expires: ${memory.expires}`);
  return `---\n${meta.join('\n')}\n---\n\n${memory.content}\n`;
}

/** 读回一条记忆。格式不对（比如人手改坏了）就返回 undefined，跳过这一条，不影响其他的 */
export function parseMemory(name: string, text: string): Memory | undefined {
  const match = text.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return undefined;
  const meta: Record<string, string> = Object.fromEntries(
    match[1].split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  if (!MEMORY_TYPES.includes(meta.type as MemoryType) || !meta.created || !meta.updated) return undefined;
  return {
    name,
    type: meta.type as MemoryType,
    content: match[2].trim(),
    created: meta.created,
    updated: meta.updated,
    ...(meta.expires ? { expires: meta.expires } : {}),
  };
}

// ---------- 记忆库 ----------

export interface RememberInput {
  name: string;
  type: MemoryType;
  content: string;
  /** 多少天以后忘掉。不填就一直记着 */
  ttlDays?: number;
}

export interface MemoryStore {
  readonly dir: string;
  /** 所有没过期的记忆，最近更新的在前面。过期的会被删掉 */
  list(): Promise<Memory[]>;
  /** 记下一条。同名的已经存在就更新它（保留创建时间），不会出现两条重复的记忆 */
  remember(input: RememberInput): Promise<{ memory: Memory; updated: boolean }>;
  /** 忘掉一条。返回有没有这一条 */
  forget(name: string): Promise<boolean>;
  /** 按关键词找记忆：名字或内容里包含每一个关键词（不区分大小写） */
  search(query: string): Promise<Memory[]>;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** 一条记忆最多多少个字符。记忆是要放进每一次请求的，长篇大论应该写进文件 */
export const MAX_MEMORY_CHARS = 500;

export function createMemoryStore(dir: string, now: () => Date = () => new Date()): MemoryStore {
  const file = (name: string) => join(dir, `${name}.md`);

  /** 重写索引文件 MEMORY.md：每条记忆一行，人打开目录就能看到全貌 */
  async function writeIndex(memories: Memory[]) {
    const lines = memories.map((m) => `- [${m.name}](${m.name}.md)（${m.type}）${m.content.split('\n')[0].slice(0, 80)}`);
    await writeFile(join(dir, 'MEMORY.md'), `# 记忆\n\n${lines.join('\n')}\n`);
  }

  async function list(): Promise<Memory[]> {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    // TODO 3（一）：逐个读出记忆文件，用 parseMemory 解析，解析不了的跳过。
    // - 有 expires、并且已经过了（new Date(expires) <= now()）：删掉这个文件，记下有过期的，不放进结果
    // - 结果按 updated 从新到旧排，一样新的按名字排
    // - 有过期的时候，用 writeIndex 重写索引
    const memories: Memory[] = [];
    const expired = false;
    for (const f of files) {
      const memory = parseMemory(f.slice(0, -3), await readFile(join(dir, f), 'utf8'));
      if (memory) memories.push(memory);
    }
    void rm;
    if (expired) await writeIndex(memories);
    return memories;
  }

  return {
    dir,
    list,
    async remember({ name, type, content, ttlDays }) {
      // TODO 2：记下一条记忆。
      // - 检查：名字符合 NAME，类型是 MEMORY_TYPES 之一，内容去掉首尾空白以后不是空的、不超过 MAX_MEMORY_CHARS，
      //   没有 findSecrets 找得到的敏感信息。不符合就抛出错误，说清楚为什么，让模型知道怎么改、该怎么告诉用户
      // - 同名的记忆已经存在：保留它的 created，更新 updated；不存在：created 和 updated 都是现在
      // - 有 ttlDays 时，expires 是现在加上这么多天（ISO 格式）
      // - 建好目录（mkdir 加 recursive），用 serializeMemory 写进 file(name)，再用 writeIndex 重写索引
      //   （新的这条放在最前面，其他的去掉同名的那条）。返回 { memory, updated: 是不是更新了已有的 }
      void NAME;
      void ttlDays;
      void writeIndex;
      const timestamp = now().toISOString();
      const memory: Memory = { name, type, content, created: timestamp, updated: timestamp };
      await mkdir(dir, { recursive: true });
      await writeFile(file(name), serializeMemory(memory));
      return { memory, updated: false };
    },
    async forget(name) {
      const memories = await list();
      if (!memories.some((m) => m.name === name)) return false;
      await rm(file(name), { force: true });
      await writeIndex(memories.filter((m) => m.name !== name));
      return true;
    },
    async search(query) {
      // TODO 3（二）：关键词按空白分开，转成小写；名字或内容（也转成小写）里包含每一个关键词的记忆才算
      return (await list()).filter((m) => m.content.includes(query));
    },
  };
}

/**
 * 把记忆放进每一轮的动态信息（第 15 天）。最近更新的优先，总长度不超过 maxChars；放不下的只列名字，模型需要时用 recall 查。
 * 记忆会变，所以放在动态信息里，不放在 system prompt 里：放在 system prompt 里，每记一条，缓存就失效一次
 */
export async function memorySection(store: MemoryStore, maxChars = 2000): Promise<DynamicSection | undefined> {
  const memories = await store.list();
  if (memories.length === 0) return undefined;
  const lines: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const m of memories) {
    const line = `- ${m.name}（${m.type}）：${m.content.replace(/\n+/g, ' ')}`;
    if (total + line.length > maxChars) skipped.push(m.name);
    else {
      lines.push(line);
      total += line.length;
    }
  }
  if (skipped.length) lines.push(`（还有 ${skipped.length} 条没列出：${skipped.join('、')}。需要时用 recall 查）`);
  return { label: 'memory', content: `你记得的关于用户和项目的事：\n${lines.join('\n')}`, priority: 5 };
}
