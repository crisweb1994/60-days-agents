// 第 49 天：prompt 的版本管理。上线以后，prompt 和代码一样要有版本：
//   改一版 prompt 不用重新部署；出了问题能马上回滚；每一次回答都记得是用哪一版生成的（反馈、评估、排查都要用）
// 版本号是「名字@内容的 sha256 前 8 位」：内容一样，版本号就一样，重复发布不会多出一个版本。
// 标签（production、canary）指向某个版本，切换标签就是上线和回滚；每个标签记着历史，回滚就是退回上一个。
// 这里存在一个 JSON 文件里；线上放进数据库，和第 46 天的其他表一样。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PromptVersion {
  /** 名字@哈希，比如 research@1a2b3c4d */
  id: string;
  name: string;
  content: string;
  /** 这一版改了什么 */
  note: string;
  createdAt: string;
}

interface RegistryData {
  versions: PromptVersion[];
  /** 名字 → 标签 → 这个标签指向过的版本，最后一个是当前的 */
  labels: Record<string, Record<string, string[]>>;
}

export interface PromptRegistry {
  /** 发布一个版本。内容和已有的某一版一样，就返回那一版（不重复记） */
  publish(name: string, content: string, note?: string): Promise<PromptVersion>;
  /** 让标签指向一个版本（上线、灰度） */
  setLabel(name: string, label: string, versionId: string): Promise<void>;
  /** 标签现在指向的版本 */
  get(name: string, label?: string): PromptVersion | undefined;
  /** 按版本号找 */
  byId(versionId: string): PromptVersion | undefined;
  /** 标签退回上一个版本，返回退回后的版本 */
  rollback(name: string, label?: string): Promise<PromptVersion>;
  /** 一个名字的所有版本，新的在前 */
  history(name: string): PromptVersion[];
}

/** 版本号：名字@内容的 sha256 前 8 位 */
export function versionId(name: string, content: string): string {
  return `${name}@${createHash('sha256').update(content).digest('hex').slice(0, 8)}`;
}

/**
 * 打开一个存在 JSON 文件里的注册表（文件不存在就是空的）。每次修改都写回文件（先写 .tmp 再改名，和第 35 天的检查点一样）。
 * - publish：内容去掉首尾空白；版本号已经有了就返回已有的；否则记下一版
 * - setLabel：版本必须存在、名字要对得上，否则抛错；和当前指向的一样就不重复记
 * - get：标签默认是 production
 * - rollback：这个标签的历史少于两个，抛错（没有可以退回的）；否则去掉最后一个
 */
export async function openPromptRegistry(file: string, now: () => Date = () => new Date()): Promise<PromptRegistry> {
  let data: RegistryData = { versions: [], labels: {} };
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const save = async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
    await rename(`${file}.tmp`, file);
  };
  const byId = (id: string) => data.versions.find((v) => v.id === id);
  const historyOf = (name: string, label: string) => ((data.labels[name] ??= {})[label] ??= []);
  return {
    async publish(name, content, note = '') {
      const text = content.trim();
      const id = versionId(name, text);
      const existing = byId(id);
      if (existing) return existing;
      const version: PromptVersion = { id, name, content: text, note, createdAt: now().toISOString() };
      data.versions.push(version);
      await save();
      return version;
    },
    async setLabel(name, label, id) {
      const version = byId(id);
      if (!version || version.name !== name) throw new Error(`${name} 没有版本 ${id}`);
      const history = historyOf(name, label);
      if (history.at(-1) === id) return;
      history.push(id);
      await save();
    },
    get(name, label = 'production') {
      const id = data.labels[name]?.[label]?.at(-1);
      return id ? byId(id) : undefined;
    },
    byId,
    async rollback(name, label = 'production') {
      const history = historyOf(name, label);
      if (history.length < 2) throw new Error(`${name} 的 ${label} 没有可以退回的版本`);
      history.pop();
      await save();
      return byId(history.at(-1)!)!;
    },
    history(name) {
      return data.versions.filter((v) => v.name === name).reverse();
    },
  };
}
