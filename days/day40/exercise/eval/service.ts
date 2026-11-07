// 第 40 天：对着服务跑评估。第 31 天的 researchTarget 直接调用 research()；服务上线以后，要评估的是服务本身：
// 护栏、标识、预算、序列化，任何一层出了问题，直接调用函数是测不出来的。把 HTTP 接口包成 target，评估集和评分器都不用改。
// 运行（服务已经启动）：SERVICE_URL=http://127.0.0.1:8787 SERVICE_KEY=dev-key node days/day40/exercise/eval/service.ts days/day40/data/eval/research.jsonl
import type { ServiceResult } from '../service.ts';
import type { Target } from './run.ts';

export interface ServiceTargetOptions {
  baseURL: string;
  apiKey: string;
  mode?: 'quick' | 'deep';
  /** 换成假的 fetch，测试用 */
  fetch?: typeof fetch;
}

/** 把 POST /v1/research 包成 target。服务返回 4xx/5xx 就抛出错误，记成这条用例的 error */
export function serviceTarget({ baseURL, apiKey, mode = 'quick', fetch: doFetch = fetch }: ServiceTargetOptions): Target {
  return async (c, signal) => {
    const res = await doFetch(`${baseURL}/v1/research`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: c.question, mode }),
      signal,
    });
    const body = (await res.json()) as ServiceResult & { error?: string };
    if (!res.ok) throw new Error(`服务返回 ${res.status}：${body.error ?? ''}`);
    return {
      answer: body.text,
      usage: body.usage,
      toolCalls: body.toolCalls,
      cited: body.sources.map((s) => s.url),
      citationProblems: body.citationProblems,
      // 被护栏拦下、兜底的，也当作一种停下的原因交给评分器
      status: body.researchStatus ?? body.status,
    };
  };
}

if (import.meta.main) {
  const { readFile } = await import('node:fs/promises');
  const { parseDataset } = await import('./dataset.ts');
  const { runEval, summarizeRun, formatRunSummary } = await import('./run.ts');
  const [file] = process.argv.slice(2);
  const { SERVICE_URL = 'http://127.0.0.1:8787', SERVICE_KEY } = process.env;
  if (!file || !SERVICE_KEY) {
    console.error('用法：SERVICE_URL=… SERVICE_KEY=… eval/service.ts <评估集.jsonl>');
    process.exit(1);
  }
  const cases = parseDataset(await readFile(file, 'utf8'));
  const run = await runEval(cases, serviceTarget({ baseURL: SERVICE_URL, apiKey: SERVICE_KEY }), {
    name: 'service',
    onResult: (r, done, total) => console.error(`[${done}/${total}] ${r.id} ${r.error ? '出错' : '完成'}`),
  });
  console.log(formatRunSummary(summarizeRun(run, cases)));
}
