# IM Agent Workflow 与事件契约（CLI 融合版）

> 目标：为 `agent-service`、`realtime-server`、`frontend` 提供统一契约，支持最小闭环 `IM -> Doc -> IM交付`，并兼容后续 `Doc -> Slides` 扩展。

## 1. REST API 契约

## 1.1 `POST /api/agent/workflow/start`

### 请求体

```json
{
  "conversationId": "conv_demo_001",
  "input": "帮我整理需求并生成汇报材料",
  "contextRange": {
    "mode": "recent_messages",
    "limit": 50
  },
  "targetArtifacts": ["doc", "slides"],
  "delivery": {
    "channel": "im_chat",
    "chatId": "oc_xxx"
  },
  "execution": {
    "dryRun": true,
    "defaultIdentity": "bot"
  }
}
```

### 字段说明
- `conversationId`: 业务会话标识，用于多端订阅和回放。
- `input`: 用户自然语言指令。
- `contextRange`: 上下文提取范围，首版建议仅支持最近 N 条消息。
- `targetArtifacts`: 目标产物，支持 `doc`、`slides`。
- `delivery`: 交付渠道，首版建议固定为 IM 回传。
- `execution.dryRun`: 写操作默认建议 `true`，由确认节点切换到真实执行。
- `execution.defaultIdentity`: `user` 或 `bot`。

### 响应体

```json
{
  "ok": true,
  "task": {
    "taskId": "task_7f5c",
    "conversationId": "conv_demo_001",
    "state": "detecting"
  },
  "subscribe": {
    "channel": "task:task_7f5c"
  }
}
```

## 1.2 `POST /api/agent/workflow/confirm`

### 请求体

```json
{
  "taskId": "task_7f5c",
  "stepId": "step_send_delivery_message",
  "approved": true,
  "override": {
    "dryRun": false,
    "identity": "bot"
  }
}
```

### 响应体

```json
{
  "ok": true,
  "taskId": "task_7f5c",
  "stepId": "step_send_delivery_message",
  "accepted": true
}
```

## 1.3 `GET /api/agent/workflow/:taskId`

### 响应体

```json
{
  "ok": true,
  "task": {
    "taskId": "task_7f5c",
    "conversationId": "conv_demo_001",
    "state": "completed",
    "currentStepId": null,
    "steps": [
      {
        "stepId": "step_extract_intent",
        "status": "completed"
      },
      {
        "stepId": "step_create_doc",
        "status": "completed"
      },
      {
        "stepId": "step_send_delivery_message",
        "status": "completed"
      }
    ]
  },
  "artifacts": [
    {
      "artifactId": "doc_001",
      "kind": "doc",
      "title": "需求文档",
      "url": "https://feishu.cn/docx/xxx"
    }
  ]
}
```

## 2. WebSocket 事件契约

## 2.1 频道规则
- 任务频道：`task:{taskId}`
- 会话频道：`conversation:{conversationId}`

## 2.2 事件定义（最小集合）

### `task.state`

```json
{
  "eventType": "task.state",
  "taskId": "task_7f5c",
  "state": "executing",
  "at": 1760000000000
}
```

### `task.step`

```json
{
  "eventType": "task.step",
  "taskId": "task_7f5c",
  "step": {
    "stepId": "step_create_doc",
    "label": "创建飞书文档",
    "status": "running"
  },
  "at": 1760000001000
}
```

### `task.artifact`

```json
{
  "eventType": "task.artifact",
  "taskId": "task_7f5c",
  "artifact": {
    "artifactId": "doc_001",
    "kind": "doc",
    "title": "需求文档",
    "url": "https://feishu.cn/docx/xxx"
  },
  "at": 1760000002000
}
```

### `task.confirm_required`

```json
{
  "eventType": "task.confirm_required",
  "taskId": "task_7f5c",
  "stepId": "step_send_delivery_message",
  "reason": "该步骤将真实发送 IM 消息",
  "options": {
    "approveEndpoint": "/api/agent/workflow/confirm"
  },
  "at": 1760000003000
}
```

### `task.error`

```json
{
  "eventType": "task.error",
  "taskId": "task_7f5c",
  "stepId": "step_send_delivery_message",
  "error": {
    "code": "MISSING_SCOPE",
    "message": "missing required scope: im:message.send_as_user",
    "retryable": true
  },
  "at": 1760000004000
}
```

## 3. 状态机契约

## 3.1 状态集合
- `idle`
- `detecting`
- `intent`
- `planning`
- `executing`
- `completed`
- `reflecting`
- `failed`
- `cancelled`

## 3.2 迁移规则（首版）
- `idle -> detecting -> intent -> planning -> executing`
- `executing -> completed | failed | cancelled`
- `completed -> reflecting -> idle`

## 4. 错误码建议

- `MISSING_SCOPE`: 缺少权限 scope。
- `PERMISSION_DENIED`: 有 scope 但服务端拒绝（例如 230027）。
- `CLI_COMMAND_UNSUPPORTED`: 当前 CLI 版本不支持命令参数。
- `DELIVERY_TARGET_INVALID`: 目标群或用户不可用。
- `TOOL_TIMEOUT`: CLI 调用超时。

## 5. 幂等与重试

- 每个写步骤带 `idempotencyKey`，规则：`taskId + stepId + attempt`。
- `confirm` 接口需幂等：重复提交同一 `taskId + stepId` 不应重复触发发送。
- `task.error.retryable=true` 时前端可展示“重试当前步骤”。
