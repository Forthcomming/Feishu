# 飞书 CLI 调用规则（避免“创建成功但内容为空/乱码/超时”）

> 目标：把这次 Doc/PPT 的踩坑经验沉淀成可复用规则，后续凡是调用 `lark-cli` 的写操作都按此执行。

## 1. 总原则（必须遵守）

- **大内容不要塞命令行参数**：只要内容可能变长（几 KB+）、包含换行/引号/JSON/XML，**禁止**通过 `--content "<...>"`、`--slides "<...>"` 等方式直接放在 argv。
  - **优先级**：`stdin (-)` > `@file` > 纯 argv 小参数。
- **Windows 更严格**：Windows 的命令行长度与转义更容易导致“命令成功但内容没传进去”，必须默认按“大内容处理”。
- **先看 help/schema，再写代码**：同一命令 v1/v2 参数名可能不同（例如 docs 的 `--mode/--markdown` vs `--command/--content`）。每次接入新命令先跑：
  - `lark-cli <domain> <command> --help`
  - `lark-cli schema <domain>.<resource>.<op>`（如适用）

## 2. 身份与可见性（避免权限/看不到/资源归属问题）

- **用户可见的资产（Doc/Slides）默认用 `--as user`**。
  - bot 身份只在“明确需要应用创建/持有资源”时使用。
- 规则落地建议：
  - `execution.docIdentity = "user"`
  - `execution.slidesIdentity = "user"`
  - `execution.defaultIdentity` 可保留 `bot` 用于 IM ack/delivery，但文档/演示稿写入用 user。

## 3. 写入方式规范（按资源类型）

### 3.1 Docs：统一走 v2 + stdin（推荐）

- **创建**：使用 `--api-version v2` 且正文走 `stdin`
  - 形态：`docs +create --doc-format markdown --content -`，正文从标准输入写入
- **更新**：有 docx 链接时走 v2 更新，且正文走 `stdin`
  - 形态：`docs +update --api-version v2 --command append --doc-format markdown --content -`

> 验证点：打开 docx 链接时正文不为空；更新后文档出现“本次更新”块。

### 3.2 Slides：创建与内容写入分离（Windows 推荐）

原因：`slides +create --slides '[\"<slide...>\"...]'` 容易受 Windows argv 长度/转义影响；即使创建成功，也可能内容为空。

推荐流程：

- **第一步：只创建空白演示稿**
  - `slides +create --title ...`（不传 `--slides`）
- **第二步：逐页写入内容（stdin）**
  - `slides xml_presentation.slide create --params '{"xml_presentation_id":"..."}' --data -`
  - `--data` 的 JSON 从 stdin 输入：`{"slide":{"content":"<slide xmlns=...>...</slide>"}}`

> 验证点：打开 slides 链接后至少能看到标题/要点，不应空白。

## 4. 错误处理与可观测性（必须做）

- **超时**：
  - 写操作默认 `timeoutMs >= 120s`（doc/slides），避免大内容时误判失败。
- **编码**（Windows 常见）：
  - stdout/stderr 解码遇到 `�` 时，回退 `cp936/gbk` 解码，避免报错变乱码。
- **失败不静默**：
  - 任何降级（例如 slides 内容写入失败而只建空稿）必须在任务 `artifacts` 里追加 `note`，说明：
    - 发生了什么（降级/重试）
    - 可能原因（参数长度、XML 格式、权限、dry-run）
    - 下一步怎么排查

## 5. 排查顺序（现场最省时间）

1. **确认是不是 dry-run**：dry-run 不会真实写入内容。
2. **确认身份**：Doc/Slides 是否用 `--as user`；bot 是否有权限。
3. **确认写入通道**：大内容是否走了 `stdin (-)` / `@file`，而不是 argv。
4. **对照 help/schema**：参数名是否匹配当前版本。
5. **看原始 stderr**：避免被转义/截断，必要时打印到任务 `note` 或本地日志。

## 6. “最小可用”内容标准（避免生成空产物）

- Doc：至少包含 4 段（摘要/需求/澄清/大纲）。
- Slides：至少 1 页，且页内至少有可见标题文本（`textType="title"`）。

