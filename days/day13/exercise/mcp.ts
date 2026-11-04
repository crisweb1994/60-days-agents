// 第 13 天：让 mini-agent 成为 MCP host。从配置文件读出要连接的 MCP 服务器，每个服务器一个 client，
// 把服务器提供的工具转换成我们自己的 Tool，和内置的工具放在一起交给模型。
// 连接、版本协商、JSON-RPC 这些协议细节交给官方的 TypeScript SDK（@modelcontextprotocol/client）。
// 第 13 天的练习：TODO 1–4 都在这里。检查：npm run check 13
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool as McpToolDefinition } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import type { Tool } from './tool.ts';

// ---------- 配置 ----------

const common = {
  /** 信任这个服务器：它的工具执行前不用确认。默认只有标了 readOnlyHint 的工具不用确认 */
  trust: z.boolean().optional(),
  /** 用哪个版本的协议：auto 先试 2026-07-28，不行就退回老版本；legacy 只用老版本的握手 */
  protocol: z.enum(['auto', 'legacy']).optional(),
};

/** 本地的服务器：启动一个子进程，通过标准输入输出通信 */
const stdioSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  ...common,
});

/** 远程的服务器：通过 Streamable HTTP 通信 */
const httpSchema = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
  ...common,
});

/** 和 Claude Desktop、Cursor 等常见的 host 一样的格式：{ "mcpServers": { "名字": { … } } } */
const configSchema = z.object({
  mcpServers: z.record(z.string(), z.union([stdioSchema, httpSchema])),
});

export type McpServerConfig = z.infer<typeof stdioSchema> | z.infer<typeof httpSchema>;
export type McpConfig = z.infer<typeof configSchema>;

/** 把字符串里的 ${VAR} 换成环境变量的值。API Key 不要直接写在配置文件里，写成 ${GITHUB_TOKEN} */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  // TODO 1（一）：把 value 里的每个 ${VAR} 换成 env[VAR]。VAR 由字母、数字、下划线组成。
  // env 里没有这个变量时抛出错误，错误信息里要有变量名，用户才知道该设置哪个
  return value;
}

/** 递归地展开配置里所有字符串中的 ${VAR} */
function expandAll<T>(value: T, env: NodeJS.ProcessEnv): T {
  // TODO 1（二）：字符串用 expandEnv 展开；数组逐项展开；对象逐个值展开（键不动）；其他类型原样返回。
  // args、env、headers 里都可能有 ${VAR}，它们嵌套在不同的层级，所以要递归
  void expandEnv;
  void env;
  return value;
}

/** 校验配置并展开环境变量。格式不对时抛出错误，说明是哪个字段 */
export function parseMcpConfig(data: unknown, env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) throw new Error(`MCP 配置的格式不对：\n${z.prettifyError(parsed.error)}`);
  // 服务器的名字会成为工具名的前缀，只能用模型那边允许的字符
  for (const name of Object.keys(parsed.data.mcpServers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`MCP 服务器的名字「${name}」不行：只能用字母、数字、下划线和连字符`);
  }
  return expandAll(parsed.data, env);
}

/** 读取配置文件。文件不存在就返回 undefined：没有配置 MCP 服务器，Agent 照样能用 */
export async function loadMcpConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<McpConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} 不是合法的 JSON：${(error as Error).message}`);
  }
  return parseMcpConfig(data, env);
}

// ---------- 工具的转换 ----------

/** 模型那边对工具名有限制：只能用字母、数字、下划线和连字符，最长 64 个字符 */
const MAX_NAME = 64;

/**
 * 给 MCP 工具起一个不会重名的名字：服务器名__工具名。不同的服务器可能都有叫 search 的工具，加上前缀就分得开。
 * 不允许的字符换成 _；太长时截短
 */
export function toolName(server: string, tool: string): string {
  // TODO 2（一）：拼成「服务器名__工具名」，不是字母、数字、下划线、连字符的字符换成 _，最后截到 MAX_NAME 个字符
  void MAX_NAME;
  return tool;
}

/**
 * 把 MCP 工具的结果转成交给模型的文字。结果是一组内容块：
 * - text：原样拼起来
 * - image、audio：模型这边只能收文字，写一个占位说明
 * - resource_link：写出名字和地址
 * - resource：嵌入的资源，有文字就放文字，二进制的写一个占位说明
 * 没有任何内容块、只有 structuredContent 时，把它转成 JSON
 */
export function formatToolResult(result: CallToolResult): string {
  // TODO 2（二）：按上面注释里的规则，把 result.content 的每个内容块转成一段文字，用换行连起来：
  // - text：block.text
  // - image、audio：[图片：mimeType，没有显示]、[音频：mimeType，没有显示]
  // - resource_link：[资源链接：名字 地址]
  // - resource：block.resource 里有 text 就用 text，没有就是 [二进制资源：地址，没有显示]
  // - 其他：[不认识的内容：type]
  // 一个内容块都没有、但有 structuredContent 时，返回 JSON.stringify(structuredContent)
  return JSON.stringify(result.content);
}

/**
 * 把一个 MCP 工具包装成我们的 Tool。
 * - 名字加上服务器的前缀，描述里注明来自哪个服务器
 * - 参数直接用服务器给的 JSON Schema，由服务器自己校验
 * - 服务器说出错了（isError），抛出错误：runToolCall 会把它作为出错的结果交回模型
 * - 要不要确认：信任的服务器不用；否则只有标了只读（readOnlyHint）的工具不用
 */
export function wrapMcpTool(client: Pick<Client, 'callTool'>, server: string, definition: McpToolDefinition, trust = false): Tool {
  // TODO 3：返回一个 Tool：
  // - name：用 toolName 加上服务器的前缀；description：「[来自 MCP 服务器 服务器名] 」加上工具的描述（没有就用 title 或者 name）
  // - schema：z.record(z.string(), z.unknown())，只要求参数是个对象；parameters：服务器给的 definition.inputSchema
  // - requiresApproval：信任的服务器（trust）不用确认；否则只有 definition.annotations?.readOnlyHint 为 true 的工具不用确认
  // - execute：client.callTool({ name: 原来的工具名, arguments: input }, { signal })，再用 formatToolResult 转成文字。
  //   结果的 isError 为 true 时抛出错误（没有文字就说明服务器没说原因），runToolCall 会把它作为出错的结果交回模型
  void client;
  void trust;
  return {
    name: definition.name,
    description: definition.description ?? '',
    schema: z.object({}),
    execute: () => {
      throw new Error(`TODO 3：还没有包装 MCP 工具 ${server}/${definition.name}`);
    },
  };
}

// ---------- 连接 ----------

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed';
  /** 协商出来的协议版本，比如 2026-07-28 或 2025-11-25 */
  protocolVersion?: string;
  /** 服务器自己报的名字和版本 */
  serverInfo?: string;
  tools: string[];
  error?: string;
}

export interface McpHost {
  /** 所有服务器的工具，已经转换成我们的 Tool */
  readonly tools: Tool[];
  readonly servers: McpServerStatus[];
  /** 断开所有连接；本地的服务器子进程也会退出 */
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** 连接一个服务器最多等多久，默认 30 秒 */
  timeoutMs?: number;
  /** 本地服务器的 stderr（日志）要不要显示，默认不显示 */
  showServerLogs?: boolean;
}

/** 按配置创建传输层：有 command 的是本地服务器，有 url 的是远程服务器 */
function createTransport(config: McpServerConfig, showLogs: boolean) {
  if ('command' in config) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      // 子进程默认只继承 PATH、HOME 这些安全的环境变量，不会把你的 API Key 都传过去。要传什么，写在 env 里
      env: { ...getDefaultEnvironment(), ...config.env },
      cwd: config.cwd,
      stderr: showLogs ? 'inherit' : 'ignore',
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
}

/** 连接一个服务器，列出它的工具 */
async function connectOne(name: string, config: McpServerConfig, options: ConnectOptions) {
  const client = new Client(
    { name: 'mini-agent', version: '0.13.0' },
    { versionNegotiation: { mode: config.protocol === 'legacy' ? 'legacy' : 'auto' } },
  );
  await client.connect(createTransport(config, options.showServerLogs ?? false), { timeout: options.timeoutMs ?? 30_000 });
  try {
    const { tools } = await client.listTools();
    const info = client.getServerVersion();
    return {
      client,
      tools: tools.map((definition) => wrapMcpTool(client, name, definition, config.trust)),
      status: {
        name,
        status: 'connected' as const,
        protocolVersion: client.getNegotiatedProtocolVersion(),
        serverInfo: info ? `${info.name} ${info.version}` : undefined,
        tools: tools.map((t) => t.name),
      },
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

/**
 * 连接配置里的所有服务器。同时连接；某个服务器连不上，记下原因，不影响其他的。
 * 所有服务器的工具合在一起，名字冲突时（截短以后撞上了）后面的不要，并记在 error 里
 */
export async function connectMcpServers(config: McpConfig, options: ConnectOptions = {}): Promise<McpHost> {
  // TODO 4：连接所有服务器，合并它们的工具。
  // - 用 Promise.allSettled 同时连接每一个服务器（connectOne 已经写好了）：某个服务器连不上，不能让其他的也失败
  // - 连不上的：在 servers 里记一条 { name, status: 'failed', tools: [], error: 错误信息 }
  // - 连上的：记下它的 client（close 时要断开）和 status；它的工具逐个放进 tools。
  //   和已有的工具重名时（截短以后可能撞上），这个工具不要，并在这个服务器的 status.error 里说明
  // - servers 的顺序和配置里的一样；close() 断开所有 client，某个断开出错也不影响其他的
  void connectOne;
  void options;
  throw new Error(`TODO 4：还没有连接 MCP 服务器（${Object.keys(config.mcpServers).join('、')}）`);
}
