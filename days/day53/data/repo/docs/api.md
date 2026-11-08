# 接口

所有接口都要在 `Authorization` 头里带上 `Bearer <token>`，登录接口除外。

## GET /todos?page=1

当前用户的待办，每页 20 条，按创建时间排序。

## GET /todos/search?q=关键词

按标题搜索当前用户的待办，不区分大小写。
