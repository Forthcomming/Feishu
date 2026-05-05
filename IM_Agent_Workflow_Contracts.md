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
- 会话频道：`conversation:{conversationId}`（多端一致性：承载 presence 与 `conversation.task_active` 广播）
- 文档频道：`doc:{docId}`（协同编辑：承载 `blocks:update / blocks:conflict / blocks:ack` 与 `tasks:update / tasks:conflict / tasks:ack`）

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

### `task.confirm_resolved`

任一端点击"确认执行"或"取消任务"后，后端向 `task:{taskId}` 广播该事件，其它端据此清除本地确认弹窗，避免 UI 残留。

```json
{
  "eventType": "task.confirm_resolved",
  "taskId": "task_7f5c",
  "stepId": "step_send_delivery_message",
  "approved": true,
  "at": 1760000005000
}
```

### `conversation.task_active`

`POST /api/agent/workflow/start` 成功后，`agent-service` 向 `realtime-server` 的 `POST /api/conversation-events` 推送此事件；realtime-server 广播到 `conversation:{conversationId}` 房间，订阅端自动切换到新任务，无需轮询 `/latest-task`。

```json
{
  "eventType": "conversation.task_active",
  "conversationId": "oc_xxx",
  "taskId": "task_7f5c",
  "state": "detecting",
  "at": 1760000006000
}
```

### `conversation:snapshot` / `presence:update`

客户端 `emit("conversation:join", { cid })` 加入会话房间后，服务端回 `conversation:snapshot`（含当前活跃任务与在线端列表）。成员进出会话房间时向同房间广播 `presence:update`。

```json
{
  "cid": "oc_xxx",
  "activeTaskId": "task_7f5c",
  "presence": [
    { "socketId": "s1", "device": "desktop", "joinedAt": 1760000007000 },
    { "socketId": "s2", "device": "mobile",  "joinedAt": 1760000007200 }
  ]
}
```

### `blocks:update` / `blocks:conflict` / `blocks:ack`（乐观锁）

文档内容采用"带基版本的乐观并发控制（CAS）"。客户端 `emit("blocks:update", { docId, blocks, baseVersion })`：若 `baseVersion == 服务器当前 version` 则 `version + 1` 并广播新版本；否则仅向发起方回 `blocks:conflict`，请用户手动解决。`tasks:update` / `tasks:conflict` / `tasks:ack` 同构。

```json
// blocks:update（服务端广播给房间其它成员）
{
  "docId": "oc_xxx",
  "blocks": [{ "id": "memo", "type": "text", "content": "..." }],
  "version": 12,
  "serverTs": 1760000008000
}

// blocks:ack（服务端回发给发起方）
{ "docId": "oc_xxx", "version": 12, "serverTs": 1760000008000 }

// blocks:conflict（服务端仅回发给失败一方）
{
  "docId": "oc_xxx",
  "serverBlocks": [{ "id": "memo", "type": "text", "content": "..." }],
  "serverVersion": 12
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
