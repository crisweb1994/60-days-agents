// 模型接口返回的错误。状态码、错误码和响应头都留着：排查问题要看它们，第 9 天的重试也要靠它们判断。

export class ModelError extends Error {
  /** HTTP 状态码，比如 401、429、500 */
  readonly status: number;
  /** 错误体里的 error.code，比如 insufficient_quota。不是每家都返回 */
  readonly code: string | undefined;
  /** 错误体里的 error.type，比如 invalid_request_error */
  readonly type: string | undefined;
  /** 响应头。第 9 天要从里面读 Retry-After */
  readonly headers: Headers;

  constructor(status: number, message: string, options: { code?: string; type?: string; headers?: Headers } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.code = options.code;
    this.type = options.type;
    this.headers = options.headers ?? new Headers();
  }
}

/** 把失败的响应转成 ModelError。错误体通常是 JSON，但也可能是网关返回的一页 HTML */
export async function toModelError(res: Response): Promise<ModelError> {
  // TODO 3：读出错误信息，生成 ModelError。
  // - 用 res.text() 读出响应体，再试着 JSON.parse。错误体一般长这样：
  //   { "error": { "message": "…", "type": "invalid_request_error", "code": "…" } }
  // - 解析成功：错误信息用 error.message，再把 error.code（转成字符串）和 error.type 带上
  // - 解析失败（比如网关返回的 HTML 错误页）：错误信息用响应的原文，太长就截断
  // - 错误信息里带上状态码，比如「模型调用失败（401）：…」，再把 res.headers 传进去
  return new ModelError(res.status, `TODO 3：还没有读取错误信息（${res.status}）`);
}
