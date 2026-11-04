// 解析 SSE（Server-Sent Events）：把服务器推过来的字节流，切成一个个事件。

export interface SSEEvent {
  /** event: 字段。OpenAI 兼容接口不用它，第 8 天的 Anthropic 协议靠它区分事件类型 */
  event?: string;
  /** data: 字段。一个事件有多行 data 时，用换行连起来 */
  data: string;
}

/**
 * 逐个交出事件。事件之间用空行分隔，但网络传输不会按事件切块：
 * 一个事件可能被拆进好几块，一块里也可能有好几个事件，甚至一个汉字的几个字节都会被拆开
 */
export async function* parseSSE(stream: AsyncIterable<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = ''; // 还没凑成完整一行的文字
  let data: string[] = [];
  let event: string | undefined;

  for await (const chunk of stream) {
    // stream: true：一个汉字的几个字节被拆在两块里时，解码器会先留着前半个字，等下一块
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? ''; // 最后一段可能是半行，留到下一块再处理
    for (const line of lines) {
      if (line === '') {
        // 空行：一个事件结束
        if (data.length > 0) yield { event, data: data.join('\n') };
        data = [];
        event = undefined;
      } else if (line.startsWith('data:')) {
        data.push(fieldValue(line, 'data:'));
      } else if (line.startsWith('event:')) {
        event = fieldValue(line, 'event:');
      }
      // 以冒号开头的是注释，服务器常用它保持连接；id:、retry: 我们用不到。都忽略
    }
  }
  // 流结束了，最后一个事件后面却没有空行：也交出去
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(fieldValue(buffer, 'data:'));
  if (data.length > 0) yield { event, data: data.join('\n') };
}

/** 去掉字段名，以及冒号后面的一个空格 */
function fieldValue(line: string, field: string): string {
  const value = line.slice(field.length);
  return value.startsWith(' ') ? value.slice(1) : value;
}
