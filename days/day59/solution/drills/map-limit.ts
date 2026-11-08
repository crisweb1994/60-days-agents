// 第 59 天手写题三：有并发上限的 map。同时最多 limit 个在跑，结果按输入的顺序；有一个失败就整体失败，而且不再开始新的。
/**
 * - limit 不是正整数：抛错
 * - 开 min(limit, items.length) 个「工人」，每个做完手上的就去领下一个
 * - 任何一个失败：返回的 Promise 用这个错误 reject；之后不再开始新的（已经在跑的让它跑完）
 * - 空数组：直接返回 []
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`并发上限要是正整数，现在是 ${limit}`);
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
