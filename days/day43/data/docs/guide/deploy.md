# 部署

潮汐网关支持三种部署方式：Docker、二进制和 Kubernetes。

## 用 Docker 部署

运行 `docker run -p 7443:7443 tide/gateway:3.0` 启动网关。默认端口是 7443。

## 上线前的检查

上线之前要确认 TLS 证书没有过期，并且在 #release 频道里通知当天值班的人。灰度阶段先放 5% 的流量。
