const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const { parseIntentStub } = require("./src/intentParser");
const { analyzeIntent } = require("./src/intentAgent");
const { planWorkflow } = require("./src/plannerAgent");
const { buildDocsCreateArgs, buildDocsUpdateArgs, buildImMessagesListArgs, buildImMessagesSendArgs, buildSlidesCreateArgs } = require("./src/larkCliCommands");
const { runLarkCli, tryParseJson } = require("./src/larkCliRunner");
const { TaskStore } = require("./src/taskStore");
const { AgentOrchestrator } = require("./src/orchestrator");

const app = express();

app.use(express.json({ limit: "2mb" }));

function getId(prefix) {
  const anyCrypto = globalThis.crypto;
  if (anyCrypto && typeof anyCrypto.randomUUID === "function") return `${prefix}_${anyCrypto.randomUUID()}`;
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function env(name, fallback) {
  const v = process.env[name];
  if (typeof v === "string" && v.length > 0) return v;
  return fallback;
}

function parseFeishuTextMessageContent(raw) {
  if (typeof raw !== "string") return "";
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.text === "string") return obj.text.trim();
    return raw.trim();
  } catch {
    return raw.trim();
  }
}

function makeDedupe({ ttlMs = 2 * 60_000 } = {}) {
  const seen = new Map();
  function has(key) {
    const v = seen.get(key);
    if (!v) return false;
    if (Date.now() > v) {
      seen.delete(key);
      return false;
    }
    return true;
  }
  function add(key) {
    seen.set(key, Date.now() + ttlMs);
  }
  return { has, add };
}

const feishuDedupe = makeDedupe({ ttlMs: 3 * 60_000 });

function safeString(v) {
  return typeof v === "string" ? v : "";
}

function looksLikeBotAck(text) {
  const t = text.trim();
  if (!t) return false;
  return (
    t.startsWith("已收到指令，任务已启动：") ||
    t.startsWith("任务已完成，文档链接：") ||
    t.startsWith("任务已完成，文档已创建") ||
    t.startsWith("同步到飞书失败：")
  );
}

function extractImTextLines(payload) {
  // Best-effort extraction from lark-cli `im +messages-list --format json` output.
  // Output shapes may vary between cli versions; scan recursively for message-like objects.
  const out = [];
  const seen = new Set();
  const stack = [payload];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }

    const obj = cur;
    const messageType = obj.message_type ?? obj.msg_type ?? obj.type;
    const contentRaw = obj.content;
    if ((messageType === "text" || messageType === "Text") && typeof contentRaw === "string") {
      const text = parseFeishuTextMessageContent(contentRaw);
      if (text && !looksLikeBotAck(text)) {
        const createTimeRaw = obj.create_time ?? obj.createTime ?? obj.ts ?? obj.timestamp;
        const createTime = typeof createTimeRaw === "string" || typeof createTimeRaw === "number" ? Number(createTimeRaw) : NaN;
        out.push({
          text,
          at: Number.isFinite(createTime) ? createTime : 0,
          senderType: safeString(obj.sender_type ?? obj.senderType ?? ""),
        });
      }
    }

    for (const v of Object.values(obj)) stack.push(v);
  }

  // Sort by time ascending (best-effort); keep stable if no timestamps.
  out.sort((a, b) => (a.at || 0) - (b.at || 0));
  return out.map((x) => x.text);
}

function summarizeContext(textLines) {
  const lines = Array.isArray(textLines) ? textLines.map((s) => String(s).trim()).filter(Boolean) : [];
  const recent = lines.slice(-12);
  const picked = recent.slice(-8);

  const decision = picked.filter((l) => /决定|结论|定了|就这么办|OK|同意|通过/.test(l));
  const questions = picked.filter((l) => /吗\??$|？$|是否|要不要|能不能|怎么|为什么/.test(l));
  const actions = picked.filter((l) => /TODO|待办|下一步|行动|安排|需要|请/.test(l));

  const bullets = (arr, max) =>
    arr
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, max)
      .map((s) => `- ${s}`)
      .join("\n");

  const parts = [];
  parts.push("## 上下文摘要");
  parts.push("### 关键要点");
  parts.push(bullets(picked, 8) || "- （暂无）");
  parts.push("\n### 决策/结论");
  parts.push(bullets(decision, 5) || "- （暂无明确结论）");
  parts.push("\n### 待确认问题");
  parts.push(bullets(questions, 5) || "- （暂无）");
  parts.push("\n### 行动项");
  parts.push(bullets(actions, 5) || "- （暂无）");
  return parts.join("\n");
}

function decideTargetArtifactsFromText(text) {
  const t = String(text || "").trim();
  const wantsPpt = /ppt|PPT|演示稿|汇报/.test(t);
  const hasDocLink = /https?:\/\/[^\s]+\/docx\/[A-Za-z0-9]+/.test(t);
  const explicitlyWantsDoc = /需求文档|生成文档|先写文档|整理成文档|写个文档/.test(t);
  const basedOnDoc = /根据文档|基于文档|用文档生成|用需求文档生成/.test(t) || hasDocLink;

  // Default: if user asks for PPT via natural language, generate Slides only.
  // Only generate Doc+Slides when user explicitly asks for a doc (no doc link provided).
  if (wantsPpt) {
    if (basedOnDoc) return ["slides"];
    if (explicitlyWantsDoc) return ["doc", "slides"];
    return ["slides"];
  }

  return ["doc"];
}

function shouldTriggerWorkflowFromText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  // Trigger only on explicit work keywords; ignore casual chat.
  return (
    /需求文档|prd|整理|梳理|总结|汇总|提炼|需求|会议纪要|行动项|待办/.test(t) ||
    /ppt|PPT|演示稿|汇报/.test(t) ||
    /https?:\/\/[^\s]+\/docx\/[A-Za-z0-9]+/.test(t)
  );
}

async function publishTaskEvent(event) {
  const realtimeUrl = env("REALTIME_PUBLISH_URL", "http://localhost:3003/api/task-events");
  try {
    await fetch(realtimeUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(event),
    });
  } catch {
    // Realtime 服务不可用时不阻断主流程，前端可回退轮询状态接口。
  }
}

const taskStore = new TaskStore();
const orchestrator = new AgentOrchestrator({
  parseIntentStub,
  planWorkflow,
  buildDocsCreateArgs,
  buildDocsUpdateArgs,
  buildSlidesCreateArgs,
  buildImMessagesSendArgs,
  runLarkCli,
  tryParseJson,
  taskStore,
  publishTaskEvent,
});

async function fetchRecentImContext({ chatId, identities, limit }) {
  const safeChatId = typeof chatId === "string" ? chatId.trim() : "";
  const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20;
  const tries = Array.isArray(identities) && identities.length > 0 ? identities : ["bot", "user"];
  let lastError = "";
  for (const as of tries) {
    try {
      const listArgs = buildImMessagesListArgs({ as, chatId: safeChatId, limit: safeLimit });
      const listResp = await runLarkCli(listArgs, { timeoutMs: 30_000 });
      const parsed = tryParseJson(listResp.stdout);
      if (!parsed.ok) throw new Error("messages-list returned non-json");
      const lines = extractImTextLines(parsed.value);
      const summary = summarizeContext(lines);
      return { ok: true, as, lines, summary };
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }
  return { ok: false, as: tries[0] || "bot", lines: [], summary: "", error: lastError };
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/feishu/events", (req, res) => {
  const body = req.body || {};

  // 1) URL Verification (challenge)
  if (body && body.type === "url_verification" && typeof body.challenge === "string") {
    res.json({ challenge: body.challenge });
    return;
  }

  // 2) Token verification (Feishu schema 2.0 uses header.token)
  const expectedToken = env("FEISHU_VERIFICATION_TOKEN", "");
  const tokenFromHeader = body?.header?.token;
  const tokenFromRoot = body?.token;
  const actualToken = typeof tokenFromHeader === "string" ? tokenFromHeader : typeof tokenFromRoot === "string" ? tokenFromRoot : "";
  if (!expectedToken) {
    res.status(500).json({ ok: false, error: "FEISHU_VERIFICATION_TOKEN is not set" });
    return;
  }
  if (!actualToken || actualToken !== expectedToken) {
    res.status(401).json({ ok: false, error: "invalid token" });
    return;
  }

  // Ack fast; run heavy work async.
  res.json({ ok: true });

  void (async () => {
    try {
      const eventType = body?.header?.event_type;
      if (eventType !== "im.message.receive_v1") return;

      const message = body?.event?.message;
      const chatId = message?.chat_id;
      const messageId = message?.message_id;
      const messageType = message?.message_type;
      const contentRaw = message?.content;
      const senderType = body?.event?.sender?.sender_type;
      if (typeof chatId !== "string" || !chatId.trim()) return;
      if (typeof messageId !== "string" || !messageId.trim()) return;
      if (feishuDedupe.has(messageId)) return;
      feishuDedupe.add(messageId);

      // Avoid self-triggering loops: only process user messages.
      if (senderType !== "user") return;

      // Only handle text for Phase 1.
      if (messageType !== "text") return;
      const text = parseFeishuTextMessageContent(contentRaw);
      if (!text) return;
      if (looksLikeBotAck(text)) return;

      const defaultIdentity = env("FEISHU_DEFAULT_IDENTITY", "bot");
      const dryRun = env("FEISHU_DRY_RUN", env("WORKFLOW_DRY_RUN", "true")) !== "false";

      // Pull recent context (best effort). If it fails, still run with raw input.
      let contextBlock = "";
      let contextSummary = "";
      try {
        const listArgs = buildImMessagesListArgs({ as: defaultIdentity, chatId, limit: 20 });
        const listResp = await runLarkCli(listArgs, { timeoutMs: 30_000 });
        const parsed = tryParseJson(listResp.stdout);
        if (parsed.ok) {
          const lines = extractImTextLines(parsed.value);
          const summary = summarizeContext(lines);
          contextSummary = summary;
          const quotes = lines
            .slice(-6)
            .map((l) => `> ${String(l).replace(/\r?\n/g, " ").trim()}`)
            .join("\n");
          contextBlock = `\n\n${summary}\n\n## 关键原文引用（最近6条）\n${quotes || "> （暂无）"}\n`;
        }
      } catch {
        // ignore
      }

      const intent = await analyzeIntent({ text, contextSummary });
      const threshold = Number(intent?.threshold ?? 0.65);
      const confident = intent?.intent?.name !== "unknown" && (intent?.intent?.confidence ?? 0) >= threshold;
      if (!confident) return;

      const taskId = getId("task");

      // Send an immediate ack back to chat (best effort).
      try {
        const ackArgs = buildImMessagesSendArgs({
          as: defaultIdentity,
          chatId,
          text: `已收到指令，任务已启动：${taskId}`,
          dryRun,
        });
        await runLarkCli(ackArgs, { timeoutMs: 30_000 });
      } catch {
        // ignore
      }

      try {
        await orchestrator.startWorkflow({
          taskId,
          conversationId: chatId,
          input: `${text}${contextBlock}`,
          contextSummary,
          contextRange: { mode: "recent_messages", limit: 20 },
          targetArtifacts: Array.isArray(intent?.slots?.targetArtifacts) ? intent.slots.targetArtifacts : decideTargetArtifactsFromText(text),
          delivery: { channel: "im_chat", chatId },
          execution: { dryRun, defaultIdentity, docIdentity: "user", slidesIdentity: "user" },
        });
      } catch (e) {
        // If orchestration fails fast, report to IM for easier debugging.
        try {
          const msg = e && e.message ? e.message : String(e);
          const errArgs = buildImMessagesSendArgs({
            as: defaultIdentity,
            chatId,
            text: `任务启动失败：${msg}`,
            dryRun,
          });
          await runLarkCli(errArgs, { timeoutMs: 30_000 });
        } catch {
          // ignore
        }
      }
    } catch {
      // Swallow: webhook should not crash agent-service.
    }
  })();
});

app.post("/api/agent/parse-intent", (req, res) => {
  try {
    const body = req.body || {};
    const inputRaw =
      typeof body.input === "string" ? body.input : typeof body.message === "string" ? body.message : "";
    const input = String(inputRaw).trim();
    if (!input) {
      res.status(400).json({ error: "input is required" });
      return;
    }

    const conversationId = body.conversationId ? String(body.conversationId) : "demo_conversation";
    const taskId = getId("task");
    const now = Date.now();
    const version = 1;

    // 仅模拟 task 进度；后续替换真实 Planner/LLM 流程即可保持契约不变
    const events = [
      {
        eventType: "TaskStateEvent",
        taskId,
        state: "detecting",
        stepProgress: { label: "开始识别意图" },
        at: now,
        version,
      },
      {
        eventType: "TaskStateEvent",
        taskId,
        state: "intent",
        stepProgress: { label: "LLM解析意图（stub）" },
        at: now + 10,
        version,
      },
      {
        eventType: "TaskStateEvent",
        taskId,
        state: "executing",
        stepProgress: { label: "生成结构化结果" },
        at: now + 20,
        version,
      },
      {
        eventType: "TaskStateEvent",
        taskId,
        state: "completed",
        stepProgress: { label: "意图解析完成" },
        at: Date.now(),
        version,
      },
    ];

    const result = parseIntentStub({ input });

    res.json({
      task: {
        taskId,
        taskKind: "intent_parse",
        conversationId,
        state: "completed",
        version,
      },
      events,
      result,
    });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/agent/workflow/start", async (req, res) => {
  try {
    const body = req.body || {};
    const input = typeof body.input === "string" ? body.input.trim() : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    if (!input) {
      res.status(400).json({ ok: false, error: "input is required" });
      return;
    }
    if (!conversationId) {
      res.status(400).json({ ok: false, error: "conversationId is required" });
      return;
    }

    // Best-effort: enrich input with recent IM messages when requested.
    // This fixes "plan nodes show 暂无" when user input is short but chat has rich context.
    const contextRange = body.contextRange || { mode: "recent_messages", limit: 20 };
    const execution = body.execution || { dryRun: true, defaultIdentity: "user" };
    const delivery = body.delivery || { channel: "im_chat", chatId: "" };
    let contextSummary = typeof body.contextSummary === "string" ? body.contextSummary.trim() : "";
    let enrichedInput = input;
    let contextDebug = { enriched: false, usedChatId: "", usedIdentity: "", lines: 0, error: "" };
    try {
      const mode = typeof contextRange?.mode === "string" ? contextRange.mode : "";
      const wantsRecent = mode === "recent_messages";
      const bodyChatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
      const chatId =
        (typeof delivery?.chatId === "string" && delivery.chatId.trim() ? delivery.chatId.trim() : "") ||
        bodyChatId ||
        conversationId;
      const limitRaw = contextRange?.limit;
      const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;
      const preferred = execution?.defaultIdentity === "user" || execution?.defaultIdentity === "bot" ? execution.defaultIdentity : null;
      const identities = preferred ? [preferred, preferred === "bot" ? "user" : "bot"] : ["bot", "user"];
      if (wantsRecent && chatId) {
        const ctx = await fetchRecentImContext({ chatId, identities, limit });
        contextDebug.usedChatId = chatId;
        contextDebug.usedIdentity = ctx.as;
        contextDebug.lines = Array.isArray(ctx.lines) ? ctx.lines.length : 0;
        contextDebug.error = ctx.ok ? "" : ctx.error || "";
        if (ctx.ok && ctx.lines.length > 0) {
          const summary = ctx.summary;
          if (!contextSummary) contextSummary = summary;
          const quotes = ctx.lines
            .slice(-6)
            .map((l) => `> ${String(l).replace(/\r?\n/g, " ").trim()}`)
            .join("\n");
          const contextBlock = `\n\n${summary}\n\n## 关键原文引用（最近6条）\n${quotes || "> （暂无）"}\n`;
          enrichedInput = `${input}${contextBlock}`;
          contextDebug.enriched = true;
        }
      } else if (wantsRecent && !chatId) {
        contextDebug.error = "missing chatId for recent_messages";
      }
    } catch {
      // ignore enrichment errors
    }

    const taskId = getId("task");
    const task = await orchestrator.startWorkflow({
      taskId,
      conversationId,
      input: enrichedInput,
      contextSummary,
      contextRange,
      targetArtifacts: Array.isArray(body.targetArtifacts) ? body.targetArtifacts : ["doc"],
      delivery,
      execution,
    });

    res.json({
      ok: true,
      task: {
        taskId: task.taskId,
        conversationId: task.conversationId,
        state: task.state,
      },
      subscribe: { channel: `task:${task.taskId}` },
      contextDebug,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

// Scenario B: plan only (no execution), for independent demo.
app.post("/api/agent/workflow/plan", async (req, res) => {
  try {
    const body = req.body || {};
    const input = typeof body.input === "string" ? body.input.trim() : "";
    if (!input) {
      res.status(400).json({ ok: false, error: "input is required" });
      return;
    }
    const contextSummary = typeof body.contextSummary === "string" ? body.contextSummary.trim() : "";
    const targetArtifacts = Array.isArray(body.targetArtifacts) ? body.targetArtifacts : ["doc"];
    const execution = body.execution && typeof body.execution === "object" ? body.execution : { dryRun: true, defaultIdentity: "bot" };

    const taskId = getId("taskplan");
    const intent = parseIntentStub({ input });
    const plan = await planWorkflow({ text: input, contextSummary, intent, targetArtifacts, execution });

    res.json({
      ok: true,
      taskId,
      plan: {
        planVersion: plan.planVersion,
        risks: plan.risks || { needsConfirm: false, reason: "" },
        steps: Array.isArray(plan.steps) ? plan.steps.map((s) => ({ stepId: s.stepId, label: s.label, status: s.status || "pending" })) : [],
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/agent/workflow/confirm", (req, res) => {
  const body = req.body || {};
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const stepId = typeof body.stepId === "string" ? body.stepId : "";
  const approved = body.approved === true;
  if (!taskId || !stepId) {
    res.status(400).json({ ok: false, error: "taskId and stepId are required" });
    return;
  }
  const override = body.override && typeof body.override === "object" ? body.override : null;
  // Idempotent-ish: if waiter already resolved, return accepted anyway.
  taskStore.resolveConfirm(taskId, stepId, approved, override);
  res.json({ ok: true, taskId, stepId, accepted: approved });
});

app.post("/api/agent/workflow/cancel", (req, res) => {
  const body = req.body || {};
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  if (!taskId) {
    res.status(400).json({ ok: false, error: "taskId is required" });
    return;
  }
  const task = taskStore.get(taskId);
  if (!task) {
    res.status(404).json({ ok: false, error: "task not found" });
    return;
  }
  taskStore.cancel(taskId);
  taskStore.update(taskId, { state: "cancelled", currentStepId: null });
  void publishTaskEvent({ eventType: "task.state", taskId, state: "cancelled", at: Date.now() });
  res.json({ ok: true, taskId });
});

app.get("/api/agent/workflow/:taskId", (req, res) => {
  const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
  const task = taskStore.get(taskId);
  if (!task) {
    res.status(404).json({ ok: false, error: "task not found" });
    return;
  }
  res.json({
    ok: true,
    task: {
      taskId: task.taskId,
      conversationId: task.conversationId,
      state: task.state,
      currentStepId: task.currentStepId || null,
      steps: task.steps,
    },
    artifacts: task.artifacts,
    error: task.lastError || null,
  });
});

// For Feishu-triggered workflows: allow GUI to discover latest taskId by conversationId(chatId).
app.get("/api/agent/conversation/:conversationId/latest-task", (req, res) => {
  const conversationId = typeof req.params.conversationId === "string" ? req.params.conversationId.trim() : "";
  if (!conversationId) {
    res.status(400).json({ ok: false, error: "conversationId is required" });
    return;
  }
  const taskId = taskStore.getLatestTaskIdByConversationId(conversationId);
  if (!taskId) {
    res.json({ ok: true, found: false, conversationId, taskId: "" });
    return;
  }
  const task = taskStore.get(taskId);
  res.json({
    ok: true,
    found: true,
    conversationId,
    taskId,
    state: task?.state || "unknown",
    updatedAt: task?.updatedAt || 0,
  });
});

app.post("/api/lark-cli/im/messages-send", async (req, res) => {
  try {
    const body = req.body || {};
    const args = buildImMessagesSendArgs({
      as: body.as,
      chatId: body.chatId,
      text: body.text,
      dryRun: body.dryRun,
    });

    const { stdout } = await runLarkCli(args, { timeoutMs: 30_000 });
    const parsed = tryParseJson(stdout);
    res.json({ ok: true, args, result: parsed.ok ? parsed.value : stdout, parsed: parsed.ok });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/lark-cli/im/messages-list", async (req, res) => {
  try {
    const body = req.body || {};
    const args = buildImMessagesListArgs({
      as: body.as,
      chatId: body.chatId,
      limit: body.limit,
    });

    const { stdout } = await runLarkCli(args, { timeoutMs: 30_000 });
    const parsed = tryParseJson(stdout);
    res.json({ ok: true, args, result: parsed.ok ? parsed.value : stdout, parsed: parsed.ok });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/lark-cli/docs/create", async (req, res) => {
  try {
    const body = req.body || {};
    const args = buildDocsCreateArgs({
      as: body.as,
      title: body.title,
      markdown: body.markdown,
      apiVersion: body.apiVersion,
      dryRun: body.dryRun,
    });

    const { stdout } = await runLarkCli(args, { timeoutMs: 60_000 });
    const parsed = tryParseJson(stdout);
    res.json({ ok: true, args, result: parsed.ok ? parsed.value : stdout, parsed: parsed.ok });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.post("/api/lark-cli/slides/create", async (req, res) => {
  try {
    const body = req.body || {};
    const args = buildSlidesCreateArgs({
      as: body.as,
      title: body.title,
      slidesXmlArray: body.slidesXmlArray,
      dryRun: body.dryRun,
    });

    const { stdout } = await runLarkCli(args, { timeoutMs: 60_000 });
    const parsed = tryParseJson(stdout);
    res.json({ ok: true, args, result: parsed.ok ? parsed.value : stdout, parsed: parsed.ok });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, () => {
  console.log(`agent-service listening on http://localhost:${port}`);
});

