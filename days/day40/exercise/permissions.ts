// 第 29 天：按风险给工具分级。不是每个工具都要问用户：读网页不用问，写文件要问，发出去就收不回来的更要问。
//   read          只读，没有副作用：搜索、读网页、读文件、计算
//   write         有副作用，但可以撤销或者影响有限：写工作目录里的文件、改记忆
//   irreversible  做了就收不回来：发 POST 请求（数据发出去了）、提交表单、付款、发邮件
// 每一级默认怎么处理，由权限策略决定：允许（allow）、问用户（ask）、禁止（deny）。
import type { Tool } from './tool.ts';

export const RISKS = ['read', 'write', 'irreversible'] as const;
export type Risk = (typeof RISKS)[number];

export type Decision = 'allow' | 'ask' | 'deny';

export interface PermissionPolicy {
  /** 每一级风险默认怎么处理 */
  read: Decision;
  write: Decision;
  irreversible: Decision;
  /** 按工具名覆盖默认的处理，比如 { remember: 'allow', http_request: 'deny' } */
  tools?: Record<string, Decision>;
}

/** 默认的策略：只读的直接执行，其他的都问用户。记忆是写操作，但每次都问太打扰，默认允许 */
export const DEFAULT_POLICY: PermissionPolicy = {
  read: 'allow',
  write: 'ask',
  irreversible: 'ask',
  tools: { remember: 'allow', forget: 'allow' },
};

/** 一个工具调用的风险。工具自己声明了 risk 就用它（可以按参数判断）；没有声明的，要确认的算 write，其他的算 read */
export function riskOf(tool: Tool, input: unknown): Risk {
  if (tool.risk) return typeof tool.risk === 'function' ? tool.risk(input) : tool.risk;
  const needsApproval = typeof tool.requiresApproval === 'function' ? tool.requiresApproval(input) : tool.requiresApproval === true;
  return needsApproval ? 'write' : 'read';
}

/**
 * 决定一个工具调用怎么处理：
 * 1. 策略里按工具名写了的，用它
 * 2. 否则看风险等级的默认处理
 * 3. 结果是 ask、而用户在这次会话里已经说过「这个工具都可以」（grants 里有它）：改成 allow。
 *    不可逆的操作不吃这一套，每次都要问：「以后都可以」很容易在不经意间放过一次付款
 */
export function decide(policy: PermissionPolicy, tool: Tool, input: unknown, grants: ReadonlySet<string> = new Set()): Decision {
  const risk = riskOf(tool, input);
  const decision = policy.tools?.[tool.name] ?? policy[risk];
  if (decision === 'ask' && risk !== 'irreversible' && grants.has(tool.name)) return 'allow';
  return decision;
}

const RISK_NAMES: Record<Risk, string> = { read: '只读', write: '可写', irreversible: '不可逆' };

/** 给人看的风险等级：只读、可写、不可逆 */
export function describeRisk(risk: Risk): string {
  return RISK_NAMES[risk];
}
