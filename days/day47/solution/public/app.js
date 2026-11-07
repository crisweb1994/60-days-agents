// 第 44 天：网页的脚本。发起研究、读 SSE 流、用 timeline.js 归并状态、重画界面。
// 模型的输出一律当作文字放进 textContent，不用 innerHTML：回答里可能有攻击者写进网页的 HTML 和图片（第 37 天）。
import { applyChunk, createSSEDecoder, initialTimeline } from '/timeline.js';

const $ = (id) => document.getElementById(id);
let state = initialTimeline();
let controller;
let last;

const STATUS = { idle: '', streaming: '正在调研……', done: '完成', error: '出错了', aborted: '已停止' };

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** 只接受 http 和 https 的链接，别的（javascript: 之类）当作文字 */
function safeLink(url, text) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return el('a', { href: u.href, textContent: text, target: '_blank', rel: 'noopener noreferrer' });
  } catch {}
  return document.createTextNode(text);
}

function render() {
  $('status').textContent = state.status === 'error' ? `${STATUS.error}：${state.error}` : STATUS[state.status];
  $('status').className = state.status === 'error' ? 'error' : '';
  $('timeline').replaceChildren(
    ...state.items.map((item) => {
      if (item.kind === 'text') return el('li', { className: item.done ? 'done' : 'running' }, [el('div', { className: 'step-text', textContent: item.text })]);
      if (item.kind === 'progress') return el('li', { className: 'done', textContent: item.label });
      const label = item.status === 'running' ? '调用中' : item.status === 'error' ? '出错' : '完成';
      const children = [el('span', { className: 'tool-name', textContent: item.name }), document.createTextNode(` · ${label} `), el('div', { className: 'tool-input', textContent: JSON.stringify(item.input) })];
      if (item.output) children.push(el('details', {}, [el('summary', { textContent: '结果' }), el('pre', { textContent: item.output })]));
      return el('li', { className: item.status }, children);
    }),
  );
  $('answer').textContent = state.answer ? `${state.answer.text}${state.answer.note ? `\n\n（${state.answer.note}）` : ''}` : '';
  $('sources').replaceChildren(...state.sources.map((s) => el('li', {}, [safeLink(s.url, `[${s.id}] ${s.title}`)])));
  const running = state.status === 'streaming';
  $('ask').disabled = running;
  $('stop').disabled = !running;
  $('retry').disabled = running || !last;
}

async function ask(question, mode) {
  last = { question, mode };
  controller = new AbortController();
  state = applyChunk(initialTimeline(), { type: 'start' });
  render();
  try {
    const res = await fetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, mode }), signal: controller.signal });
    if (!res.ok) {
      state = applyChunk(state, { type: 'error', errorText: (await res.json()).error ?? `请求失败（${res.status}）` });
      return render();
    }
    const decoder = createSSEDecoder();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const chunk of decoder.push(value)) state = applyChunk(state, chunk);
      render();
    }
    if (state.status === 'streaming') state = applyChunk(state, { type: 'error', errorText: '连接中断了，可以点重试' });
  } catch (error) {
    state = controller.signal.aborted ? applyChunk(state, { type: 'abort' }) : applyChunk(state, { type: 'error', errorText: '连接中断了，可以点重试' });
  }
  render();
}

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = $('question').value.trim();
  if (question) ask(question, $('mode').value);
});
$('stop').addEventListener('click', () => controller?.abort());
$('retry').addEventListener('click', () => last && ask(last.question, last.mode));
render();
