// 第 60 天：把毕业项目加到学员作品墙（仓库根目录的 SHOWCASE.md）。PR 之前先用这里的函数检查一遍格式，合并时少来回几次。
// 每一行的格式：| [项目名](仓库地址) | [GitHub 用户名](https://github.com/用户名) | 一句话介绍 | [在线地址](https://...) |

export interface ShowcaseEntry {
  name: string;
  /** 仓库地址：https://github.com/用户或组织/仓库 */
  repo: string;
  /** GitHub 用户名 */
  author: string;
  /** 一句话介绍，50 字以内 */
  pitch: string;
  /** 在线地址：https 开头 */
  demo: string;
}

const REPO = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/?$/;
const USER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * 检查一条作品（TODO 1），problems 按下面的顺序：
 * - 任何一个字段里有 | 或者换行：「x 里不能有 | 或者换行」（按 name、repo、author、pitch、demo 的顺序，每个字段一条）
 * - name 是空的（去掉空白）：「name 不能是空的」
 * - repo 不符合 REPO：「repo 要是 https://github.com/用户/仓库」
 * - author 不符合 USER（GitHub 用户名的规则）：「author 不是合法的 GitHub 用户名」
 * - pitch 是空的：「pitch 不能是空的」；超过 50 个字（按字数）：「pitch 太长了（n 字），50 字以内」
 * - demo 不是 https:// 开头的合法网址（new URL 能解析）：「demo 要是 https 开头的在线地址」
 */
export function checkEntry(entry: ShowcaseEntry): string[] {
  const problems: string[] = [];
  for (const key of ['name', 'repo', 'author', 'pitch', 'demo'] as const) if (/[|\n\r]/.test(entry[key])) problems.push(`${key} 里不能有 | 或者换行`);
  if (!entry.name.trim()) problems.push('name 不能是空的');
  if (!REPO.test(entry.repo)) problems.push('repo 要是 https://github.com/用户/仓库');
  if (!USER.test(entry.author)) problems.push('author 不是合法的 GitHub 用户名');
  const length = [...entry.pitch.trim()].length;
  if (!length) problems.push('pitch 不能是空的');
  else if (length > 50) problems.push(`pitch 太长了（${length} 字），50 字以内`);
  let ok = false;
  try {
    ok = new URL(entry.demo).protocol === 'https:' && entry.demo.startsWith('https://');
  } catch {
    ok = false;
  }
  if (!ok) problems.push('demo 要是 https 开头的在线地址');
  return problems;
}

/** 一行表格 */
export function renderRow(e: ShowcaseEntry): string {
  return `| [${e.name.trim()}](${e.repo}) | [${e.author}](https://github.com/${e.author}) | ${e.pitch.trim()} | [在线地址](${e.demo}) |`;
}

const ROW = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*\[([^\]]+)\]\(https:\/\/github\.com\/[^)]+\)\s*\|\s*(.*?)\s*\|\s*\[[^\]]*\]\(([^)]+)\)\s*\|\s*$/;

/**
 * 读出作品墙里已有的作品（TODO 2）：每一行用 ROW 匹配（表头、分隔线、注释都匹配不上，跳过）。
 * 按出现的顺序返回
 */
export function parseShowcase(markdown: string): ShowcaseEntry[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => ROW.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1], repo: m[2], author: m[3], pitch: m[4], demo: m[5] }));
}

/**
 * 加一条作品（TODO 3）：
 * - checkEntry 有问题：抛错，信息是所有问题用「；」连起来
 * - 仓库地址（去掉末尾的 /、不分大小写）已经在作品墙里了：抛错「x 已经在作品墙里了」
 * - 加在表格最后一行（以 | 开头的最后一行）的下面；文件里没有表格就抛错「没有找到表格」
 * 其余的内容原样不动
 */
export function addToShowcase(markdown: string, entry: ShowcaseEntry): string {
  const problems = checkEntry(entry);
  if (problems.length) throw new Error(problems.join('；'));
  const key = (url: string) => url.replace(/\/+$/, '').toLowerCase();
  if (parseShowcase(markdown).some((e) => key(e.repo) === key(entry.repo))) throw new Error(`${entry.repo} 已经在作品墙里了`);
  const lines = markdown.split('\n');
  let last = -1;
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith('|')) last = i;
  });
  if (last === -1) throw new Error('没有找到表格');
  lines.splice(last + 1, 0, renderRow(entry));
  return lines.join('\n');
}

// 运行：node days/day60/solution/showcase.ts --name 项目名 --repo 仓库地址 --author 用户名 --pitch 一句话 --demo 在线地址
// 检查通过就改写仓库根目录的 SHOWCASE.md，然后你自己提交、提 PR
if (import.meta.main) {
  const { parseArgs } = await import('node:util');
  const { readFile, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { values } = parseArgs({ options: { name: { type: 'string', default: '' }, repo: { type: 'string', default: '' }, author: { type: 'string', default: '' }, pitch: { type: 'string', default: '' }, demo: { type: 'string', default: '' } } });
  const file = fileURLToPath(new URL('../../../SHOWCASE.md', import.meta.url));
  try {
    await writeFile(file, addToShowcase(await readFile(file, 'utf8'), values as ShowcaseEntry));
    console.log(`已经加到 ${file}，提交以后提一个 PR 吧`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
