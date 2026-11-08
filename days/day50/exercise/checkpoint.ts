// 第 35 天：检查点。一次深度研究跑了三分钟，写报告时模型服务挂了，或者进程被重启了：前面三个子 Agent 的调研全白做了吗？
// 每做完一步就把结果存下来（检查点），重新运行时，做过的步骤直接拿存下的结果，只做没做完的。
// 第 29 天的暂停和恢复存的是 Agent 循环的现场；检查点存的是固定流程里每一步的结果，粒度更粗，也简单得多。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Checkpoint {
  /** 这一步有没有做过 */
  has(key: string): boolean;
  get<T>(key: string): T | undefined;
  /** 存下一步的结果，马上写进文件 */
  set(key: string, value: unknown): Promise<void>;
  /** 做过就返回存下的结果，没做过就执行 fn、存下结果再返回。fn 出错时不存，下次还会再做 */
  step<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 存下的所有步骤 */
  keys(): string[];
}

/**
 * 检查点存在一个 JSON 文件里。打开时读出已有的内容（文件不存在就是空的）。
 * 写文件先写到 .tmp 再改名：写到一半进程被杀了，旧的文件还是完整的
 */
export async function openCheckpoint(file: string): Promise<Checkpoint> {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const save = async () => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, file);
  };
  // 同时有几个步骤做完（并行的子 Agent），写文件要排队，免得互相覆盖
  let writing = Promise.resolve();
  const checkpoint: Checkpoint = {
    has: (key) => Object.hasOwn(data, key),
    get: <T>(key: string) => data[key] as T | undefined,
    set(key, value) {
      data[key] = value;
      writing = writing.then(save);
      return writing;
    },
    async step<T>(key: string, fn: () => Promise<T>) {
      if (checkpoint.has(key)) return checkpoint.get<T>(key)!;
      const value = await fn();
      await checkpoint.set(key, value);
      return value;
    },
    keys: () => Object.keys(data),
  };
  return checkpoint;
}
