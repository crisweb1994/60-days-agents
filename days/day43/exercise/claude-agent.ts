// 第 43 天：复用一整套成熟的 Agent 运行时：Claude Agent SDK。
// 它把 Claude Code 的运行时当作一个库：读写文件、执行命令、搜索代码、子 Agent、上下文压缩、会话、权限、hooks、skills 都是现成的。
// 你要做的是「配置和扩展」：给它哪些工具、什么权限、在哪些时刻插入自己的逻辑（hooks）。
// 今天做一个「潮汐文档专员」：能读一个文档目录、能用研究助手的搜索工具（通过进程内的 MCP 服务器），不能改文件、不能乱执行命令，
// 每一次工具调用都写进一份防篡改的审计日志。
//
// 许可：Claude Agent SDK 不是开源许可，使用受 Anthropic 的商业条款约束（见 node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md）。
// 拿它做产品之前，先读条款、确认你的用法被允许。
// 第 43 天的练习：TODO 1–6 都在这个文件里。检查：npm run check 43
// 运行（需要 Anthropic 兼容接口）：node days/day43/exercise/claude-agent.ts "潮汐协议 3.0 的默认端口是多少？"
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createSdkMcpServer, query as sdkQuery, tool as sdkTool, type CanUseTool, type HookCallbackMatcher, type HookEvent, type HookInput, type HookJSONOutput, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { executeChecked } from './frameworks/common.ts';
import { maskPII } from './guardrails.ts';
import type { Tool } from './tool.ts';

// ---------- 审计日志 ----------

export interface AuditRecord {
  /** 从 1 开始的序号 */
  seq: number;
  time: string;
  /** 事件：PreToolUse、PostToolUse、PostToolUseFailure、UserPromptSubmit、SessionEnd…… */
  event: string;
  sessionId: string;
  tool?: string;
  toolUseId?: string;
  /** 工具的参数：打过码、截断过 */
  input?: string;
  /** 工具结果的长度（不记内容） */
  outputChars?: number;
  /** 被拦下、出错的原因 */
  reason?: string;
  /** 上一条的 hash，第一条是 64 个 0 */
  prev: string;
  /** 这一条（不含 hash 自己）的 sha256 */
  hash: string;
}

export type AuditEntry = Omit<AuditRecord, 'seq' | 'time' | 'prev' | 'hash'>;

export interface AuditLog {
  append(entry: AuditEntry): Promise<AuditRecord>;
  readonly file: string;
}

const GENESIS = '0'.repeat(64);

/** 一条记录的 hash：除了 hash 字段，按固定的字段顺序序列化，再算 sha256 */
export function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  const { seq, time, event, sessionId, tool, toolUseId, input, outputChars, reason, prev } = record;
  return createHash('sha256').update(JSON.stringify({ seq, time, event, sessionId, tool, toolUseId, input, outputChars, reason, prev })).digest('hex');
}

/**
 * 只追加的审计日志，存成 JSONL。每一条记下上一条的 hash（哈希链）：改了、删了中间任何一条，后面的链就对不上了。
 * 打开时读出已有的最后一条，接着往下写；同时来的几条要排队写，序号和链才不会乱
 */
export async function openAuditLog(file: string, now: () => Date = () => new Date()): Promise<AuditLog> {
  await mkdir(dirname(file), { recursive: true });
  let last: { seq: number; hash: string } = { seq: 0, hash: GENESIS };
  try {
    const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
    if (lines.length) {
      const record = JSON.parse(lines.at(-1)!) as AuditRecord;
      last = { seq: record.seq, hash: record.hash };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let queue = Promise.resolve();
  return {
    file,
    append(entry) {
      // TODO 1（一）：接在 queue 后面排队执行（写完一条再写下一条）：
      // 记录是 { seq: 上一条的 seq + 1, time: now() 的 ISO 字符串, ...entry, prev: 上一条的 hash }，再加上 hash: hashRecord(前面这些)；
      // 追加一行 JSON 到文件，更新 last，返回这条记录。queue 更新成「这次写完（成功失败都算）」，免得一次失败卡住后面的
      void appendFile; void now; void queue; void last;
      return Promise.reject(new Error(`TODO 1：还没有实现审计日志的 append（${entry.event}）`));
    },
  };
}

/** 检查一份审计日志：序号连续、每条的 prev 等于上一条的 hash、hash 算得对。返回第一处问题 */
export function verifyAuditLog(text: string): { ok: true; count: number } | { ok: false; line: number; problem: string } {
  // TODO 1（二）：逐行检查，返回第一处问题（line 从 1 开始）：
  // 解析不了 →「不是合法的 JSON」；seq 不是行号 →「序号应该是 N，实际是 M」；
  // prev 不等于上一条的 hash（第一条是 GENESIS）→「和上一条接不上：前面的记录被改过或删过」；
  // 去掉 hash 以后用 hashRecord 算出来的不等于 hash →「内容和 hash 对不上：这一条被改过」。都没问题返回 { ok: true, count }
  void GENESIS;
  return { ok: true, count: text.trim().split('\n').filter(Boolean).length };
}

/** 参数写进日志之前：转成文字、敏感信息打码（第 39 天）、截断到 maxChars */
export function redactInput(input: unknown, maxChars = 500): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  const masked = maskPII(text).text;
  return masked.length > maxChars ? `${masked.slice(0, maxChars)}…（共 ${masked.length} 字）` : masked;
}

// ---------- hooks ----------

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

const textLength = (value: unknown) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).length;

/**
 * 审计用的 hooks：每个事件写一条审计记录，然后返回 {}（不干预，让 SDK 照常进行）。
 * - UserPromptSubmit：记下提示词（打码、截断）
 * - PreToolUse：工具名、调用 id、参数（打码、截断）
 * - PostToolUse：工具名、调用 id、结果的长度（不记内容：结果里可能有大量文件内容）
 * - PostToolUseFailure：工具名、调用 id、错误
 * - SessionEnd：会话结束
 * 审计不能因为写日志失败就让 Agent 停下，但也不能悄悄丢掉：写失败交给 onError
 */
export function createAuditHooks(log: AuditLog, onError: (error: unknown) => void = (e) => console.error('写审计日志失败：', e)): Hooks {
  // TODO 2：写一个 record(build)，返回一个 hook：调用 log.append({ event: input.hook_event_name, sessionId: input.session_id, ...build(input) })，
  // append 出错交给 onError（不要抛出），最后返回 {}。然后按上面注释给五个事件各配一个 [{ hooks: [record(…)] }]：
  // UserPromptSubmit 记 input: redactInput(prompt)；PreToolUse 记 tool、toolUseId、input: redactInput(tool_input)；
  // PostToolUse 记 tool、toolUseId、outputChars: textLength(tool_response)；PostToolUseFailure 记 tool、toolUseId、reason: redactInput(error, 300)；SessionEnd 什么都不加。
  // build 里先用 i.hook_event_name 判断一下事件，TypeScript 才知道有哪些字段
  void log; void onError; void textLength;
  return {};
}

/** 危险的命令：删除、提权、下载后直接执行、改权限、往外传数据 */
export const DANGEROUS_COMMANDS: RegExp[] = [/\brm\s+-[a-z]*r[a-z]*f?\b/i, /\bsudo\b/, /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, /\bchmod\s+777\b/, /\b(curl|wget)\b.*(-d|--data|-T|--upload-file)\b/, /\bmkfs\b|\bdd\s+if=/];

/**
 * 一个 PreToolUse 的护栏 hook：Bash 命令命中 DANGEROUS_COMMANDS 就拦下。
 * 拦下的写法是 hookSpecificOutput.permissionDecision = 'deny'，原因会交给模型；同时写一条审计记录（reason 写明命中了什么）
 */
export function createCommandGuard(log?: AuditLog): HookCallbackMatcher {
  // TODO 3：返回 { matcher: 'Bash', hooks: [一个 hook] }。hook 里：
  // 不是 PreToolUse 返回 {}；取出 tool_input.command，找 DANGEROUS_COMMANDS 里第一个匹配的，没有返回 {}；
  // 有就写一条审计记录（event、sessionId、tool、toolUseId、input: redactInput(命令)、reason），
  // 返回 { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }。
  // reason 要包含「安全策略」，告诉模型不要换个写法再试
  void log;
  return { matcher: 'Bash', hooks: [async () => ({})] };
}

/** 把几组 hooks 合在一起：同一个事件的 matcher 按顺序排 */
export function mergeHooks(...groups: Hooks[]): Hooks {
  const merged: Hooks = {};
  for (const group of groups) for (const [event, matchers] of Object.entries(group) as [HookEvent, HookCallbackMatcher[]][]) merged[event] = [...(merged[event] ?? []), ...matchers];
  return merged;
}

// ---------- 权限 ----------

export interface GateOptions {
  /** 允许读的目录。Read、Grep、Glob 只能用在这里面 */
  readRoots: string[];
  /** 允许写的目录。不给就不能写 */
  writeRoot?: string;
  /** 要问用户的工具，比如 WebFetch。问了不同意就拒绝 */
  ask?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
  /** 直接允许的工具（比如 mcp__research__web_search） */
  allow?: string[];
}

/** path 是不是在 root 里面（包括 root 自己）。相对路径按 root 解析 */
export function isInside(root: string, path: string): boolean {
  // TODO 4（一）：用 relative(resolve(root), resolve(root, path)) 算出相对路径：空字符串（就是 root）、
  // 或者不以 .. 开头又不是绝对路径，才算在里面
  void relative; void resolve; void isAbsolute;
  return !path.includes('..');
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * canUseTool：SDK 每次要用一个没被预先允许的工具时问它。和第 29、38 天的权限策略是同一个思路，按工具和参数决定：
 * - allow 里的工具：允许
 * - Read、Grep、Glob：路径（file_path 或 path，没有就是当前目录）在 readRoots 里才允许
 * - Write、Edit、NotebookEdit：路径在 writeRoot 里才允许
 * - ask 能问的：问用户
 * - 其他一律拒绝，message 告诉模型为什么、该怎么办
 */
export function createPermissionGate(options: GateOptions): CanUseTool {
  // TODO 4（二）：按上面注释的顺序判断，返回 { behavior: 'allow', updatedInput: input } 或者 { behavior: 'deny', message }。
  // 路径取 input.file_path ?? input.notebook_path ?? input.path ?? '.'；读的工具和写的工具分别在 READ_TOOLS、WRITE_TOOLS 里；
  // 拒绝的 message：读不了写「只能读这些目录：…」，没有 writeRoot 写「这个 Agent 不能修改文件，把要改的内容告诉用户」，
  // 写到外面写「只能写 … 里面的文件」，其他写「不允许使用 工具名。…」
  void options; void READ_TOOLS; void WRITE_TOOLS;
  return async (_toolName, input) => ({ behavior: 'allow', updatedInput: input });
}

// ---------- 研究助手的工具：进程内的 MCP 服务器 ----------

/** 我们的工具在 MCP 服务器里的处理函数：先校验参数再执行（executeChecked），结果写成 MCP 的文字内容 */
export function toMcpHandler(t: Tool) {
  // TODO 5（一）：返回 async (args) => …：用 executeChecked(t, args) 执行，结果写成 { content: [{ type: 'text', text: 内容 }], isError }
  void executeChecked;
  return async (_args: unknown) => ({ content: [{ type: 'text' as const, text: `TODO 5：还没有实现 ${t.name} 的处理函数` }], isError: true });
}

/**
 * 把研究助手的工具放进一个进程内的 MCP 服务器（createSdkMcpServer）。SDK 里的工具名是 mcp__服务器名__工具名。
 * SDK 的 tool() 要 zod 的「形状」（object 的字段表）：zod object 取 .shape，别的（比如 MCP 转来的工具）给一个空形状
 */
export function createResearchMcpServer(tools: Tool[], name = 'research') {
  return createSdkMcpServer({
    name,
    version: '1.0.0',
    tools: tools.map((t) => sdkTool(t.name, t.description, t.schema instanceof z.ZodObject ? (t.schema.shape as z.ZodRawShape) : {}, toMcpHandler(t))),
  });
}

/** SDK 里的工具名 */
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;

// ---------- 组装 ----------

export interface SpecialistConfig {
  /** 文档目录，Agent 的工作目录 */
  docsRoot: string;
  /** 审计日志 */
  audit: AuditLog;
  /** 研究助手的工具（比如 web_search、fetch_page），放进 MCP 服务器 */
  researchTools?: Tool[];
  /** 问用户要不要允许（比如 WebFetch）。不给就一律拒绝 */
  ask?: GateOptions['ask'];
  /** 最多几轮，默认 20 */
  maxTurns?: number;
  /** 最多花多少美元（SDK 按 Anthropic 的价格估算，用兼容接口时只能参考） */
  maxBudgetUsd?: number;
  /** 环境变量，默认 process.env。模型的地址、Key、模型名从 ANTHROPIC_* 读 */
  env?: NodeJS.ProcessEnv;
}

export const SPECIALIST_PROMPT = `你是潮汐协议的文档专员。回答问题时：
- 先在工作目录的文档里找（Grep、Glob、Read），找不到再用 research 服务器的搜索工具
- 只根据读到的内容回答，写明出自哪个文件或网址
- 你不能修改文件；用户要求修改时，把建议的改动写在回答里`;

/**
 * 组装 query 的选项：
 * - cwd 是文档目录；系统提示词用 Claude Code 的预设，后面追加 SPECIALIST_PROMPT
 * - settingSources: []：不读本机的 ~/.claude、项目的 .claude 配置。服务器上跑的 Agent 不能被开发者本机的设置影响
 * - allowedTools 只预先允许只读的工具和 MCP 的工具；disallowedTools 去掉执行命令以外不需要的危险工具
 * - canUseTool 是 createPermissionGate；hooks 是审计加命令护栏
 * - env：ANTHROPIC_BASE_URL、ANTHROPIC_API_KEY 原样传，ANTHROPIC_MODEL 作为 model
 */
export function buildSpecialistOptions(config: SpecialistConfig): Options {
  // TODO 5（二）：按上面注释组装 Options：
  // - 有 researchTools 才用 createResearchMcpServer 建服务器，mcpServers 是 { research: 服务器 }；MCP 工具的名字用 mcpToolName('research', 工具名)
  // - cwd、systemPrompt（preset claude_code，append SPECIALIST_PROMPT）、settingSources: []、env.ANTHROPIC_MODEL 有值才加 model
  // - allowedTools: ['Read', 'Grep', 'Glob', ...MCP 工具]；disallowedTools: ['Write', 'Edit', 'NotebookEdit']；permissionMode: 'default'
  // - canUseTool: createPermissionGate({ readRoots: [docsRoot], ask, allow: MCP 工具 })
  // - hooks: mergeHooks(createAuditHooks(audit), { PreToolUse: [createCommandGuard(audit)] })
  // - maxTurns；maxBudgetUsd 有值才加；env 复制一份
  void config; void createResearchMcpServer; void mcpToolName; void createPermissionGate; void mergeHooks; void createAuditHooks; void createCommandGuard;
  return {};
}

export interface SpecialistResult {
  /** completed；max_turns：轮数用完；budget：预算用完；error：执行出错 */
  status: 'completed' | 'max_turns' | 'budget' | 'error';
  answer: string;
  turns: number;
  /** SDK 估算的花费（美元） */
  costUsd: number;
  sessionId?: string;
  /** 用过的工具，按顺序 */
  toolUses: string[];
  /** 被拒绝的工具调用 */
  denials: string[];
  errors: string[];
}

/**
 * 跑一次专员。query 可以换成假的（测试用），和第 7 天依赖注入模型是同一个办法。
 * 遍历 SDK 发来的消息：assistant 消息里的 tool_use 块记进 toolUses；result 消息决定结果：
 * success → completed（answer 是 result）；error_max_turns → max_turns；error_max_budget_usd → budget；其他 → error。
 * 没有收到 result 就结束了，也是 error
 */
export async function runSpecialist(prompt: string, config: SpecialistConfig, query: typeof sdkQuery = sdkQuery): Promise<SpecialistResult> {
  // TODO 6：for await 遍历 query({ prompt, options: buildSpecialistOptions(config) })（as AsyncIterable<SDKMessage>）：
  // - type 是 assistant：message.message.content 里 type 为 tool_use 的块，把 name 记进 toolUses
  // - type 是 result：turns 是 num_turns，costUsd 是 total_cost_usd，sessionId 是 session_id，denials 是 permission_denials 的 tool_name；
  //   subtype 是 success → completed，answer 是 result，errors 是 []；error_max_turns → max_turns；error_max_budget_usd → budget；其他 → error；
  //   出错时 answer 是 ''，errors 是 message.errors
  // - 遍历完了也没收到 result：status error，errors 是 ['没有收到结果就结束了']，其他是 0 或空
  void query; void prompt; void config;
  throw new Error('TODO 6：还没有实现 runSpecialist');
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { createInterface } = await import('node:readline/promises');
  const { createTools } = await import('./tools/index.ts');
  const { createSourceRegistry } = await import('./web.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const docsRoot = resolve(process.env.DOCS_DIR ?? 'days/day43/data/docs');
  const audit = await openAuditLog(resolve(process.env.AGENT_WORKSPACE ?? 'workspace', 'audit', 'specialist.jsonl'));
  const web = createTools('/tmp', { search: searchProviderFromEnv(), sources: createSourceRegistry() }).filter((t) => ['web_search', 'fetch_page'].includes(t.name));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const r = await runSpecialist(process.argv.slice(2).join(' ') || '潮汐协议 3.0 的默认端口是多少？', {
    docsRoot,
    audit,
    researchTools: web,
    ask: async (tool, input) => (await rl.question(`允许 ${tool} ${JSON.stringify(input)}？(y/N) `)).trim().toLowerCase() === 'y',
  });
  rl.close();
  console.log(`${r.answer || r.errors.join('\n')}\n\n（${r.status}，${r.turns} 轮，工具：${r.toolUses.join('、') || '无'}，审计日志：${audit.file}）`);
  console.log(verifyAuditLog(await readFile(audit.file, 'utf8')));
}
