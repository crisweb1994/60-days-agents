# 配置

配置文件叫 tide-config.yaml，默认放在 /etc/tide/ 下面。修改以后要执行 `tide reload` 才会生效。

## 握手

`handshake.retries` 控制握手失败后的重试次数，默认 3 次。`handshake.timeout_ms` 是单次握手的超时，默认 2000 毫秒。

## 日志

`log.level` 可以是 debug、info、warn、error，默认 info。
