// 第 27 天测试用的假浏览器：不启动 Chromium，按事先写好的页面状态回应打开、点击、输入。
// 用它测试工具这一层（编号、校验、来源、权限），真正的浏览器在 playwright.test.ts 里测。
import type { BrowserPage, PageSnapshot } from '../solution/browser.ts';

export interface FakeState extends PageSnapshot {
  /** 点击某个元素以后变成哪个状态（状态的名字） */
  clicks?: Record<string, string>;
  /** 在某个输入框里输入并回车以后变成哪个状态，状态里的 {text} 换成输入的文字 */
  submits?: Record<string, string>;
}

export function createFakeBrowser(states: Record<string, FakeState>) {
  const log: string[] = [];
  let current: FakeState | undefined;
  let typed = '';
  let opened = 0;
  const fill = (state: FakeState): FakeState => ({ ...state, text: state.text.replaceAll('{text}', typed) });
  const page: BrowserPage = {
    async goto(url) {
      log.push(`goto ${url}`);
      const state = states[url];
      if (!state) throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
      current = state;
    },
    async snapshot() {
      if (!current) return { url: 'about:blank', title: '', text: '', elements: [] };
      const { clicks, submits, ...snapshot } = fill(current);
      void clicks;
      void submits;
      return structuredClone(snapshot);
    },
    async click(ref) {
      log.push(`click ${ref}`);
      const next = current?.clicks?.[ref];
      if (next) current = states[next];
    },
    async fill(ref, text, submit) {
      log.push(`fill ${ref} ${text}${submit ? ' ⏎' : ''}`);
      typed = text;
      const next = submit ? current?.submits?.[ref] : undefined;
      if (next) current = states[next];
    },
    async close() {
      log.push('close');
    },
  };
  return {
    log,
    get opened() {
      return opened;
    },
    async open() {
      opened++;
      return page;
    },
  };
}

/** 和 /spa.html 一样的社区问答页：打开、点了「加载更多」、搜索以后，一共三个状态 */
export function spaStates(url: string): Record<string, FakeState> {
  const elements = [
    { ref: 'e1', role: 'searchbox', name: '搜索问题' },
    { ref: 'e2', role: 'textbox', name: '密码', password: true },
    { ref: 'e3', role: 'button', name: '加载更多' },
  ];
  return {
    [url]: {
      url,
      title: '潮汐社区问答',
      text: '潮汐社区问答\n问：3.0 支持 IPv6 吗？答：从 3.0.2 开始支持。',
      elements,
      clicks: { e3: 'more' },
      submits: { e1: 'search' },
    },
    more: {
      url,
      title: '潮汐社区问答',
      text: '潮汐社区问答\n问：3.0 支持 IPv6 吗？答：从 3.0.2 开始支持。\n问：默认最大连接数是多少？答：10000，可以用 limits.max_connections 调整。',
      elements: [elements[0], elements[1], { ...elements[2], disabled: true }],
    },
    search: { url: `${url}?q=1`, title: '潮汐社区问答', text: '搜索「{text}」：找到 1 条', elements },
  };
}
