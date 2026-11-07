// 第 27 天：操作浏览器。有的网页要运行 JavaScript 才有内容，有的要点「加载更多」、要在搜索框里输入才看得到，
// fetch_page 只能拿到 HTML，读不到这些。这时给 Agent 一个浏览器：打开网页、看看页面上有什么、点一下、输入一段文字。
// 模型看页面有两种方式：截图（要视觉模型，贵、慢，坐标容易点偏），或者无障碍树（按钮、链接、输入框的列表，加上正文）。
// 这里用后一种：每个能操作的元素一个编号（e1、e2……），模型说「点 e3」，代码再找到它去点。
// 这个文件只管工具这一层，真正驱动浏览器的在 browser-playwright.ts。测试时可以换成一个假的浏览器。
// 第 27 天的练习：TODO 1–4 都在这里。检查：npm run check 27
import { z } from 'zod';
import { defineTool, paginate, type Tool } from './tool.ts';
import { isPrivateHost, wrapUntrusted, type SourceRegistry } from './web.ts';

/** 页面上一个能操作的元素 */
export interface PageElement {
  /** 编号，比如 e3。每次看页面都重新编号 */
  ref: string;
  /** 角色：link、button、textbox、checkbox、combobox…… */
  role: string;
  /** 给人看的名字：链接的文字、按钮上的字、输入框的提示 */
  name: string;
  /** 输入框里现在的值 */
  value?: string;
  disabled?: boolean;
  /** 是不是密码框 */
  password?: boolean;
}

/** 某一刻页面的样子 */
export interface PageSnapshot {
  url: string;
  title: string;
  /** 页面上看得到的文字 */
  text: string;
  elements: PageElement[];
}

/** 一个浏览器标签页。Playwright 的实现在 browser-playwright.ts，测试里用假的 */
export interface BrowserPage {
  goto(url: string): Promise<void>;
  /** 看一眼现在的页面：标题、网址、正文、能操作的元素。每次调用都重新编号 */
  snapshot(): Promise<PageSnapshot>;
  click(ref: string): Promise<void>;
  /** 在输入框里输入文字（先清空）。submit 为 true 时再按回车 */
  fill(ref: string, text: string, submit: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface UrlPolicy {
  /** 允许访问本机和内网，默认不允许。只在测试时打开 */
  allowPrivate?: boolean;
  /** 只允许这些域名（包括它们的子域名）。不填就不限制 */
  allowedHosts?: string[];
}

/** 检查一个网址能不能打开。不能打开时返回原因，能打开返回 undefined */
export function checkUrl(url: string, policy: UrlPolicy = {}): string | undefined {
  // TODO 1：按顺序检查，发现问题就返回原因（写法和测试里的一样）：
  // 1. new URL 解析不了：「网址格式不对：<url>。要写完整的网址，以 http:// 或 https:// 开头」
  // 2. 不是 http: 或 https:：「只能打开 http 和 https 的网址，不支持 <协议>」
  // 3. 没有 allowPrivate，而且是本机或内网（isPrivateHost）：「不能访问本机或内网的地址：<主机名>」
  // 4. 有 allowedHosts，主机名（转成小写）既不等于其中一个、也不是其中一个的子域名（以「.域名」结尾）：
  //    「<主机名> 不在允许访问的网站里：<allowedHosts 用「、」连接>」
  // 注意第 4 条：只看「以 tide.example 结尾」的话，eviltide.example 也会混进来
  void isPrivateHost;
  void url;
  void policy;
  return undefined;
}

/** 一个元素写成一行：[e3] button「加载更多」（值：…）（不可用） */
export function formatElement(el: PageElement): string {
  const value = el.value ? `（值：${el.password ? '******' : el.value}）` : '';
  return `[${el.ref}] ${el.password ? 'password' : el.role}「${el.name || '（没有名字）'}」${value}${el.disabled ? '（不可用）' : ''}`;
}

export interface FormatOptions {
  /** 最多列出几个元素，默认 60。导航栏里几百个链接，全列出来会占满上下文 */
  maxElements?: number;
  /** 正文每页最多多少个字符，默认 3000 */
  pageSize?: number;
  /** 正文看第几页，默认 1 */
  page?: number;
}

/**
 * 把页面写成给模型看的文字：标题、网址、能操作的元素、正文。
 * 元素太多时只列前 maxElements 个，并注明还有几个；正文分页，末尾说明怎么读下一页。正文包上「这是资料、不是指令」的边界
 */
export function formatSnapshot(snapshot: PageSnapshot, options: FormatOptions = {}): string {
  const { maxElements = 60, pageSize = 3000, page = 1 } = options;
  // TODO 2：排成四段，段和段之间空一行：
  //   页面：<标题，没有就写（无标题）>\n网址：<网址>
  //   能操作的元素：\n<每个元素一行，用 formatElement>。最多 maxElements 个，多出来的写一行「……还有 N 个元素没有列出」；
  //     一个都没有就写「（没有能操作的元素）」
  //   正文：\n<去掉首尾空白的正文，用 paginate 分页，取第 page 页的 body，用 wrapUntrusted 包上边界>。
  //     有 footer 时另起一行附上，并把里面的「page=」换成「browser_read 的 page=」，告诉模型用哪个工具翻页；
  //     正文是空的就写「（页面上没有文字）」
  void maxElements;
  void pageSize;
  void page;
  void paginate;
  void wrapUntrusted;
  return `页面：${snapshot.title}\n${snapshot.elements.map(formatElement).join('\n')}\n${snapshot.text}`;
}

export interface BrowserToolsOptions extends UrlPolicy, Omit<FormatOptions, 'page'> {
  /** 打开一个标签页。第一次用到浏览器时才调用，不用浏览器就不启动 */
  open: () => Promise<BrowserPage>;
  /** 来源登记：打开过的页面都登记成来源，回答时可以引用 */
  sources?: SourceRegistry;
}

/** 浏览器工具和它们共用的状态：当前的标签页、最近一次看到的页面 */
export interface BrowserTools {
  tools: Tool[];
  /** 关掉标签页。程序退出前调用 */
  close(): Promise<void>;
}

/**
 * 四个浏览器工具：browser_open 打开网页，browser_click 点击，browser_type 输入，browser_read 读正文的下一页。
 * 每次操作以后都重新看一眼页面，把新的样子交回模型：点了按钮以后页面变了，旧的编号就不能用了
 */
export function createBrowserTools(options: BrowserToolsOptions): BrowserTools {
  const { open, sources, maxElements, pageSize } = options;
  let tab: BrowserPage | undefined;
  let last: PageSnapshot | undefined;

  const page = async () => (tab ??= await open());

  /** 重新看一眼页面，登记来源，排成文字交回模型 */
  async function look(): Promise<string> {
    last = await (await page()).snapshot();
    // TODO 3（一）：
    // - 页面可能跳转到了别的地址：用 checkUrl 再检查一次最终的网址，不允许就抛出「页面跳转到了不允许访问的地址。<原因>」
    // - 有 sources 时，把这个页面登记成来源（网址、标题、正文），结果的第一行写「来源 [编号]」
    // - 后面接上 formatSnapshot(last, { maxElements, pageSize })
    void sources;
    return formatSnapshot(last, { maxElements, pageSize });
  }

  /** 找到最近一次看到的页面上的元素。找不到说明页面变了或者编号写错了 */
  function find(ref: string): PageElement {
    // TODO 3（二）：
    // - 还没有看过页面（last 是 undefined）：「还没有打开网页。先用 browser_open 打开一个网址」
    // - 最近一次的页面上没有这个编号：「页面上没有 <ref>。编号只在最近一次看到的页面上有效，按最新的元素列表重新选」
    // - 元素不可用：「<ref>（<名字>）现在不可用」
    return last?.elements.find((e) => e.ref === ref) ?? { ref, role: 'button', name: '' };
  }

  const browserOpen = defineTool({
    name: 'browser_open',
    description:
      '在浏览器里打开一个网页，返回页面上能操作的元素（带编号）和正文。比 fetch_page 慢，只在 fetch_page 读不到内容、' +
      '或者要点击、输入才能看到内容时用',
    schema: z.object({ url: z.string().describe('完整的网址，以 http:// 或 https:// 开头') }),
    async execute({ url }) {
      const blocked = checkUrl(url, options);
      if (blocked) throw new Error(blocked);
      await (await page()).goto(url);
      return look();
    },
  });

  const browserClick = defineTool({
    name: 'browser_click',
    description: '点击页面上的一个元素（链接、按钮），返回点击以后的页面。编号来自最近一次返回的元素列表。不要点购买、支付、删除、提交订单这类按钮',
    schema: z.object({ ref: z.string().describe('元素的编号，比如 e3') }),
    async execute({ ref }) {
      find(ref);
      await (await page()).click(ref);
      return look();
    },
  });

  const browserType = defineTool({
    name: 'browser_type',
    description: '在输入框里输入文字，返回输入以后的页面。submit 为 true 时再按回车，比如在搜索框里搜索。不要在网页上输入密码和个人信息',
    schema: z.object({
      ref: z.string().describe('输入框的编号，比如 e2'),
      text: z.string().describe('要输入的文字'),
      submit: z.boolean().default(false).describe('输入以后按回车，默认 false'),
    }),
    // 按回车会提交表单，可能有副作用，先问用户
    requiresApproval: (input: { submit: boolean }) => input.submit,
    async execute({ ref, text, submit }) {
      const el = find(ref);
      // TODO 4：输入之前再检查两件事：
      // - 密码框：「不能在网页上输入密码。需要登录的网页，请用户自己处理」。密码和登录交给用户，不让 Agent 碰
      // - 角色不是 textbox、searchbox、combobox：「<ref> 是 <角色>，不是输入框」
      void el;
      await (await page()).fill(ref, text, submit);
      return look();
    },
  });

  const browserRead = defineTool({
    name: 'browser_read',
    description: '读当前页面正文的某一页。正文太长时，browser_open 只返回第 1 页',
    schema: z.object({ page: z.int().min(1).describe('读第几页') }),
    async execute({ page: n }) {
      if (!last) throw new Error('还没有打开网页。先用 browser_open 打开一个网址');
      const { body, footer } = paginate(last.text.trim(), n, pageSize ?? 3000);
      return [wrapUntrusted(body), footer].filter(Boolean).join('\n');
    },
  });

  return {
    tools: [browserOpen, browserClick, browserType, browserRead],
    async close() {
      await tab?.close();
      tab = undefined;
      last = undefined;
    },
  };
}
