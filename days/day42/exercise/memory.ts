// 第 19 天：长期记忆。对话历史只在一次会话里有效，关掉就没了；记忆跨会话保留：用户的偏好、项目的背景、纠正过的错误。
// 记忆存成一个目录里的 Markdown 文件，一条记忆一个文件，再加一个 MEMORY.md 索引。人能直接打开看、直接改，
// 也能放进版本管理。这和 AGENTS.md、CLAUDE.md 这类「给 Agent 看的说明文件」是一个思路。
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
  { name: '身份证号', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  // 后面跟着 X 的 17 位数字是身份证号，不算银行卡号
  { name: '银行卡号', pattern: /(?<!\d)\d{16,19}(?![\dXx])/ },
  { name: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
];

/** 找出文字里像是敏感信息的东西，返回它们的种类。没有就返回空数组 */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
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
    const memories: Memory[] = [];
    let expired = false;
    for (const f of files) {
      const memory = parseMemory(f.slice(0, -3), await readFile(join(dir, f), 'utf8'));
      if (!memory) continue;
      if (memory.expires && new Date(memory.expires) <= now()) {
        await rm(join(dir, f), { force: true });
        expired = true;
        continue;
      }
      memories.push(memory);
    }
    memories.sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name));
    if (expired) await writeIndex(memories);
    return memories;
  }

  return {
    dir,
    list,
    async remember({ name, type, content, ttlDays }) {
      if (!NAME.test(name)) throw new Error(`记忆的名字「${name}」不行：只能用小写字母、数字和短横线，比如 prefers-short-answers`);
      if (!MEMORY_TYPES.includes(type)) throw new Error(`记忆的类型只能是 ${MEMORY_TYPES.join('、')}`);
      const text = content.trim();
      if (!text) throw new Error('记忆的内容是空的');
      if (text.length > MAX_MEMORY_CHARS) throw new Error(`记忆太长了（${text.length} 个字符，最多 ${MAX_MEMORY_CHARS}）。只记要点；长的内容写进文件，记忆里只记文件在哪`);
      const secrets = findSecrets(text);
      if (secrets.length) {
        throw new Error(`内容里像是有${secrets.join('、')}，这类敏感信息不能写进记忆。告诉用户你没有记下它，建议用户自己妥善保管`);
      }
      const memories = await list();
      const existing = memories.find((m) => m.name === name);
      const timestamp = now().toISOString();
      const memory: Memory = {
        name,
        type,
        content: text,
        created: existing?.created ?? timestamp,
        updated: timestamp,
        ...(ttlDays ? { expires: new Date(now().getTime() + ttlDays * 86_400_000).toISOString() } : {}),
      };
      await mkdir(dir, { recursive: true });
      await writeFile(file(name), serializeMemory(memory));
      await writeIndex([memory, ...memories.filter((m) => m.name !== name)]);
      return { memory, updated: existing !== undefined };
    },
    async forget(name) {
      const memories = await list();
      if (!memories.some((m) => m.name === name)) return false;
      await rm(file(name), { force: true });
      await writeIndex(memories.filter((m) => m.name !== name));
      return true;
    },
    async search(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return (await list()).filter((m) => terms.every((t) => `${m.name} ${m.content}`.toLowerCase().includes(t)));
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
