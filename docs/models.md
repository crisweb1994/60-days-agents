# 模型接入说明

课程代码默认通过 OpenAI 兼容接口调用模型，第 8 天起同时支持 Anthropic 兼容接口。模型名和接口细节变化很快，讲义里不写死，统一以本页和 `.env.example` 为准。

<!-- TODO: 写明默认模型，以及 CI 用哪个模型跑 e2e 验证 -->
<!-- TODO: 逐家写明 OpenAI / Anthropic 兼容接口的 base URL、是否提供 embedding 和视觉模型，以及最后核对日期 -->

## 已知的兼容差异

- 有的 Anthropic 兼容接口会忽略缓存控制字段。
- 停止原因的取值不统一。比如智谱 GLM 的 `finish_reason` 除了 `stop`、`length`、`tool_calls`，还有表示内容被安全审核拦截的 `sensitive`，以及表示推理异常的 `network_error`。
