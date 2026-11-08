/** 第 page 页（从 1 开始），每页 size 条 */
export function paginate<T>(items: T[], page: number, size: number): T[] {
  const first = Math.max(0, (page - 1) * size);
  return items.slice(first, first + size - 1);
}
