// 第 14 天：分页的游标。服务器是无状态的，不记得「上次读到哪了」，所以把进度写进游标交给 client，
// client 下次调用时原样带回来。游标对 client 来说是一个看不懂的字符串，只能原样传回。
//
// 这里的游标没有签名，client 可以自己改。它只记录读到了哪里，改了最多就是读错位置，所以没关系；
// 如果游标里有权限之类的信息，就要用 HMAC 签名，防止被篡改。

/** 游标里的内容。kind 区分是哪个工具的游标，免得把 search_notes 的游标传给 read_note */
export type CursorData =
  | { kind: 'search'; query: string; offset: number }
  | { kind: 'read'; path: string; offset: number };

/** 游标的版本。格式变了就加一，旧的游标会被拒绝，而不是被读错 */
const VERSION = 1;

/** 编码成 base64url：只有字母、数字、- 和 _，放在 JSON 里、网址里都不用转义 */
export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify({ v: VERSION, ...data })).toString('base64url');
}

/**
 * 解码游标，并检查是不是指定的那一种。游标坏了、版本不对、种类不对，都抛出错误，
 * 错误信息告诉模型该怎么办：不带 cursor 重新调用
 */
export function decodeCursor<K extends CursorData['kind']>(cursor: string, kind: K): Extract<CursorData, { kind: K }> {
  let data: any;
  try {
    data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    data = undefined;
  }
  const valid = data && data.v === VERSION && data.kind === kind && Number.isInteger(data.offset) && data.offset >= 0;
  if (!valid) throw new Error(`cursor 无效或者已经过期。去掉 cursor 参数，从头重新调用`);
  const { v: _, ...rest } = data;
  return rest;
}
