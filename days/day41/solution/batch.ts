// 第 36 天：批处理接口。不着急要结果的请求（离线评估、给评估结果打分、批量整理文档），
// 可以打包成一个文件交上去，模型服务在空闲时处理，一般 24 小时内给结果，价格通常是实时调用的一半左右（以各家的文档为准）。
// 格式是 OpenAI 定的、多家兼容的：每行一个请求的 JSONL 文件 → POST /files 上传 → POST /batches 创建任务 → 轮询 → 下载结果文件。
import { setTimeout as sleep } from 'node:timers/promises';
import { toModelError } from './errors.ts';
import { toRequestBody, type OpenAIConfig } from './openai.ts';
import type { AssistantMessage, ChatRequest, ChatResult } from './types.ts';
import { parseUsage, type RawUsage } from './usage.ts';

export interface BatchItem {
  /** 自己定的 id，结果靠它和请求对上：结果文件里的顺序不保证和请求一样 */
  customId: string;
  request: ChatRequest;
}

/**
 * 请求排成批处理的 JSONL：每行 { custom_id, method: 'POST', url: '/v1/chat/completions', body }，body 和实时调用的请求体一样
 * （用 openai.ts 的 toRequestBody，不带 stream）。custom_id 重复就抛出错误：结果会对不上
 */
export function toBatchJSONL(items: BatchItem[], model: string): string {
  const seen = new Set<string>();
  return items
    .map(({ customId, request }) => {
      if (seen.has(customId)) throw new Error(`custom_id 重复：${customId}`);
      seen.add(customId);
      return JSON.stringify({ custom_id: customId, method: 'POST', url: '/v1/chat/completions', body: toRequestBody(request, model) });
    })
    .join('\n');
}

export type BatchOutcome = { ok: true; result: ChatResult } | { ok: false; error: string };

type OutputLine = {
  custom_id: string;
  response?: { status_code: number; body?: { choices?: { message: AssistantMessage; finish_reason: string }[]; usage?: RawUsage; error?: { message?: string } } } | null;
  error?: { code?: string; message?: string } | null;
};

/**
 * 解析结果文件：每行一个结果，按 custom_id 放进 Map。
 * 成功：response.status_code 是 200，body 和实时调用的非流式回复一样，取 choices[0] 的 message、finish_reason，用量用 parseUsage。
 * 失败：error 不为空，或者状态码不是 200，或者 body 里没有 choices，记成 { ok: false, error: 错误信息 }
 */
export function parseBatchOutput(text: string): Map<string, BatchOutcome> {
  const outcomes = new Map<string, BatchOutcome>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const data = JSON.parse(line) as OutputLine;
    const status = data.response?.status_code;
    const choice = data.response?.body?.choices?.[0];
    if (data.error || status !== 200 || !choice) {
      const message = data.error?.message ?? data.response?.body?.error?.message ?? `HTTP ${status ?? '未知'}`;
      outcomes.set(data.custom_id, { ok: false, error: message });
      continue;
    }
    outcomes.set(data.custom_id, { ok: true, result: { message: choice.message, finishReason: choice.finish_reason, usage: parseUsage(data.response!.body!.usage) } });
  }
  return outcomes;
}

export interface BatchJob {
  id: string;
  /** validating、in_progress、finalizing、completed、failed、expired、cancelled…… */
  status: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
}

/** 批处理接口的客户端。和对话用同一个地址和 Key */
export function createBatchClient(config: Pick<OpenAIConfig, 'baseURL' | 'apiKey'>) {
  const auth = { Authorization: `Bearer ${config.apiKey}` };
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${config.baseURL}${path}`, { ...init, headers: { ...auth, ...init.headers } });
    if (!res.ok) throw await toModelError(res);
    return res;
  };
  return {
    /** 上传 JSONL，创建批处理任务 */
    async submit(jsonl: string, metadata?: Record<string, string>): Promise<BatchJob> {
      const form = new FormData();
      form.append('purpose', 'batch');
      form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch.jsonl');
      const file = (await (await call('/files', { method: 'POST', body: form })).json()) as { id: string };
      const body = JSON.stringify({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h', metadata });
      return (await (await call('/batches', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).json()) as BatchJob;
    },
    async get(id: string): Promise<BatchJob> {
      return (await (await call(`/batches/${id}`)).json()) as BatchJob;
    },
    /** 每隔 intervalMs 查一次，直到结束（completed、failed、expired、cancelled） */
    async wait(id: string, { intervalMs = 60_000, signal }: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<BatchJob> {
      for (;;) {
        const job = await this.get(id);
        if (['completed', 'failed', 'expired', 'cancelled'].includes(job.status)) return job;
        await sleep(intervalMs, undefined, { signal });
      }
    },
    /** 下载并解析结果。任务没有完成、没有结果文件就抛出错误 */
    async results(job: BatchJob): Promise<Map<string, BatchOutcome>> {
      if (job.status !== 'completed' || !job.output_file_id) throw new Error(`批处理任务 ${job.id} 没有结果：${job.status}`);
      return parseBatchOutput(await (await call(`/files/${job.output_file_id}/content`)).text());
    },
  };
}
