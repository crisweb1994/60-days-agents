// 第 56 天：GitHub 的两个接口：取 PR 的 diff、发一次审查（总评加行内评论）。
// 发的永远是 event: COMMENT：机器人只留评论，不批准、不要求修改（第 51 天的「不做」）。
// 令牌用 GitHub App 的安装令牌或者细粒度的个人令牌，只给 Pull requests 读写、Contents 只读（最小权限，第 38 天）。
import type { ReviewResult } from './review.ts';
import { renderReview } from './review.ts';

export interface ReviewPayload {
  commit_id: string;
  event: 'COMMENT';
  body: string;
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[];
}

export interface GitHubClient {
  /** PR 的 unified diff */
  getDiff(repo: string, number: number): Promise<string>;
  createReview(repo: string, number: number, payload: ReviewPayload): Promise<void>;
}

const LABEL = { high: '🔴 严重', medium: '🟠 应该改', low: '🟡 可以更好' } as const;

/** 审查的结果变成 GitHub 的请求体：行内评论落在新文件那一边（RIGHT），总评用 renderReview */
export function toReviewPayload(result: ReviewResult, headSha: string): ReviewPayload {
  return {
    commit_id: headSha,
    event: 'COMMENT',
    body: renderReview(result),
    comments: result.comments.map((c) => ({ path: c.file, line: c.line, side: 'RIGHT', body: `**${LABEL[c.severity]}**（${c.kind}）\n\n${c.body}` })),
  };
}

export function createGitHubClient({ token, baseURL = 'https://api.github.com', doFetch = fetch }: { token: string; baseURL?: string; doFetch?: typeof fetch }): GitHubClient {
  const call = async (path: string, init: RequestInit & { accept?: string } = {}) => {
    const res = await doFetch(`${baseURL}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: init.accept ?? 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'review-bot', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} 返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
    return res;
  };
  return {
    async getDiff(repo, number) {
      return (await call(`/repos/${repo}/pulls/${number}`, { accept: 'application/vnd.github.diff' })).text();
    },
    async createReview(repo, number, payload) {
      await call(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: JSON.stringify(payload) });
    },
  };
}
