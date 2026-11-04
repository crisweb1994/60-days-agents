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

/** 连接中途断开：流式响应还没正常结束，连接就关了。这类错误重试往往就好了（第 9 天） */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

type ErrorBody = { error?: { message?: string; code?: unknown; type?: string } | string };

/** 把失败的响应转成 ModelError。错误体通常是 JSON，但也可能是网关返回的一页 HTML */
export async function toModelError(res: Response): Promise<ModelError> {
  const body = await res.text();
  let detail = body.trim().slice(0, 300) || res.statusText;
  let code: string | undefined;
  let type: string | undefined;
  try {
    const { error } = JSON.parse(body) as ErrorBody;
    if (typeof error === 'string') {
      detail = error;
    } else if (error) {
      if (error.message) detail = error.message;
      if (error.code != null) code = String(error.code);
      type = error.type;
    }
  } catch {
    // 不是 JSON，就用原文
  }
  return new ModelError(res.status, `模型调用失败（${res.status}）：${detail}`, { code, type, headers: res.headers });
}
