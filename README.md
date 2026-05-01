# 基于 IM 的办公协同智能助手（文档导航）

本仓库用于飞书官方 AI Coding 比赛命题实现。  
当前文档较多，已按“从需求到落地”的阅读顺序整理如下。

## 先看这三份

1. `request.md`  
   - 比赛命题原文（验收标准来源）
2. `IM_Agent_Prd.md`  
   - 你的产品需求与业务价值定义
3. `IM_Agent_System_Architecture.md`  
   - CLI 融合后的目标架构（当前权威架构文档）

## 工程落地文档（按顺序）

1. `IM_Agent_Workflow_Contracts.md`  
   - API / WS 事件契约（`workflow/start|confirm|status` + task events）
2. `IM_Agent_Phase1_Implementation.md`  
   - Phase 1 最小闭环改造清单（`IM -> Doc -> IM交付`）
3. `IM_Agent_Demo_Script.md`  
   - 比赛演示脚本（A-F 场景映射 + 台词 + 兜底预案）
4. `IM_Agent_Feishu_CLI_Rules.md`
   - 飞书 CLI 调用规则（Windows/大内容/编码/超时/可观测性最佳实践）

## 当前文档角色划分

- `request.md`: 外部输入，不修改语义，仅作为命题依据
- `IM_Agent_Prd.md`: 产品层权威来源（为什么做）
- `IM_Agent_System_Architecture.md`: 架构层权威来源（怎么搭）
- `IM_Agent_Workflow_Contracts.md`: 接口层权威来源（怎么联）
- `IM_Agent_Phase1_Implementation.md`: 实施层清单（先做什么）
- `IM_Agent_Demo_Script.md`: 评审层脚本（怎么讲）

## 推荐阅读路径

### 路径 A：评审/答辩准备（15 分钟）
`request.md` -> `IM_Agent_System_Architecture.md` -> `IM_Agent_Demo_Script.md`

### 路径 B：开发实现（30 分钟）
`IM_Agent_Prd.md` -> `IM_Agent_System_Architecture.md` -> `IM_Agent_Workflow_Contracts.md` -> `IM_Agent_Phase1_Implementation.md`

## 文档维护约定（后续避免再乱）

- 新增文档只放在仓库根目录，前缀统一：`IM_Agent_`
- 不再新增“泛说明”文档，优先更新已有权威文档
- 任何新文档都要在本 `README.md` 登记“用途 + 是否权威”
- 同一层级只保留一个权威文档，其他文档只做补充，不重复定义

## 快速状态

- 已完成：架构重梳理、工作流契约、Phase 1 清单、演示脚本
- 下一步建议：按 `IM_Agent_Phase1_Implementation.md` 开始代码实现
