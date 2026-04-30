# Phase 1 最小闭环改造清单（IM -> Doc -> IM交付）

> 目标：在不做大规模重构的前提下，基于现有工程跑通“Agent 编排 + 飞书文档创建 + IM 回传链接 + 多端进度同步”。

## 1. 范围定义

- 覆盖场景：A（IM入口）、B（任务规划）、C（文档生成）、E（多端同步）、F（总结交付）。
- 暂不强制：Slides 真创建（可保留前端预览过渡能力，Phase 2 再接）。
- 交付标准：桌面端触发后，移动端看到同任务进度，最终 IM 收到文档链接。

## 2. 模块改造点

## 2.1 `agent-service` 改造

### 文件与职责
- `server.js`
  - 新增 workflow 入口：
    - `POST /api/agent/workflow/start`
    - `POST /api/agent/workflow/confirm`
    - `GET /api/agent/workflow/:taskId`
  - 保留已有 `/api/lark-cli/*` 路由作为底层调试能力。

- 新增 `src/orchestrator.js`
  - 实现轻量状态机：
    - `detecting -> intent -> planning -> executing -> completed|failed`
  - 维护步骤上下文与错误处理。

- 新增 `src/taskStore.js`
  - 内存版任务存储（后续可替换 Redis/DB）。
  - 提供 `createTask/getTask/updateTask`。

- 新增 `src/taskEvents.js`
  - 标准化事件构造器：`task.state/task.step/task.artifact/task.error`。

- 复用 `src/larkCliCommands.js` 与 `src/larkCliRunner.js`
  - `CreateDoc` 步骤调用 docs create。
  - `SendDeliveryMessage` 步骤调用 messages send。

### 执行步骤模板（Phase 1）
1. `step_extract_intent`
2. `step_create_doc`
3. `step_send_delivery_message`

### 验收点
- `workflow/start` 返回 `taskId`。
- 执行结束后 `GET /workflow/:taskId` 可查到 doc artifact 链接。

## 2.2 `realtime-server` 改造

### 文件与职责
- `src/index.ts`
  - 新增任务订阅事件：
    - `task:join`（入参 `taskId`）
  - 新增任务广播事件：
    - `task:state`
    - `task:step`
    - `task:artifact`
    - `task:error`

### 存储策略
- Phase 1 可先用内存/Redis key 存任务快照：
  - `task:{taskId}:state`
  - `task:{taskId}:steps`
  - `task:{taskId}:artifacts`

### 验收点
- 同一 `taskId` 在两端均能实时看到一致状态。

## 2.3 `frontend` 改造

### 文件与职责
- `src/lib/realtime/socket.ts`
  - 增加任务频道的 join/on 监听封装：
    - `joinTask(taskId)`
    - `onTaskState/onTaskStep/onTaskArtifact/onTaskError`

- `src/app/page.tsx`
  - 把当前本地“假任务步骤推进”替换为：
    - 调 `workflow/start`
    - 订阅任务事件更新 `TaskPanel`
  - 保留现有聊天 UI，不改交互习惯。

- `src/components/TaskPanel.tsx`
  - 支持显示步骤级状态和错误信息。

### 验收点
- 任务面板内容由后端事件驱动，而不是本地 setTimeout 模拟。
- 任务完成后展示文档链接按钮。

## 3. 开发顺序（建议）

1. `agent-service`：先完成 workflow start + 内部编排（可先不接 WS）。
2. `realtime-server`：补 task channel 广播。
3. `frontend`：接任务订阅，替换本地模拟任务。
4. 联调：桌面/移动双端 + IM 实际回传。

## 4. 测试清单

## 4.1 单元测试（agent-service）
- 状态机从 `start` 到 `completed` 的状态迁移。
- `CreateDoc` 成功后 artifact 入库。
- `SendDeliveryMessage` 权限错误映射为 `task.error`。

## 4.2 集成测试
- 输入指令触发 workflow，返回 taskId。
- 任务事件顺序正确：`state -> step -> artifact -> state(completed)`。
- `dryRun=true` 与 `dryRun=false` 两条链路都可执行。

## 4.3 演示测试
- 同时开桌面与移动页面，触发同一任务并观察同步。
- 飞书群里收到交付消息，包含文档链接。

## 5. 风险与回滚

- 风险：CLI 参数差异导致命令失败。
  - 处理：新增能力探测缓存与错误提示。
- 风险：IM 权限不稳定。
  - 处理：优先用 bot 自建群演示，规避外部群策略。
- 风险：多端状态不一致。
  - 处理：前端以 `task event` 为唯一真相，禁止本地推断推进。
