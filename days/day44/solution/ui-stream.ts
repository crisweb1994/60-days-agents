// 第 44 天：把研究助手的过程变成一条「UI 消息流」，推给网页实时显示。
// 格式用 Vercel AI SDK 的 UI Message Stream 协议（SSE，每个事件的 data 是一个 JSON 块，最后是 [DONE]）：
//   start → tool-input-available / tool-output-available（每次工具调用）→ text-start / text-delta / text-end（每一步的文字）
//   → data-progress（深度研究的阶段）→ source-url（引用的来源）→ data-answer（最终的回答）→ finish
// 用现成的协议，前端可以直接用 AI SDK 的 useChat（React），也可以像 public/app.js 那样自己解析；
// 我们没有用 AI SDK 的 streamText 生成它，而是从研究助手的回调里一块块拼出来：研究助手的循环还是自己的（第 42 天）。
import type { UIMessageChunk } from 'ai';
import { describeStatus } from './agent.ts';
import { addExplicitLabel } from './compliance.ts';
import { deepResearch, type DeepResearchEvent } from './deep-research.ts';
import { research, type ResearchSetup } from './research.ts';
import type { ToolCall, Model } from './types.ts';
import type { ToolResult } from './tool.ts';
import { FALLBACK_REPLY } from './guardrails.ts';

/** 我们会发的块：AI SDK 协议里的一部分，加上两种自定义的 data 块 */
export type ResearchChunk =
  | Extract<UIMessageChunk, { type: 'start' | 'finish' | 'abort' | 'error' | 'text-start' | 'text-delta' | 'text-end' | 'tool-input-available' | 'tool-output-available' | 'tool-output-error' | 'source-url' }>
  | { type: 'data-progress'; id?: string; data: ProgressData }
  | { type: 'data-answer'; data: AnswerData };

/** 深度研究进行到哪一步 */
export type ProgressData =
  | { stage: 'plan'; subquestions: string[] }
  | { stage: 'subagent'; index: number; question: string; status: string }
  | { stage: 'report' }
  | { stage: 'verify'; problems: number };

/** 最终的回答：带来源列表和生成内容标识的全文，以及研究为什么停下 */
export interface AnswerData {
  text: string;
  status: string;
  /** 没有正常完成时给用户看的说明（第 6 天的 describeStatus） */
  note?: string;
}

/** 一块变成一个 SSE 事件 */
export function toSSE(chunk: ResearchChunk | '[DONE]'): string {
  return `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`;
}

/** UI 消息流的响应头。x-vercel-ai-ui-message-stream 告诉 AI SDK 的前端这是哪个版本的协议；x-accel-buffering 让 nginx 别攒着不发 */
export const UI_STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
} as const;

const MAX_OUTPUT_CHARS = 2000;

/** 工具结果交给界面之前截断：网页正文可能有几万字，界面只要看个大概 */
export function previewOutput(content: string, max = MAX_OUTPUT_CHARS): string {
  return content.length > max ? `${content.slice(0, max)}…（共 ${content.length} 字）` : content;
}

/**
 * 把研究助手的回调变成块。返回的对象有一组回调，交给 research() 或 deepResearch()：
 * - onToolStart：tool-input-available（dynamic: true，界面事先不知道有哪些工具；参数解析成对象，解析不了就用原文）
 * - onToolCall：结果是错误就 tool-output-error（errorText），否则 tool-output-available（output 截断过）
 * - onText：这一步还没开始文字就先发 text-start（id 是 text-1、text-2……），再发 text-delta
 * - onUsage：一次模型调用结束：有没结束的文字就发 text-end
 * - onDeepEvent：深度研究的事件变成 data-progress
 * 文字块的 id 每一步一个，界面才能把每一步的文字分开显示
 */
export function createChunkEmitter(emit: (chunk: ResearchChunk) => void) {
  let textId: string | undefined;
  let count = 0;
  const closeText = () => {
    if (textId) emit({ type: 'text-end', id: textId });
    textId = undefined;
  };
  return {
    onToolStart(call: ToolCall) {
      closeText();
      let input: unknown = call.function.arguments;
      try {
        input = JSON.parse(call.function.arguments || '{}');
      } catch {
        // 不是合法的 JSON，就用原文
      }
      emit({ type: 'tool-input-available', toolCallId: call.id, toolName: call.function.name, input, dynamic: true });
    },
    onToolCall(call: ToolCall, result: ToolResult) {
      if (result.isError) emit({ type: 'tool-output-error', toolCallId: call.id, errorText: previewOutput(result.content, 500), dynamic: true });
      else emit({ type: 'tool-output-available', toolCallId: call.id, output: previewOutput(result.content), dynamic: true });
    },
    onText(delta: string) {
      if (!delta) return;
      if (!textId) {
        textId = `text-${++count}`;
        emit({ type: 'text-start', id: textId });
      }
      emit({ type: 'text-delta', id: textId, delta });
    },
    onUsage() {
      closeText();
    },
    onDeepEvent(event: DeepResearchEvent) {
      if (event.type === 'plan') emit({ type: 'data-progress', data: { stage: 'plan', subquestions: event.plan.subquestions } });
      if (event.type === 'subagent') emit({ type: 'data-progress', id: `subagent-${event.index}`, data: { stage: 'subagent', index: event.index, question: event.result.task.question, status: event.result.status } });
      if (event.type === 'report') emit({ type: 'data-progress', data: { stage: 'report' } });
      if (event.type === 'verify') emit({ type: 'data-progress', data: { stage: 'verify', problems: event.result.reports.at(-1)?.problems.length ?? 0 } });
    },
    closeText,
  };
}

export interface StreamResearchOptions {
  model: Model;
  mode?: 'quick' | 'deep';
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * 跑一次研究，过程用 emit 一块块交出去：
 * start → （过程中的块）→ 每个引用的来源一块 source-url（sourceId 是编号）→ data-answer → finish。
 * - 回答加上来源列表和生成内容标识（第 39 天）；没有正常完成的，note 写明原因
 * - signal 触发（用户点了停止、关了网页）：发 abort，不发 finish
 * - 出错：发一块 error，errorText 是兜底的答复，不暴露内部的错误（第 39、40 天）；然后 finish。原始的错误交给 onError
 */
export async function streamResearch(question: string, setup: ResearchSetup, options: StreamResearchOptions, emit: (chunk: ResearchChunk) => void, onError: (error: unknown) => void = () => {}): Promise<void> {
  const { model, mode = 'quick', signal, now } = options;
  const emitter = createChunkEmitter(emit);
  emit({ type: 'start' });
  try {
    let sources: { id: number; url: string; title: string }[];
    let answer: AnswerData;
    if (mode === 'deep') {
      const r = await deepResearch(question, setup, { model, signal, now, onEvent: emitter.onDeepEvent });
      sources = r.citations.cited;
      answer = { text: addExplicitLabel(r.text), status: r.status, ...(r.degraded.length ? { note: r.degraded.join('；') } : {}) };
    } else {
      const r = await research(question, setup, { model, signal, now, onText: emitter.onText, onToolStart: emitter.onToolStart, onToolCall: emitter.onToolCall, onUsage: emitter.onUsage });
      sources = r.report.cited;
      const note = r.result.status === 'completed' ? undefined : describeStatus(r.result);
      answer = { text: addExplicitLabel(r.text), status: r.result.status, ...(note ? { note } : {}) };
    }
    emitter.closeText();
    for (const s of sources) emit({ type: 'source-url', sourceId: String(s.id), url: s.url, title: s.title });
    emit({ type: 'data-answer', data: answer });
    emit({ type: 'finish' });
  } catch (error) {
    emitter.closeText();
    if (signal?.aborted) {
      emit({ type: 'abort', reason: '用户停止了' });
      return;
    }
    onError(error);
    emit({ type: 'error', errorText: FALLBACK_REPLY });
    emit({ type: 'finish' });
  }
}
