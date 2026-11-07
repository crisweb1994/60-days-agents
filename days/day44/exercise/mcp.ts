// 第 13 天：让 mini-agent 成为 MCP host。从配置文件读出要连接的 MCP 服务器，每个服务器一个 client，
// 把服务器提供的工具转换成我们自己的 Tool，和内置的工具放在一起交给模型。
// 连接、版本协商、JSON-RPC 这些协议细节交给官方的 TypeScript SDK（@modelcontextprotocol/client）。
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
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined) throw new Error(`配置里用到了环境变量 ${name}，但是没有设置`);
    return found;
  });
}

/** 递归地展开配置里所有字符串中的 ${VAR} */
function expandAll<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === 'string') return expandEnv(value, env) as T;
  if (Array.isArray(value)) return value.map((item) => expandAll(item, env)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandAll(item, env)])) as T;
  }
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
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_NAME);
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
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
      case 'audio':
        parts.push(`[${block.type === 'image' ? '图片' : '音频'}：${block.mimeType}，没有显示]`);
        break;
      case 'resource_link':
        parts.push(`[资源链接：${block.name} ${block.uri}]`);
        break;
      case 'resource':
        parts.push('text' in block.resource ? block.resource.text : `[二进制资源：${block.resource.uri}，没有显示]`);
        break;
      default:
        parts.push(`[不认识的内容：${(block as { type: string }).type}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join('\n');
}

/**
 * 把一个 MCP 工具包装成我们的 Tool。
 * - 名字加上服务器的前缀，描述里注明来自哪个服务器
 * - 参数直接用服务器给的 JSON Schema，由服务器自己校验
 * - 服务器说出错了（isError），抛出错误：runToolCall 会把它作为出错的结果交回模型
 * - 要不要确认：信任的服务器不用；否则只有标了只读（readOnlyHint）的工具不用
 */
export function wrapMcpTool(client: Pick<Client, 'callTool'>, server: string, definition: McpToolDefinition, trust = false): Tool {
  const readOnly = definition.annotations?.readOnlyHint === true;
  return {
    name: toolName(server, definition.name),
    description: `[来自 MCP 服务器 ${server}] ${definition.description ?? definition.title ?? definition.name}`,
    schema: z.record(z.string(), z.unknown()),
    parameters: definition.inputSchema,
    requiresApproval: !trust && !readOnly,
    async execute(input, { signal }) {
      const result = (await client.callTool({ name: definition.name, arguments: input }, { signal })) as CallToolResult;
      const text = formatToolResult(result);
      if (result.isError) throw new Error(text || 'MCP 服务器返回了错误，但没有说明原因');
      return text;
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
  const entries = Object.entries(config.mcpServers);
  const settled = await Promise.allSettled(entries.map(([name, server]) => connectOne(name, server, options)));
  const clients: Client[] = [];
  const tools: Tool[] = [];
  const servers: McpServerStatus[] = [];
  settled.forEach((outcome, i) => {
    const name = entries[i][0];
    if (outcome.status === 'rejected') {
      servers.push({ name, status: 'failed', tools: [], error: (outcome.reason as Error).message });
      return;
    }
    clients.push(outcome.value.client);
    const status: McpServerStatus = { ...outcome.value.status };
    for (const tool of outcome.value.tools) {
      if (tools.some((t) => t.name === tool.name)) {
        status.error = `工具名 ${tool.name} 和别的工具重复了，没有加载`;
        continue;
      }
      tools.push(tool);
    }
    servers.push(status);
  });
  return {
    tools,
    servers,
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}
