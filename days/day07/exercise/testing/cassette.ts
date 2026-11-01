// 录制和回放：先用真实模型跑一次，把每次调用的请求和回复存成一个 JSON 文件（叫 cassette，磁带）；
// 之后的测试按顺序重放这些回复，不联网、不花钱，却是真实模型说过的话。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatOptions, ChatRequest, ChatResult, Model } from '../types.ts';

export interface Interaction {
  request: ChatRequest;
  response: ChatResult;
}

export interface Cassette {
  /** 录制时用的模型 */
  model: string;
  recordedAt: string;
  /** 说明，比如这份录制是怎么来的 */
  note?: string;
  interactions: Interaction[];
}

export interface RecordingModel extends Model {
  readonly cassette: Cassette;
  /** 存成 JSON 文件。注意录制里有完整的对话内容，提交到仓库之前看一眼有没有敏感信息 */
  save(file: string): Promise<void>;
}

/** 包装一个模型：照常调用，同时记下每次的请求和回复 */
export function recordModel(model: Model): RecordingModel {
  const cassette: Cassette = { model: model.name, recordedAt: new Date().toISOString(), interactions: [] };
  return {
    name: model.name,
    cassette,
    async chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResult> {
      // TODO 3（上）：照常调用被包装的 model，把请求和回复的副本（structuredClone）
      // 作为 { request, response } 追加到 cassette.interactions，再把回复原样返回
      throw new Error('TODO 3：还没有实现录制');
    },
    async save(file: string) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(cassette, null, 2)}\n`);
    },
  };
}

export async function loadCassette(file: string): Promise<Cassette> {
  return JSON.parse(await readFile(file, 'utf8')) as Cassette;
}

/** 请求里决定模型怎么回答的部分：对话历史和工具定义 */
function fingerprint(request: ChatRequest): string {
  return JSON.stringify({ messages: request.messages, tools: request.tools });
}

/** 找出第一条不一样的消息，让报错更好懂 */
function describeDifference(expected: ChatRequest, actual: ChatRequest): string {
  if (JSON.stringify(expected.tools) !== JSON.stringify(actual.tools)) return '工具定义变了';
  const length = Math.max(expected.messages.length, actual.messages.length);
  for (let i = 0; i < length; i++) {
    const want = JSON.stringify(expected.messages[i]);
    const got = JSON.stringify(actual.messages[i]);
    if (want !== got) return `messages[${i}] 不一样\n录制时：${want}\n现在是：${got}`;
  }
  return '';
}

export interface ReplayModel extends Model {
  /** 还有几次调用没有重放 */
  readonly remaining: number;
}

/** 按顺序重放录好的回复。请求和录制时不一样，就说明代码改变了发给模型的内容，录制已经过期 */
export function replayModel(cassette: Cassette): ReplayModel {
  let index = 0;
  return {
    name: `replay:${cassette.model}`,
    get remaining() {
      return cassette.interactions.length - index;
    },
    async chat(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
      // TODO 3（下）：重放第 index 次调用。
      // - 录制里没有这一次了：抛出错误，信息里写明「录制里只有 N 次调用」
      // - 用 fingerprint() 比较这次的请求和录制时的请求。不一样：说明代码改变了发给模型的内容，录制已经过期。
      //   抛出错误，写明是第几次调用，再附上 describeDifference() 找到的差别
      // - 一样：index 加一；回复里有思考内容就回调 onReasoning，有文字就回调 onText；返回回复的副本
      throw new Error('TODO 3：还没有实现回放');
    },
  };
}
