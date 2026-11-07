// 第 45 天：worker 执行一个研究任务。它不知道任务是从内存队列还是 BullMQ 来的，只认 JobStore 和 JobRunner。
// 过程中的每一块都存进 JobStore（客户端断线重连时补发要用）；结束的那几块（error、finish、abort）先扣下，
// 等知道这次执行的结局再决定存什么：
//   正常完成        → finish，任务 completed，存下回答
//   用户取消        → abort，任务 cancelled
//   进程要退出了    → 什么都不存，任务改回 queued，下次启动时恢复（recoverJobs）
//   出错、还能重试  → 一块 retry 的进度，任务改回 queued，抛出错误让队列重试
//   出错、不能重试  → error 和 finish，任务 failed，错误记下来（不给用户看）
// 第 45 天的练习：TODO 2 在这里。检查：npm run check 45
// 深度研究用检查点：每个任务一个文件，重试、恢复时做过的步骤直接拿结果（第 35 天）。
import { join } from 'node:path';
import { openCheckpoint } from './checkpoint.ts';
import { FALLBACK_REPLY } from './guardrails.ts';
import { FINAL_STATUSES, type JobRecord, type JobRunner, type JobStore } from './jobs.ts';
import type { ResearchSetup } from './research.ts';
import type { Model } from './types.ts';
import { streamResearch, type AnswerData, type ResearchChunk } from './ui-stream.ts';

export interface ResearchWorkerOptions {
  store: JobStore;
  model: Model;
  /** 给一个任务准备研究的配置（工作目录、搜索、文档）。第 46 天按用户分开 */
  makeSetup: (job: JobRecord) => Promise<ResearchSetup>;
  /** 检查点放在哪个目录。不给就不用检查点 */
  checkpointDir?: string;
  now?: () => Date;
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
  const { store, model, makeSetup, checkpointDir, now } = options;
  return async (jobId, { attempt, maxAttempts, signal }) => {
    // TODO 2：按上面注释和文件开头的五种结局实现。步骤：
    // 1. 读任务：不存在或者已经结束（FINAL_STATUSES）就返回；cancelRequested 了就存 abort、改 cancelled、返回
    // 2. 改成 running、attempts 是 attempt；深度研究而且有 checkpointDir，就 openCheckpoint(join(checkpointDir, `${jobId}.json`))
    // 3. streamResearch(job.question, await makeSetup(job), { model, mode, signal, now, checkpoint }, 每一块…, 出错记下来)：
    //    data-answer 记下回答；不在 HELD 里的块存进 store，用一条 Promise 链保证顺序（writes = writes.then(...)），最后 await writes
    // 4. 重新读任务，按结局处理：signal.aborted（取消 / 退出）、出错（能重试 / 不能重试）、完成。记住先存块、后改状态
    void store; void model; void makeSetup; void checkpointDir; void now; void openCheckpoint; void join; void streamResearch; void HELD; void FALLBACK_REPLY; void FINAL_STATUSES;
    void attempt; void maxAttempts; void signal;
    throw new Error(`TODO 2：还没有实现 worker（任务 ${jobId}）`);
  };
}
