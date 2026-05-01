# 基于 IM 的办公协同助手（Agent-Pilot）

这是一套“从 IM 对话到文档 / 演示稿”的自动化工作流示例工程：用户在 IM 里一句话发起任务，系统会完成意图识别、生成内容、创建飞书文档或演示稿，并把链接回传到 IM。

本仓库用于飞书官方 AI Coding 比赛命题实现，但 README 面向**外部访客**：你可以快速了解它做什么、代码在哪里、以及项目亮点。

## 它能做什么（用一句话讲清楚）
- **把讨论变成可交付产物**：从 IM 输入 -> 生成结构化文档 / 演示稿 -> 回 IM 交付链接。
- **跨端一致的任务面板体验**：任务有明确状态与步骤，可回放、可中断、可观察。

## 系统亮点（为什么值得看）
- **可切换的 LLM 接入**：统一走 OpenAI-like `chat/completions`，可在豆包 / DeepSeek 之间切换（避免被单一供应商限流卡死）。
- **质量门禁 + fail-fast**：文档和 PPT 都会先产出“结构化计划”，再渲染成最终产物；质量不达标直接失败，避免把低质量内容写进文档造成“信息污染”。\n+- **工具统一走 CLI 适配层**：所有飞书能力通过 `lark-cli` 调用，便于做 dry-run、错误归一化与兼容处理（尤其是 Windows 大内容/转义问题）。\n+- **事件驱动的工作流**：REST + 事件流（WebSocket）让前端只需订阅任务事件就能渲染进度，不需要猜状态。

## 代码结构（从哪里开始看）
- `agent-service/`：后端工作流与内容生成\n+  - `src/orchestrator.js`：任务编排与执行（状态机、步骤、产物回传）\n+  - `src/contentAgent.js`：内容生成（文档重写、PPT 页计划、质量门禁）\n+  - `src/intentAgent.js` / `src/intentParser.js`：意图识别（规则优先 + LLM 辅助）\n+  - `src/llmChat.js`：统一 LLM 调用（Provider 可切换、重试、超时）\n+  - `src/larkCliCommands.js`：飞书 CLI 命令构建（文档 / 演示稿 / IM）\n+- `frontend/`：任务面板与演示界面（Next.js）\n+- 根目录文档：产品/架构/契约/演示脚本（见下方“文档导航”）

## 快速开始（本地跑起来）
> 不要把真实密钥写进仓库；`.env` 已被 `.gitignore` 忽略。

### 启动后端（agent-service）

```bash
cd agent-service
npm install
npm start
```

### 启动前端（frontend）

```bash
cd frontend
npm install
npm run dev
```

## 配置（LLM 与超时）
LLM 采用 OpenAI-like `chat/completions`。\n+建议使用环境变量切换 Provider（示例，不要提交真实 key）：

```env
LLM_PROVIDER=deepseek
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=***请在本地设置***

CONTENT_TIMEOUT_MS=30000
DOC_REWRITE_TIMEOUT_MS=30000
PPT_REWRITE_TIMEOUT_MS=30000
```

## 文档导航（想深入再看这些）
按“从需求到落地”的顺序推荐：

1. `request.md`：比赛命题原文（验收标准来源）\n+2. `IM_Agent_Prd.md`：产品需求（为什么做）\n+3. `IM_Agent_System_Architecture.md`：架构说明（怎么搭）\n+4. `IM_Agent_Workflow_Contracts.md`：接口 / 事件契约（怎么联）\n+5. `IM_Agent_Phase1_Implementation.md`：最小闭环改造清单（先做什么）\n+6. `IM_Agent_Demo_Script.md`：演示脚本（怎么讲）

## 开发约定（给协作与复现用）
- **文档命名**：根目录文档前缀统一 `IM_Agent_`。\n+- **只保留“权威来源”**：同一层级只保留一个权威文档，其他文档只做补充。\n+- **可观测性优先**：任务步骤与产物都要能回放，便于演示与排障。
