// 第 39 天：生成内容的标识。《人工智能生成合成内容标识办法》（国家网信办等四部门，2025 年 9 月 1 日起施行）要求
// 面向公众提供生成合成服务的，给生成的内容加上标识：
//   显式标识：用户能明显感知到的，比如文字的开头或结尾写明「由人工智能生成」
//   隐式标识：写进文件元数据的，用户不容易察觉，用来追溯：内容属性、服务提供者、内容编号等
// 配套的强制性国家标准是 GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》。
// 这里的写法是一个示意：字段名参照标准里的 Label、ContentProducer、ProduceID、ContentPropagator、PropagateID，
// 具体的位置、格式和取值，上线之前要以标准的原文和你的合规顾问的意见为准。
// 第 39 天的练习：TODO 6 在这里。检查：npm run check 39
import { randomUUID } from 'node:crypto';

export const EXPLICIT_LABEL = '本内容由人工智能生成，仅供参考，请注意甄别。';

export interface ImplicitLabel {
  /** 1 表示是生成合成的内容 */
  Label: '1';
  /** 服务提供者的名称或者编码 */
  ContentProducer: string;
  /** 内容的编号，同一份内容唯一 */
  ProduceID: string;
  /** 传播服务提供者（转发、发布这份内容的平台），没有可以不填 */
  ContentPropagator?: string;
  PropagateID?: string;
}

/** 生成一个隐式标识。ProduceID 不传就随机生成一个 */
export function implicitLabel(producer: string, produceId: string = randomUUID()): ImplicitLabel {
  return { Label: '1', ContentProducer: producer, ProduceID: produceId };
}

/**
 * 给一段要交给用户的文字加上显式标识。where 是 start 时加在开头一行，end 时加在末尾（中间空一行）。
 * 已经带着标识的不重复加
 */
export function addExplicitLabel(text: string, where: 'start' | 'end' = 'end', label = EXPLICIT_LABEL): string {
  // TODO 6（一）：已经带着 label 的原样返回；start 时 label 加在开头、空一行；end 时空一行加在末尾
  void where;
  void label;
  return text;
}

/**
 * 导出成 Markdown 文件时，显式标识和隐式标识都加上：
 * 隐式标识写进文件开头的 front matter（--- 包着的 YAML），键是 AIGC，值是 JSON；正文末尾加上显式标识
 */
export function labelMarkdown(text: string, label: ImplicitLabel): string {
  // TODO 6（二）：开头是 front matter：---、一行「AIGC: 」加上 JSON.stringify(label)、---，再空一行；
  // 后面是加上显式标识（末尾）的正文
  void label;
  return text;
}

/** 读出 Markdown 文件里的隐式标识。没有、或者格式不对返回 undefined */
export function readImplicitLabel(markdown: string): ImplicitLabel | undefined {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  const line = match?.[1].split('\n').find((l) => l.startsWith('AIGC: '));
  if (!line) return undefined;
  try {
    const data = JSON.parse(line.slice('AIGC: '.length)) as ImplicitLabel;
    return data.Label === '1' && typeof data.ProduceID === 'string' ? data : undefined;
  } catch {
    return undefined;
  }
}
