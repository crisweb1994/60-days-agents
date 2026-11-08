// 第 45 天：worker 执行一个研究任务。它不知道任务是从内存队列还是 BullMQ 来的，只认 JobStore 和 JobRunner。
// 过程中的每一块都存进 JobStore（客户端断线重连时补发要用）；结束的那几块（error、finish、abort）先扣下，
// 等知道这次执行的结局再决定存什么：
//   正常完成        → finish，任务 completed，存下回答
//   用户取消        → abort，任务 cancelled
//   进程要退出了    → 什么都不存，任务改回 queued，下次启动时恢复（recoverJobs）
//   出错、还能重试  → 一块 retry 的进度，任务改回 queued，抛出错误让队列重试
//   出错、不能重试  → error 和 finish，任务 failed，错误记下来（不给用户看）
// 深度研究用检查点：每个任务一个文件，重试、恢复时做过的步骤直接拿结果（第 35 天）。
// 第 50 天：按任务记下的 prompt 版本取 system prompt（systemFor）；每次执行的用量累加到任务的 usage 上，几次重试都算。
import { join } from 'node:path';
import { openCheckpoint } from './checkpoint.ts';
import { FALLBACK_REPLY } from './guardrails.ts';
import { FINAL_STATUSES, type JobRecord, type JobRunner, type JobStore } from './jobs.ts';
import type { ResearchSetup } from './research.ts';
import type { Model } from './types.ts';
import { streamResearch, type AnswerData, type ResearchChunk } from './ui-stream.ts';
import { addUsage, emptyUsage } from './usage.ts';

export interface ResearchWorkerOptions {
  store: JobStore;
  model: Model;
  /** 给一个任务准备研究的配置（工作目录、搜索、文档）。第 46 天按用户分开 */
  makeSetup: (job: JobRecord) => Promise<ResearchSetup>;
  /** 检查点放在哪个目录。不给就不用检查点 */
  checkpointDir?: string;
  now?: () => Date;
  /** 按任务记下的 promptVersion 取出 system prompt；返回 undefined 用默认的（第 50 天） */
  systemFor?: (job: JobRecord) => Promise<string | undefined> | string | undefined;
}

const HELD = new Set(['error', 'finish', 'abort']);

/**
 * 按上面的规则执行一个任务：
 * - 任务不存在、已经结束：什么都不做
 * - 用户已经要求取消（cancelRequested）：直接改成 cancelled，存一块 abort
 * - 否则改成 running、记下 attempts，深度研究打开检查点（checkpointDir/任务编号.json），跑 streamResearch
 * - 每一块按顺序存进 store（appendEvent 是异步的，要排队，不然顺序会乱）；HELD 里的块先不存
 * - 遇到 data-answer 记下回答
 * - 跑完以后重新读一次任务（取消请求可能是中途来的），按结局处理
 * - 结束的块先存、状态后改：订阅的一方看到任务结束了，就能确定结束的块已经在里面了
 */
export function createResearchRunner(options: ResearchWorkerOptions): JobRunner {
  const { store, model, makeSetup, checkpointDir, now, systemFor } = options;
  return async (jobId, { attempt, maxAttempts, signal }) => {
    const job = await store.get(jobId);
    if (!job || FINAL_STATUSES.has(job.status)) return;
    if (job.cancelRequested) {
      await store.appendEvent(jobId, { type: 'abort', reason: '用户取消了' });
      await store.update(jobId, { status: 'cancelled' });
      return;
    }
    await store.update(jobId, { status: 'running', attempts: attempt });
    const checkpoint = job.mode === 'deep' && checkpointDir ? await openCheckpoint(join(checkpointDir, `${jobId}.json`)) : undefined;

    let writes = Promise.resolve();
    const save = (chunk: ResearchChunk) => {
      writes = writes.then(async () => void (await store.appendEvent(jobId, chunk)));
    };
    let answer: AnswerData | undefined;
    let failure: unknown;
    let usage = job.usage ?? emptyUsage();
    const system = await systemFor?.(job);
    await streamResearch(
      job.question,
      await makeSetup(job),
      { model, mode: job.mode, signal, now, checkpoint, system, onUsage: (u) => (usage = addUsage(usage, u)) },
      (chunk) => {
        if (chunk.type === 'data-answer') answer = chunk.data;
        if (!HELD.has(chunk.type)) save(chunk);
      },
      (error) => (failure = error),
    );
    await writes;

    const latest = await store.get(jobId);
    if (signal.aborted) {
      if (latest?.cancelRequested) {
        await store.appendEvent(jobId, { type: 'abort', reason: '用户取消了' });
        await store.update(jobId, { status: 'cancelled', usage });
      } else {
        await store.update(jobId, { status: 'queued', usage });
      }
      return;
    }
    if (failure !== undefined) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (attempt < maxAttempts) {
        await store.update(jobId, { status: 'queued', error: message, usage });
        await store.appendEvent(jobId, { type: 'data-progress', data: { stage: 'retry', attempt } });
        throw failure;
      }
      await store.appendEvent(jobId, { type: 'error', errorText: FALLBACK_REPLY });
      await store.appendEvent(jobId, { type: 'finish' });
      await store.update(jobId, { status: 'failed', error: message, usage });
      return;
    }
    await store.appendEvent(jobId, { type: 'finish' });
    await store.update(jobId, { status: 'completed', result: answer, error: undefined, usage });
  };
}
