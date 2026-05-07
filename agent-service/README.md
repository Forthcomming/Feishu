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

## IM 语音支持配置

当通过 `POST /api/feishu/events` 接收 IM 消息时，服务现在支持文本和语音两种入口。  
语音会先转写为文本，再复用现有意图与工作流链路。

可选环境变量：

- `FEISHU_VOICE_ENABLED`：是否开启语音转写（`true`/`false`，默认 `false`）
- `FEISHU_VOICE_TRANSCRIBE_URL`：语音转写服务地址（建议使用飞书侧能力网关）
- `FEISHU_VOICE_TRANSCRIBE_TOKEN`：转写接口 Bearer Token（可选）
- `FEISHU_VOICE_TIMEOUT_MS`：转写超时毫秒数（默认 `15000`）

## 编辑意图（LLM + 规则兜底）

工作流在解析「改文档 / 改幻灯片」等精细指令时，默认在已配置 Doubao/DeepSeek 的情况下调用 LLM 输出结构化编辑意图；失败或未配置时回退到正则 [`editIntentParser`](src/editIntentParser.js)。编辑意图正文仅取本轮指令句与显式 `docTarget`/`slidesTarget`（见 [`editIntentSource`](src/editIntentSource.js)）；稿件链接仍可由 `resolveDocTarget` / `resolveSlidesTarget` 从上下文解析。

相关环境变量：

- `EDIT_INTENT_LLM_ENABLED`：`true`/`false`；未设置时，**有 LLM 密钥则视为启用**，否则仅用规则。
- `EDIT_INTENT_TIMEOUT_MS`：编辑意图 LLM 超时毫秒数（默认 `8000`）。
- `DOUBAO_EDIT_INTENT_ENDPOINT_ID`：豆包下单独指定编辑意图解析用的接入点 ID（可选，默认同 `DOUBAO_ENDPOINT_ID`）。
- `DEEPSEEK_EDIT_INTENT_MODEL`：DeepSeek 下单独指定模型（可选，默认同 `DEEPSEEK_MODEL`）。

日志字段 `workflow.edit_plan` 中会附带 `edit_intent_source`：`llm` | `rule` | `llm_invalid`。

