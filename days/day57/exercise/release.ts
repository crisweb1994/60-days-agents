// 第 57 天：开源与发布的检查。三件事都能用代码检查：
//   README：一个陌生人 30 秒内能不能看懂这是什么、看到它跑起来的样子、知道怎么装、知道它的效果和局限
//   版本和更新日志：从提交记录（约定式提交，Conventional Commits）算出下一个版本号，生成这一版的更新日志
//   package.json：发布到 npm 之前，该有的字段都有、不该发的文件不会被发出去
// 发布本身（打 tag、npm publish、GitHub Release）由 cli.ts 打印出命令，你自己执行：发布是不可逆的，要人来按按钮。
// 第 57 天的练习：TODO 1–5 在这里。检查：npm run check 57

// ---------- README ----------

export interface Section {
  /** 标题的文字（不带 #）；第一个标题之前的内容是 title 为空的一节 */
  title: string;
  level: number;
  body: string;
}

/** 按标题切开 Markdown。代码块里的 # 不算标题 */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [{ title: '', level: 0, body: '' }];
  let fence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) sections.push({ title: m[2], level: m[1].length, body: '' });
    else sections.at(-1)!.body += `${line}\n`;
  }
  return sections;
}

export interface ReadmeRule {
  id: string;
  /** 给人看的名字 */
  name: string;
  /** 哪个标题算这一节 */
  heading: RegExp;
  /** 这一节里还要有什么（可选） */
  body?: { pattern: RegExp; hint: string };
  hint: string;
}

/** README 该有的几节。标题的写法可以不一样，意思到了就行 */
export const README_RULES: ReadmeRule[] = [
  { id: 'quickstart', name: '快速开始', heading: /快速开始|上手|安装|quick ?start|getting started|install/i, body: { pattern: /```/, hint: '放一段能直接复制运行的命令' }, hint: '三五条命令就能跑起来' },
  { id: 'config', name: '配置', heading: /配置|环境变量|configuration|config/i, hint: '要哪些 Key 和环境变量，哪些是可选的' },
  { id: 'how', name: '工作原理', heading: /工作原理|原理|架构|设计|how it works|architecture|design/i, hint: '一张图或者几句话：它是怎么做到的' },
  { id: 'eval', name: '效果', heading: /评估|效果|evaluation|benchmark|results/i, body: { pattern: /\d+(\.\d+)?\s*%|\d+\s*\/\s*\d+/, hint: '写出数字：在多少条用例上、达到了多少' }, hint: '评估集上的分数，和它是怎么算的' },
  { id: 'limits', name: '局限', heading: /局限|限制|已知问题|不能做|limitations|known issues/i, hint: '它做不好什么、不做什么' },
  { id: 'privacy', name: '数据与隐私', heading: /隐私|数据|privacy|data/i, hint: '数据会发给谁、存多久' },
  { id: 'license', name: 'License', heading: /license|许可/i, hint: '用什么许可证' },
];

export interface ReadmeCheck {
  ok: boolean;
  problems: string[];
}

/**
 * 检查 README（TODO 1），problems 按下面的顺序：
 * 1. 第一个标题要是一级标题（# 项目名），否则「第一行要是一级标题：# 项目名」
 * 2. 一级标题后面第一段文字（按空行分段、去掉首尾空白；跳过图片、徽章、HTML 开头的段落）是一句话介绍：
 *    没有就「一级标题下面要有一句话介绍」；超过 120 个字（按字数）就「一句话介绍太长了（n 字），控制在 120 字以内」
 * 3. 全文要有一张图或者一段录屏：Markdown 图片 ![…](…)、<img、<video 任意一种；否则「放一张截图或者演示动图：让人一眼看到它跑起来的样子」
 * 4. README_RULES 里每一条：没有一个标题匹配 heading，就「缺少「name」：hint」；
 *    有标题、但规则有 body、而这一节（以及它下面更深的小节）的内容里没有 body.pattern，就「「name」里body.hint」
 * ok 是 problems 为空
 */
export function checkReadme(markdown: string): ReadmeCheck {
  // TODO 1：用 splitSections 切开（sections[1] 是第一个标题那一节）；按注释的四步检查。
  // 一句话介绍：first.body 按空行（/\n\s*\n/）分段，找第一段不是 ![、[![、< 开头的文字；字数用 [...文字].length。
  // 规则有 body 时，这一节的内容要加上紧跟着的、level 更大的小节
  void splitSections; void README_RULES; void markdown;
  return { ok: true, problems: [] };
}

// ---------- 提交记录、版本号、更新日志 ----------

export interface Commit {
  hash: string;
  /** feat、fix、docs……不是约定式提交的是 other */
  type: string;
  scope?: string;
  description: string;
  breaking: boolean;
}

/** git log 的格式：每条提交是「哈希\x1f标题\x1f正文\x1e」 */
export const GIT_LOG_FORMAT = '%H%x1f%s%x1f%b%x1e';

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/**
 * 解析 git log 的输出（TODO 2）。每条按 \x1e 分开（去掉首尾空白，空的跳过），字段按 \x1f 分开：
 * - 标题符合「类型(范围)!: 描述」：type 转小写；scope 有就带上；breaking 是「有 !」或者正文里有一行以 BREAKING CHANGE: 或 BREAKING-CHANGE: 开头
 * - 不符合：type 是 other，description 是整个标题，breaking 只看正文
 * hash 只留前 7 位
 */
export function parseCommits(log: string): Commit[] {
  // TODO 2：按 \x1e 分条、\x1f 分字段；标题用 CONVENTIONAL 匹配；正文里的不兼容标记用 /^BREAKING[ -]CHANGE:/m
  void CONVENTIONAL; void log;
  return [];
}

/**
 * 下一个版本号（TODO 3）。current 是「主.次.修订」（可以带 v 前缀，返回的不带）：
 * - 主版本 ≥ 1：有不兼容的改动 → 主版本加一；否则有 feat → 次版本加一；否则有 fix 或 perf → 修订号加一
 * - 主版本是 0（还没稳定）：不兼容的改动和 feat 都只加次版本；fix、perf 加修订号
 * - 加了前面的，后面的归零。只有 docs、chore、test、other 这些：返回 null（不用发版）
 * current 不是这个格式就抛错
 */
export function nextVersion(current: string, commits: Commit[]): string | null {
  // TODO 3：用正则解析出三个数字（允许 v 前缀，不对就抛错「版本号的格式不对：…」），按注释的规则算
  void current; void commits;
  throw new Error('TODO 3：还没有实现 nextVersion');
}

const GROUPS: { title: string; pick: (c: Commit) => boolean }[] = [
  { title: '⚠️ 不兼容的改动', pick: (c) => c.breaking },
  { title: '新功能', pick: (c) => !c.breaking && c.type === 'feat' },
  { title: '修复', pick: (c) => !c.breaking && c.type === 'fix' },
  { title: '性能', pick: (c) => !c.breaking && c.type === 'perf' },
];

/**
 * 这一版的更新日志（TODO 4）：
 * 第一行「## 版本号（日期）」；然后按 GROUPS 的顺序，有提交的组写「### 组名」，下面每条「- 范围：描述（哈希）」（没有范围就不写「范围：」），
 * 组和组之间空一行；docs、chore 这些不写。最后以一个换行结尾
 */
export function renderChangelog(version: string, date: string, commits: Commit[]): string {
  // TODO 4：第一行标题；按 GROUPS 的顺序，每组用 g.pick 挑出提交，有就写「### 组名」和每一条；用 \n 连起来，最后加一个 \n
  void GROUPS; void version; void date; void commits;
  return '';
}

// ---------- package.json ----------

/**
 * 发布到 npm 之前检查 package.json（TODO 5），problems 按下面的顺序：
 * - private 是 true：「private 是 true，npm 不会发布它」
 * - name 不是合法的包名（小写字母、数字、- . _，可以带 @作用域/）：「name 不是合法的包名」
 * - version 不是「主.次.修订」：「version 要像 1.2.3」
 * - 没有 description、license、repository：各报一条「缺少 字段名」
 * - 既没有 bin、也没有 exports、也没有 main：「要有 bin（命令行工具）或者 exports（库）」
 * - 没有 files：「用 files 列出要发布的文件，免得把测试、评估集、.env 发出去」
 * - 没有 engines.node：「用 engines.node 写明要求的 Node.js 版本」
 */
export function checkPackage(pkg: Record<string, any>): string[] {
  // TODO 5：按注释的顺序一条条检查。包名的正则：/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
  void pkg;
  return [];
}
