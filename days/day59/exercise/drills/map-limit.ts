// 第 59 天手写题三：有并发上限的 map。同时最多 limit 个在跑，结果按输入的顺序；有一个失败就整体失败，而且不再开始新的。
// 第 59 天的练习：TODO 3 在这里，15 分钟。不要看前面任何一天的代码，计时写。检查：npm run check 59
/**
 * - limit 不是正整数：抛错
 * - 开 min(limit, items.length) 个「工人」，每个做完手上的就去领下一个
 * - 任何一个失败：返回的 Promise 用这个错误 reject；之后不再开始新的（已经在跑的让它跑完）
 * - 空数组：直接返回 []
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  // TODO 3
  void items; void limit; void fn;
  throw new Error('TODO 3：还没有实现 mapLimit');
}
