// 第 27 天：用 Playwright 驱动真正的浏览器（Chromium），实现 browser.ts 里的 BrowserPage。
// 第一次用之前要下载浏览器：npx playwright install chromium
// 看页面的办法：在页面里运行一段脚本，找出所有看得见、能操作的元素，给每个元素加上 data-agent-ref="e3" 这样的属性，
// 再把它们的角色、名字列出来。模型说「点 e3」时，用这个属性找到元素。
import type { Page } from 'playwright';
import { checkUrl, type BrowserPage, type PageSnapshot, type UrlPolicy } from './browser.ts';

/**
 * 在页面里运行的脚本。写成字符串交给 page.evaluate：它在浏览器里运行，用的是浏览器的 document，
 * 而这个项目的 TypeScript 配置里没有 DOM 的类型
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const ATTR = 'data-agent-ref';
  for (const el of document.querySelectorAll('[' + ATTR + ']')) el.removeAttribute(ATTR);
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const BUTTON_TYPES = ['button', 'submit', 'reset', 'image'];
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag !== 'input') return 'button';
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (BUTTON_TYPES.includes(type)) return 'button';
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'search') return 'searchbox';
    return 'textbox';
  };
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const nameOf = (el) =>
    clean(el.getAttribute('aria-label')) || clean(el.innerText) || clean(BUTTON_TYPES.includes(el.type) ? el.value : '') ||
    clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) || clean(el.getAttribute('alt'));
  const selector = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem]';
  const elements = [];
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    const ref = 'e' + (elements.length + 1);
    el.setAttribute(ATTR, ref);
    const role = roleOf(el);
    const typing = ['textbox', 'searchbox', 'combobox'].includes(role);
    elements.push({
      ref,
      role,
      name: nameOf(el),
      value: typing && el.value ? String(el.value) : undefined,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
      password: el.type === 'password' || undefined,
    });
  }
  return { url: location.href, title: document.title, text: document.body ? document.body.innerText : '', elements };
})()`;

export interface PlaywrightOptions extends UrlPolicy {
  /** 不显示浏览器窗口，默认 true。调试时改成 false，可以看着它操作 */
  headless?: boolean;
  /** 每个操作最多等多久，默认 15 秒 */
  timeoutMs?: number;
}

/** 等页面安静下来：网络请求停了，或者最多等 3 秒。很多页面一直有请求（统计、轮询），不能无限等 */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
}

function wrapPage(page: Page): BrowserPage {
  const element = (ref: string) => page.locator(`[data-agent-ref="${ref}"]`);
  return {
    async goto(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await settle(page);
    },
    snapshot: () => page.evaluate(SNAPSHOT_SCRIPT) as Promise<PageSnapshot>,
    async click(ref) {
      await element(ref).click();
      await settle(page);
    },
    async fill(ref, text, submit) {
      await element(ref).fill(text);
      if (submit) await element(ref).press('Enter');
      await settle(page);
    },
    close: () => page.close(),
  };
}

export interface PlaywrightBrowser {
  /** 打开一个新的标签页。第一次调用时才启动浏览器 */
  open(): Promise<BrowserPage>;
  close(): Promise<void>;
}

/** 创建一个按需启动的浏览器。不调用 open 就不启动，不用浏览器的会话不花这几百毫秒和几百 MB 内存 */
export function createPlaywrightBrowser(options: PlaywrightOptions = {}): PlaywrightBrowser {
  const { headless = true, timeoutMs = 15_000 } = options;
  let starting: Promise<{ close(): Promise<void>; newPage(): Promise<Page> }> | undefined;

  async function start() {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless }).catch((error: Error) => {
      if (/Executable doesn't exist|npx playwright install/i.test(error.message)) throw new Error('还没有下载浏览器：先运行 npx playwright install chromium');
      throw error;
    });
    // 不下载文件，不用 Service Worker（它发出的请求拦不住）
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    // 页面里的每个请求（脚本、图片、iframe、跳转）都检查一遍地址：网页里的一段脚本也可能去访问你的内网
    await context.route('**/*', (route) => {
      const url = route.request().url();
      return /^https?:/.test(url) && checkUrl(url, options) ? route.abort('blockedbyclient') : route.continue();
    });
    return {
      close: () => browser.close(),
      async newPage() {
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);
        return page;
      },
    };
  }

  return {
    async open() {
      starting ??= start();
      return wrapPage(await (await starting).newPage());
    },
    async close() {
      if (starting) await (await starting.catch(() => undefined))?.close();
      starting = undefined;
    },
  };
}
