// 第 22 天：并行。互不依赖的几件事（几个搜索词、几个网页、几次分类）可以同时做，总耗时从「加起来」变成「最慢的那个」。
// 但不能一下子全发出去：模型服务和搜索服务都有并发和速率的限制，同时发太多会被限流（429），反而更慢。
// 所以要有一个并发上限：同时最多 limit 个，做完一个再开始下一个。
// 第 22 天的练习：TODO 1、2 在这里，TODO 3–5 在 router.ts，TODO 6 在 workflow.ts。检查：npm run check 22

/**
 * 对每一项执行 fn，同时最多 limit 个。返回的结果和输入的顺序一致，不管谁先做完。
 * 一项失败不影响其他项：每一项的结果是 { status: 'fulfilled', value } 或 { status: 'rejected', reason }，和 Promise.allSettled 一样。
 * signal 触发以后，还没开始的项不再开始，记成失败
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`并发上限要是正整数，现在是 ${limit}`);
  // TODO 1：现在是一个接一个地做，能跑，但没有并行。改成同时最多 limit 个：
  // - 一个办法是开 min(limit, 项数) 个「工人」（async 函数），每个工人循环地领下一项（共用一个计数器），做完再领，直到领完；
  //   用 Promise.all 等所有工人结束。JavaScript 是单线程的，「领下一项」不会被打断，不用加锁
  // - 结果按 index 放进数组，顺序才和输入一致
  // - 每一项的结果写成 { status: 'fulfilled', value } 或 { status: 'rejected', reason }，一项出错不影响其他项
  // - 领到一项时 signal 已经触发了，就不执行它，记成 { status: 'rejected', reason: signal.reason }
  const results: PromiseSettledResult<R>[] = [];
  for (const [index, item] of items.entries()) {
    try {
      results.push({ status: 'fulfilled', value: await fn(item, index) });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}

/** 只要成功的结果，按输入的顺序 */
export function fulfilled<R>(results: PromiseSettledResult<R>[]): R[] {
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

export interface Vote<T> {
  /** 得票最多的。平票时取最先出现的那个 */
  winner: T;
  /** 它得了几票 */
  count: number;
  /** 一共几票 */
  total: number;
  /** count / total：越接近 1，几次的意见越一致 */
  agreement: number;
}

/**
 * 多数投票：同一个问题问几次（或者问几个模型），取出现最多的答案。
 * 一次的输出可能碰巧出错，几次里多数都这么说，就可信得多；agreement 低，说明这个问题本身就有歧义。
 * 没有票时返回 undefined
 */
export function vote<T>(answers: T[]): Vote<T> | undefined {
  if (answers.length === 0) return undefined;
  // TODO 2：数一数每个答案出现了几次（Map 会保留第一次出现的顺序），取最多的；平票时取最先出现的。
  // count 是它的票数，total 是总票数，agreement 是 count / total
  return { winner: answers[0], count: 1, total: answers.length, agreement: 1 / answers.length };
}
