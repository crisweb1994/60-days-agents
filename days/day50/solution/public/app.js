// 第 50 天：上线版的网页。和第 44 天相比：
//   先登录（Cookie 由服务器设置，脚本读不到）；提问改成提交后台任务（POST /api/research → 202 和任务编号）
//   进度用 EventSource 订阅 /api/jobs/:id/events：断线以后浏览器自动重连，带上 Last-Event-ID，服务器只补发后面的块（第 45 天）
//   刷新页面也不丢：任务编号记在 sessionStorage 里，回来接着看
//   完成以后可以点赞、点踩、写一句评论（第 49 天）
// 模型的输出一律当作文字放进 textContent，不用 innerHTML（第 37、44 天）。
import { applyChunk, initialTimeline } from '/timeline.js';

const $ = (id) => document.getElementById(id);
let state = initialTimeline();
let source;
let jobId;
let last;

const STATUS = { idle: '', streaming: '正在调研……（可以关掉页面，回来接着看）', done: '完成', error: '出错了', aborted: '已停止' };

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function safeLink(url, text) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return el('a', { href: u.href, textContent: text, target: '_blank', rel: 'noopener noreferrer' });
  } catch {}
  return document.createTextNode(text);
}

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `请求失败（${res.status}）`);
  return body;
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
  $('feedback').hidden = state.status !== 'done' || !state.answer;
}

/** 订阅一个任务的进度。EventSource 断线会自动重连并带上 Last-Event-ID；收到 [DONE] 就关掉 */
function follow(id) {
  source?.close();
  jobId = id;
  sessionStorage.setItem('jobId', id);
  state = applyChunk(initialTimeline(), { type: 'start' });
  $('thanks').textContent = '';
  $('comment').value = '';
  $('up').disabled = $('down').disabled = false;
  render();
  source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  source.onmessage = (event) => {
    if (event.data === '[DONE]') {
      source.close();
      return;
    }
    const chunk = JSON.parse(event.data);
    if (chunk.type === 'start') return; // 重连时会再收到一次 start，不能把已经画出来的清掉
    state = applyChunk(state, chunk);
    render();
  };
  source.onerror = () => {
    // 服务器重启、网络抖动时浏览器会自己重连；任务不存在（404）时 readyState 变成 CLOSED，不会再连
    if (source.readyState === EventSource.CLOSED && state.status === 'streaming') {
      state = applyChunk(state, { type: 'error', errorText: '连接断开了，可以刷新页面接着看' });
      render();
    }
  };
}

async function ask(question, mode) {
  last = { question, mode };
  try {
    const job = await api('/api/research', { method: 'POST', body: JSON.stringify({ question, mode }) });
    follow(job.id);
  } catch (error) {
    state = applyChunk(applyChunk(initialTimeline(), { type: 'start' }), { type: 'error', errorText: error.message });
    render();
  }
}

async function sendFeedback(rating) {
  if (!jobId) return;
  const comment = $('comment').value.trim();
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}/feedback`, { method: 'POST', body: JSON.stringify({ rating, ...(comment ? { comment } : {}) }) });
    $('thanks').textContent = rating === 'up' ? '谢谢！' : '谢谢，我们会看这个问题';
    $('up').disabled = $('down').disabled = true;
  } catch (error) {
    $('thanks').textContent = error.message;
  }
}

async function showSignedIn(me) {
  $('auth').hidden = true;
  $('who').hidden = false;
  $('form').hidden = false;
  $('me').textContent = me.admin ? '已登录（管理员）' : '已登录';
  const saved = sessionStorage.getItem('jobId');
  if (saved) follow(saved);
  render();
}

async function authenticate(path) {
  const body = { email: $('email').value.trim(), password: $('password').value, ...($('invite').value.trim() ? { invite: $('invite').value.trim() } : {}) };
  try {
    await api(path, { method: 'POST', body: JSON.stringify(body) });
    await showSignedIn(await api('/api/me'));
  } catch (error) {
    $('status').textContent = error.message;
    $('status').className = 'error';
  }
}

$('auth').addEventListener('submit', (event) => {
  event.preventDefault();
  authenticate('/api/login');
});
$('signup').addEventListener('click', () => authenticate('/api/signup'));
$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  sessionStorage.removeItem('jobId');
  location.reload();
});
$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = $('question').value.trim();
  if (question) ask(question, $('mode').value);
});
$('stop').addEventListener('click', () => jobId && api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {}));
$('retry').addEventListener('click', () => last && ask(last.question, last.mode));
$('up').addEventListener('click', () => sendFeedback('up'));
$('down').addEventListener('click', () => sendFeedback('down'));

api('/api/me').then(showSignedIn, () => {
  $('auth').hidden = false;
  render();
});
