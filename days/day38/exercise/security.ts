// 第 38 天：权限的其他几道墙。
//   网络白名单：http_request 只能访问列出来的域名
//   密钥不进上下文：模型只看到 {{secret:名字}}，执行工具时才换成真的值；工具的结果里出现了密钥，换回占位符
//   MCP 工具投毒：别人写的工具描述也是不可信的内容。上线前检查描述，记下每个工具的指纹，之后变了就报警
// 第 38 天的练习：TODO 3–5 在这里。检查：npm run check 38
import { createHash } from 'node:crypto';
import { scanForInjection } from './injection.ts';
import { toToolDefinition, type Tool } from './tool.ts';

// ---------- 网络白名单 ----------

/**
 * 主机名在不在白名单里。白名单的每一项是一个域名（只匹配它自己）或者 *.域名（匹配它的子域名，不包括它自己）。
 * 不区分大小写；网址解析不了、不是 http 或 https，都不在白名单里
 */
export function hostAllowed(url: string, allow: string[]): boolean {
  // TODO 3：用 new URL 解析（解析不了返回 false），只认 http 和 https；
  // 主机名转成小写，和白名单的每一项比较：*.域名 匹配它的子域名（以 .域名 结尾），其他的要完全相等
  void url;
  void allow;
  return true;
}

/** 给几个联网的工具加上白名单：url 参数不在白名单里就拦下。不联网的工具原样返回 */
export function withNetworkAllowlist(tools: Tool[], allow: string[], networkTools = ['http_request']): Tool[] {
  return tools.map((tool) =>
    networkTools.includes(tool.name)
      ? {
          ...tool,
          execute(input, context) {
            const url = (input as { url?: string }).url ?? '';
            if (!hostAllowed(url, allow)) throw new Error(`网络策略不允许访问 ${url}。能访问的域名：${allow.join('、')}`);
            return tool.execute(input, context);
          },
        }
      : tool,
  );
}

// ---------- 密钥 ----------

/** 占位符的写法：{{secret:名字}}，名字是字母、数字、下划线 */
export const SECRET_PATTERN = /\{\{secret:(\w+)\}\}/g;

/** 递归地把参数里所有字符串的占位符换成真的值。用到了没有的密钥就抛出错误 */
export function fillSecrets(value: unknown, secrets: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(SECRET_PATTERN, (_, name: string) => {
      if (!(name in secrets)) throw new Error(`没有名为 ${name} 的密钥`);
      return secrets[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillSecrets(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillSecrets(v, secrets)]));
  return value;
}

/** 文字里出现的密钥值换回占位符。长的先换：一个密钥是另一个的一部分时，不会换错。太短的值（不到 8 个字符）不换，免得误伤 */
export function maskSecrets(text: string, secrets: Record<string, string>): string {
  // TODO 4（一）：去掉不到 8 个字符的值，按值的长度从长到短，把文字里的每个值换成 {{secret:名字}}
  void secrets;
  return text;
}

/**
 * 给工具加上密钥：
 * - 只有 allowedTools 里的工具能用密钥：别的工具的参数里出现了占位符，抛出错误「工具 X 不能使用密钥」。
 *   不然模型（或者注入）可以让 write_file 把 {{secret:API_KEY}} 写进文件
 * - 执行前用 fillSecrets 换成真的值；执行后结果是字符串的，用 maskSecrets 换回占位符（不是字符串的先 JSON.stringify）
 * - 工具描述的末尾告诉模型有哪些密钥可以用（只给名字）
 */
export function withSecrets(tools: Tool[], secrets: Record<string, string>, allowedTools: string[]): Tool[] {
  const names = Object.keys(secrets);
  return tools.map((tool) => {
    const allowed = allowedTools.includes(tool.name);
    return {
      ...tool,
      description: allowed && names.length ? `${tool.description}。需要密钥时写占位符 {{secret:名字}}，执行时会换成真的值，可用的有：${names.join('、')}` : tool.description,
      async execute(input, context) {
        // TODO 4（二）：
        // - 用 SECRET_PATTERN 看参数（JSON.stringify(input ?? null)）里有没有占位符；有、但这个工具没授权（allowed），
        //   抛出「工具 X 不能使用密钥」
        // - 有占位符就用 fillSecrets 换成真的值再执行；结果是 undefined 原样返回，
        //   否则（不是字符串的先 JSON.stringify）用 maskSecrets 换回占位符
        void allowed;
        return tool.execute(input, context);
},
    };
  });
}

// ---------- MCP 工具投毒 ----------

/** 工具描述里可疑的地方。除了第 37 天的那些，还有：提到敏感的文件、要求先调用别的工具、看不见的字符 */
const TOOL_RED_FLAGS: [RegExp, string][] = [
  [/~\/\.ssh|id_rsa|\.env\b|\/etc\/passwd|credentials|私钥|密码/i, '提到了敏感的文件或凭据'],
  [/(调用|使用)(这个|本)工具(之前|前)|before (calling|using) this tool/i, '要求在调用之前做别的事'],
  [/[​-‏⁠-⁤﻿]/, '有看不见的字符'],
];

export interface ToolAuditFinding {
  tool: string;
  reason: string;
}

/** 检查工具的描述和参数说明（整个工具定义的 JSON）。和第 37 天一样，只能发现明显的问题，发现了要人看 */
export function auditTools(tools: Tool[]): ToolAuditFinding[] {
  return tools.flatMap((tool) => {
    const text = JSON.stringify(toToolDefinition(tool));
    const reasons = [...scanForInjection(text).map((f) => f.reason), ...TOOL_RED_FLAGS.filter(([p]) => p.test(text)).map(([, r]) => r)];
    return [...new Set(reasons)].map((reason) => ({ tool: tool.name, reason }));
  });
}

/** 工具的指纹：工具定义（名字、描述、参数）的 SHA-256，前 16 位 */
export function fingerprintTool(tool: Tool): string {
  return createHash('sha256').update(JSON.stringify(toToolDefinition(tool))).digest('hex').slice(0, 16);
}

/** 记下一组工具的指纹，存起来，下次连接时比较 */
export function pinTools(tools: Tool[]): Record<string, string> {
  return Object.fromEntries(tools.map((t) => [t.name, fingerprintTool(t)]));
}

export interface PinCheck {
  /** 定义变了的工具：最要警惕，「先装一个好的，审核过了再换成坏的」（rug pull）就是这样 */
  changed: string[];
  added: string[];
  removed: string[];
}

/** 和记下的指纹比较。changed、added、removed 都按名字排序 */
export function checkPins(tools: Tool[], pins: Record<string, string>): PinCheck {
  // TODO 5：用 pinTools 算出现在的指纹，和 pins 比较：两边都有但不一样的是 changed，只有现在有的是 added，
  // 只有 pins 里有的是 removed，都按名字排序
  void pins;
  void tools;
  return { changed: [], added: [], removed: [] };
}
