---
name: feishu-docs
description: >
  读取和搜索飞书文档。当用户分享了 feishu.cn 或 larkoffice.com 的链接、
  要求查看飞书文档/Wiki 内容、或需要搜索飞书中的文档时触发。
  需要用户已在 Web 设置页完成飞书 OAuth 授权。
allowed-tools: Bash(*)
user-invocable: true
argument-hint: <飞书文档链接或搜索关键词>
---

# 飞书文档读取与搜索

通过后端内部 API 读取和搜索飞书文档。所有请求使用环境变量中的凭据。

## 前置检查

执行前先确认环境变量存在：

```bash
[ -z "$HAPPYCLAW_USER_ID" ] && echo "错误: 未设置 HAPPYCLAW_USER_ID，无法访问飞书文档" && exit 1
```

## 操作 1: 读取飞书文档

支持 `feishu.cn` 和 `larkoffice.com` 的 wiki/docx/sheets 链接。Wiki 节点指向
电子表格时，会读取 URL 中 `sheet` 参数指定的工作表；未指定时读取第一个工作表。
表格内容以制表符分隔的纯文本返回，并设置行数、单元格数和字符数上限。

```bash
curl -s --max-time 30 -X POST "$HAPPYCLAW_API_URL/api/internal/feishu/read-document" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HAPPYCLAW_INTERNAL_TOKEN" \
  -d "{\"userId\": \"$HAPPYCLAW_USER_ID\", \"url\": \"<替换为飞书文档URL>\"}"
```

**成功响应**：`{"title": "文档标题", "content": "文档内容..."}`
- 将 title 作为标题、content 作为正文展示给用户

**错误响应**：
- `{"code": "OAUTH_REQUIRED"}` → 告知用户需要在 Web 设置页面完成「飞书文档授权」
- `{"code": "FEISHU_SCOPE_REQUIRED"}` → 告知用户应用需要开通对应文档类型的只读权限，并重新授权
- 其他错误 → 展示 `error` 字段内容

## 操作 2: 搜索飞书文档

根据关键词搜索云文档和 Wiki 页面。

```bash
curl -s --max-time 30 -X POST "$HAPPYCLAW_API_URL/api/internal/feishu/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HAPPYCLAW_INTERNAL_TOKEN" \
  -d "{\"userId\": \"$HAPPYCLAW_USER_ID\", \"query\": \"<搜索关键词>\", \"count\": 20, \"searchWiki\": true}"
```

**可选参数**（加在 JSON body 中）：
- `count`: 返回数量（默认 20，最大 50）
- `searchWiki`: 是否搜索 Wiki（默认 true）
- `docTypes`: 文档类型数组，如 `["docx", "sheet", "wiki"]`

**成功响应**：`{"results": [...], "hasMore": false, "total": 5}`
- 每个 result 包含：`title`, `url`, `docType`, `owner`, `preview`, `updateTime`
- 格式化为编号列表展示给用户
- 搜索结果中的文档链接可以用操作 1 进一步读取完整内容

**错误处理**同操作 1。
