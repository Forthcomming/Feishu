# Agent Service（最简 Intent 解析）

这是一个独立的 Node.js + Express 服务，用于：
1. 接收用户输入
2. 调用 LLM 解析意图（当前用 stub 模拟）
3. 返回结构化结果（同时返回模拟的 `TaskStateEvent` 进度）

## 启动

```bash
cd agent-service
npm install
npm start
```

默认端口：`3001`（可通过环境变量 `PORT` 覆盖）。

## 接口

`POST /api/agent/parse-intent`

请求体：

```json
{
  "input": "帮我把讨论整理成需求文档并给出关键结论",
  "conversationId": "demo_conversation"
}
```

返回体（示例字段）：

```json
{
  "task": { "taskId": "...", "taskKind": "intent_parse", "state": "completed" },
  "events": [{ "eventType": "TaskStateEvent", "state": "detecting" }, { "state": "completed" }],
  "result": {
    "intent": { "name": "generate_requirements_doc", "confidence": 0.8 },
    "slots": { "outputKinds": ["doc", "summary"], "documentKind": "requirements", "wantsUserConfirm": false },
    "entities": [{ "type": "documentKind", "value": "requirements" }]
  }
}
```

## 示例（curl）

```bash
curl -sS -X POST "http://localhost:3001/api/agent/parse-intent" ^
  -H "Content-Type: application/json; charset=utf-8" ^
  -d "{\"input\":\"请生成一版评审PPT并做汇报演示\"}"
```

## 备注

- 当前不接入真实 IM；`input` 直接来自 HTTP 请求。
- 当前不接入真实 LLM；后续仅需替换 `src/intentParser.js` 内的 stub 即可保持接口契约不变。

