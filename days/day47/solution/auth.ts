// 第 46 天：登录和鉴权。三样东西：
//   密码：scrypt 加盐哈希，只存哈希；比较用固定时间
//   会话令牌：登录成功后发一个带签名的令牌（放在 HttpOnly 的 Cookie 里），服务端不用存会话也能验证
//   API Key：给程序调用。只显示一次明文，库里只存 sha256（第 40 天）
// 认出用户以后，后面的每一次数据访问都用 withTenant(db, 用户编号, …)。
import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { withTenant, type Db } from './db.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;

/** scrypt 的参数：N 越大越慢，越难暴力破解。测试时可以调小 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}
export const DEFAULT_SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1 };

/** 密码的哈希，格式是 scrypt$N$r$p$盐$哈希（都是 base64url）。参数写进去，以后调大参数，旧的哈希也还能验证 */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** 验证密码。格式不对返回 false；用存下来的参数和盐重新算一遍，固定时间比较 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = stored.split('$');
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (kind !== 'scrypt' || !salt || !hash || !Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length === 0) return false;
  try {
    const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, params);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- 会话令牌 ----------

export interface TokenPayload {
  /** 用户编号 */
  sub: string;
  /** 过期时间，Unix 秒 */
  exp: number;
}

const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('base64url');

/** 令牌是「载荷的 base64url.签名」。载荷只放用户编号和过期时间：令牌不加密，别人能看到内容，只是改不了 */
export function createSessionToken(userId: string, secret: string, { ttlSeconds = 7 * 86_400, now = () => Date.now() } = {}): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(now() / 1000) + ttlSeconds } satisfies TokenPayload)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * 验证令牌：格式要是「两段用点连起来」；重新算签名，用 timingSafeEqual 比较（长度不同直接不对）；
 * 载荷解析得出 sub 和 exp，而且还没过期。任何一步不对都返回 undefined，不说是哪一步
 */
export function verifySessionToken(token: string | undefined, secret: string, now = () => Date.now()): TokenPayload | undefined {
  const parts = (token ?? '').split('.');
  if (parts.length !== 2) return undefined;
  const [payload, signature] = parts;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof data.sub !== 'string' || typeof data.exp !== 'number' || data.exp * 1000 <= now()) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

/** 放令牌的 Cookie：HttpOnly（脚本读不到，XSS 偷不走）、Secure（只走 HTTPS）、SameSite=Lax（挡住大部分跨站请求伪造） */
export function sessionCookie(token: string, maxAgeSeconds = 7 * 86_400): string {
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** 从 Cookie 头里取出 sid */
export function readSessionCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'sid') return rest.join('=');
  }
  return undefined;
}

// ---------- 用户和 API Key ----------

/** 注册。注册时还不知道是谁，用的是有建表权限的连接，不走 withTenant；生产上注册和登录也常放在单独的服务里 */
export async function createUser(db: Db, email: string, password: string, params?: ScryptParams): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  await db.query('insert into users (id, email, password_hash) values ($1, $2, $3)', [id, email.trim().toLowerCase(), await hashPassword(password, params)]);
  return { id, email: email.trim().toLowerCase() };
}

/** 登录：按邮箱找到用户、验证密码。邮箱不存在也算一次哈希，免得响应时间透露「这个邮箱注册过没有」 */
export async function login(db: Db, email: string, password: string): Promise<string | undefined> {
  const { rows } = await db.query<{ id: string; password_hash: string }>('select id, password_hash from users where email = $1', [email.trim().toLowerCase()]);
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  return user && ok ? user.id : undefined;
}
const DUMMY_HASH = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 给用户发一个 API Key：返回明文（只这一次），库里存 sha256。写入走 withTenant：只能给自己发 */
export async function issueApiKey(db: Db, userId: string, label = ''): Promise<string> {
  const key = `ra_${randomBytes(24).toString('base64url')}`;
  await withTenant(db, userId, (tx) => tx.query('insert into api_keys (hash, user_id, label) values ($1, $2, $3)', [sha256(key), userId, label]));
  return key;
}

/**
 * 用 API Key 找用户。这时还不知道是谁，api_keys 被 RLS 挡着，以应用角色查不到任何一行。
 * 所以调用迁移时建好的 lookup_api_key 函数：它是 security definer，以函数所有者（迁移用的管理员角色）的身份、只按哈希查一行。
 * 这是唯一一处绕过 RLS 的租户表查询，范围小到只能「按哈希换回用户编号」
 */
export async function findUserByApiKey(db: Db, key: string | undefined): Promise<string | undefined> {
  if (!key?.startsWith('ra_')) return undefined;
  const { rows } = await db.query<{ user_id: string | null }>('select lookup_api_key($1) as user_id', [sha256(key)]);
  return rows[0]?.user_id ?? undefined;
}
