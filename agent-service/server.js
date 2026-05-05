const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const { parseIntent } = require("./src/intentParser");
const { analyzeIntent } = require("./src/intentAgent");
const { planWorkflow } = require("./src/plannerAgent");
const {
  buildDocsCreateArgs,
  buildDocsUpdateArgs,
  buildImMessagesListArgs,
  buildImMessagesSendArgs,
  buildSlidesCreateArgs,
  buildSlidesXmlPresentationsGetArgs,
  buildSlidesXmlPresentationSlideDeleteArgs,
} = require("./src/larkCliCommands");
const { runLarkCli, tryParseJson } = require("./src/larkCliRunner");
const { TaskStore } = require("./src/taskStore");
const { AgentOrchestrator } = require("./src/orchestrator");
const { publishFeedbackEvent, buildUserRatingFeedback } = require("./src/feedback");
const { record: recordWorkflowFeedback, listRecent: listWorkflowFeedbackRecent } = require("./src/feedbackStore");
const { buildContextFromLines } = require("./src/contextPipeline");

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
    t.startsWith("已收到指令，任务已开始") ||
    t.startsWith("已收到指令，任务已启动：") ||
    t.startsWith("已生成NOTE：") ||
    t.startsWith("任务已完成，文档链接：") ||
    t.startsWith("任务已完成，文档已创建") ||
    t.startsWith("任务已完成，演示稿链接：") ||
    t.startsWith("同步到飞书失败：")
  );
}

function shouldStartWorkflowFromMessage(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  // Hard gate: only start workflow when user clearly asks for a deliverable.
  // This prevents “every message triggers a task”.
  return (
    /(生成|输出|整理成|写成|形成)\S{0,10}(文档|需求文档|PRD|纪要|会议纪要|方案|技术方案|报告|周报|月报|总结)/.test(t) ||
    /(生成|输出|整理成|写成|做成)\S{0,10}(PPT|演示稿|幻灯片|slides|deck)/i.test(t) ||
    /\b(docx|slides)\/[A-Za-z0-9]+/.test(t)
  );
}

function isNoisyContextLine(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (looksLikeBotAck(t)) return true;
  // Filter delivery links and other auto-generated artifacts from context.
  if (/https?:\/\/[^\s]+\/slides\/[A-Za-z0-9]+/i.test(t)) return true;
  if (/https?:\/\/[^\s]+\/docx\/[A-Za-z0-9]+/i.test(t)) return true;
  if (t.includes("规划产物（预览）")) return true;
  return false;
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
      if (text && !isNoisyContextLine(text)) {
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
  // De-duplicate identical lines while preserving order.
  const seenText = new Set();
  const uniq = [];
  for (const x of out) {
    const t = String(x.text || "").trim();
    if (!t) continue;
    if (seenText.has(t)) continue;
    seenText.add(t);
    uniq.push(t);
  }
  return uniq;
}

function summarizeContext(textLines) {
  const raw = Array.isArray(textLines) ? textLines : [];
  const lines = raw
    .map((s) => String(s).trim())
    .filter(Boolean)
    .filter((s) => !isNoisyContextLine(s));
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

async function publishConversationEvent(event) {
  const realtimeUrl = env(
    "REALTIME_CONVERSATION_PUBLISH_URL",
    "http://localhost:3003/api/conversation-events",
  );
  try {
    await fetch(realtimeUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(event),
    });
  } catch {
    // 会话事件不可用时不阻断主流程。
  }
}

const taskStore = new TaskStore();
const orchestrator = new AgentOrchestrator({
  parseIntent,
  planWorkflow,
  buildDocsCreateArgs,
  buildDocsUpdateArgs,
  buildSlidesCreateArgs,
  buildSlidesXmlPresentationsGetArgs,
  buildSlidesXmlPresentationSlideDeleteArgs,
  buildImMessagesSendArgs,
  runLarkCli,
  tryParseJson,
  taskStore,
  publishTaskEvent,
  publishFeedbackEvent,
});

function buildIntentMetaFromAnalyze(resolved) {
  if (!resolved || typeof resolved !== "object") return null;
  const v2 = resolved.parseIntentV2 && typeof resolved.parseIntentV2 === "object" ? resolved.parseIntentV2 : {};
  return {
    source: typeof resolved.source === "string" ? resolved.source : "",
    decisionPath: typeof resolved.decisionPath === "string" ? resolved.decisionPath : "",
    confidence: typeof resolved?.intent?.confidence === "number" ? resolved.intent.confidence : 0,
    thresholds: resolved.thresholds && typeof resolved.thresholds === "object" ? resolved.thresholds : null,
    output_type: typeof v2.output_type === "string" ? v2.output_type : "",
    doc_type: typeof v2.doc_type === "string" ? v2.doc_type : "",
    ppt_type: typeof v2.ppt_type === "string" ? v2.ppt_type : "",
    scenario: typeof v2.scenario === "string" ? v2.scenario : "",
  };
}

async function fetchRecentImContext({ chatId, identities, limit }) {
  const safeChatId = typeof chatId === "string" ? chatId.trim() : "";
  const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20;
  const tries = Array.isArray(identities) && identities.length > 0 ? identities : ["bot", "user"];
  let lastError = "";
  const tryOnce = async ({ as, omitAsFlag }) => {
    const listArgs = omitAsFlag
      ? ["im", "+chat-messages-list", "--chat-id", safeChatId, "--page-size", String(safeLimit), "--format", "json"]
      : buildImMessagesListArgs({ as, chatId: safeChatId, limit: safeLimit });
    const listResp = await runLarkCli(listArgs, { timeoutMs: 30_000 });
    const parsed = tryParseJson(listResp.stdout);
    if (!parsed.ok) throw new Error("messages-list returned non-json");
    const lines = extractImTextLines(parsed.value);
    return { ok: true, as, lines, omitAsFlag: Boolean(omitAsFlag) };
  };

  for (const as of tries) {
    try {
      return await tryOnce({ as, omitAsFlag: false });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;
      // Compatibility: some lark-cli versions don't support `--as` for shortcut commands.
      if (String(msg).toLowerCase().includes("unknown flag: --as")) {
        try {
          return await tryOnce({ as, omitAsFlag: true });
        } catch (e2) {
          lastError = e2 && e2.message ? e2.message : String(e2);
        }
      }
    }
  }
  return { ok: false, as: tries[0] || "bot", lines: [], error: lastError, omitAsFlag: false };
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
      if (!shouldStartWorkflowFromMessage(text)) return;

      const defaultIdentity = env("FEISHU_DEFAULT_IDENTITY", "bot");
      const dryRun = env("FEISHU_DRY_RUN", env("WORKFLOW_DRY_RUN", "true")) !== "false";

      // Pull recent context (best effort). If it fails, still run with raw input.
      let contextBlock = "";
      let contextSummary = "";
      let recentMessages = [];
      try {
        const listArgs = buildImMessagesListArgs({ as: defaultIdentity, chatId, limit: 20 });
        const listResp = await runLarkCli(listArgs, { timeoutMs: 30_000 });
        const parsed = tryParseJson(listResp.stdout);
        if (parsed.ok) {
          const lines = extractImTextLines(parsed.value);
          const bundle = buildContextFromLines(lines, text);
          recentMessages = bundle.topMessages;
          contextSummary = bundle.structuredContext;
          contextBlock = `\n\n${bundle.structuredContext}\n`;
        }
      } catch {
        // ignore
      }

      const intent = await analyzeIntent({
        text,
        contextSummary,
        recentMessages,
        structuredContext: contextSummary,
      });
      const threshold = Number(intent?.thresholds?.slow ?? 0.6);
      const confident = intent?.intent?.name !== "unknown" && (intent?.intent?.confidence ?? 0) >= threshold;
      if (!confident) return;

      const taskId = getId("task");

      // Send an immediate ack back to chat (best effort).
      try {
        const ackArgs = buildImMessagesSendArgs({
          as: defaultIdentity,
          chatId,
          text: "已收到指令，任务已开始",
          dryRun,
        });
        await runLarkCli(ackArgs, { timeoutMs: 30_000 });
      } catch {
        // ignore
      }

      try {
        const task = await orchestrator.startWorkflow({
          taskId,
          conversationId: chatId,
          input: `${text}${contextBlock}`,
          contextSummary,
          recentMessages,
          contextRange: { mode: "recent_messages", limit: 20 },
          targetArtifacts: Array.isArray(intent?.slots?.targetArtifacts) ? intent.slots.targetArtifacts : ["doc"],
          delivery: { channel: "im_chat", chatId },
          execution: { dryRun, defaultIdentity, docIdentity: "user", slidesIdentity: "user" },
          intentMeta: buildIntentMetaFromAnalyze(intent),
        });
        void publishConversationEvent({
          eventType: "conversation.task_active",
          conversationId: task?.conversationId || chatId,
          taskId: task?.taskId || taskId,
          state: task?.state || "detecting",
          at: Date.now(),
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

app.post("/api/agent/parse-intent", async (req, res) => {
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

    const contextSummary = typeof body.contextSummary === "string" ? body.contextSummary.trim() : "";
    const recentMessages = Array.isArray(body.recentMessages) ? body.recentMessages : [];
    const resolved = await analyzeIntent({
      text: input,
      contextSummary,
      recentMessages,
      structuredContext: contextSummary,
    });
    const result = resolved?.parseIntentV2 || parseIntent(input, { contextSummary, recentMessages });

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
      source: resolved?.source || "rule",
      decisionPath: resolved?.decisionPath || "fast",
      thresholds: resolved?.thresholds || { fast: 0.8, slow: 0.6 },
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
    let recentMessages = Array.isArray(body.recentMessages) ? body.recentMessages : [];
    let enrichedInput = input;
    let contextDebug = { enriched: false, usedChatId: "", usedIdentity: "", lines: 0, topK: 0, error: "" };
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
          const bundle = buildContextFromLines(ctx.lines, input);
          recentMessages = bundle.topMessages;
          contextDebug.topK = bundle.topK;
          if (!contextSummary) contextSummary = bundle.structuredContext;
          const contextBlock = `\n\n${bundle.structuredContext}\n`;
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
    const explicitArtifacts = Array.isArray(body.targetArtifacts) ? body.targetArtifacts : null;
    const resolvedIntent = explicitArtifacts
      ? null
      : await analyzeIntent({
          text: input,
          contextSummary,
          recentMessages,
          structuredContext: contextSummary,
        });
    const inferredArtifacts = Array.isArray(resolvedIntent?.slots?.targetArtifacts)
      ? resolvedIntent.slots.targetArtifacts
      : resolvedIntent?.parseIntentV2?.output_type === "ppt"
        ? ["slides"]
        : ["doc"];
    const task = await orchestrator.startWorkflow({
      taskId,
      conversationId,
      input: enrichedInput,
      contextSummary,
      recentMessages,
      contextRange,
      targetArtifacts: explicitArtifacts || inferredArtifacts,
      delivery,
      execution,
      intentMeta: buildIntentMetaFromAnalyze(resolvedIntent),
    });

    void publishConversationEvent({
      eventType: "conversation.task_active",
      conversationId: task.conversationId,
      taskId: task.taskId,
      state: task.state,
      at: Date.now(),
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
      intentDebug: resolvedIntent
        ? {
            source: resolvedIntent.source,
            decisionPath: resolvedIntent.decisionPath,
            confidence: resolvedIntent.intent?.confidence ?? 0,
            thresholds: resolvedIntent.thresholds || { fast: 0.8, slow: 0.6 },
          }
        : null,
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
    const recentMessages = Array.isArray(body.recentMessages) ? body.recentMessages : [];
    const explicitArtifacts = Array.isArray(body.targetArtifacts) ? body.targetArtifacts : null;
    const resolvedIntent = await analyzeIntent({ text: input, contextSummary, recentMessages });
    const targetArtifacts = explicitArtifacts || (Array.isArray(resolvedIntent?.slots?.targetArtifacts) ? resolvedIntent.slots.targetArtifacts : ["doc"]);
    const execution = body.execution && typeof body.execution === "object" ? body.execution : { dryRun: true, defaultIdentity: "bot" };

    const taskId = getId("taskplan");
    const intent = resolvedIntent?.parseIntentV2 || parseIntent(input, { contextSummary, recentMessages });
    const plan = await planWorkflow({ text: input, contextSummary, intent, targetArtifacts, execution });

    res.json({
      ok: true,
      taskId,
      plan: {
        planVersion: plan.planVersion,
        risks: plan.risks || { needsConfirm: false, reason: "" },
        steps: Array.isArray(plan.steps) ? plan.steps.map((s) => ({ stepId: s.stepId, label: s.label, status: s.status || "pending" })) : [],
      },
      intentDebug: {
        source: resolvedIntent?.source || "rule",
        decisionPath: resolvedIntent?.decisionPath || "fast",
        confidence: resolvedIntent?.intent?.confidence ?? 0,
        thresholds: resolvedIntent?.thresholds || { fast: 0.8, slow: 0.6 },
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
  void publishTaskEvent({
    eventType: "task.confirm_resolved",
    taskId,
    stepId,
    approved,
    at: Date.now(),
  });
  res.json({ ok: true, taskId, stepId, accepted: approved });
});

app.post("/api/agent/feedback/rating", async (req, res) => {
  try {
    const body = req.body || {};
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const ratingRaw = typeof body.rating === "string" ? body.rating.trim() : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    if (ratingRaw !== "up" && ratingRaw !== "down") {
      res.status(400).json({ ok: false, error: "rating must be 'up' or 'down'" });
      return;
    }
    const event = buildUserRatingFeedback({
      taskId,
      conversationId,
      artifactId: typeof body.artifactId === "string" ? body.artifactId : "",
      rating: ratingRaw,
      note: typeof body.note === "string" ? body.note : "",
      tags: Array.isArray(body.tags) ? body.tags : [],
    });
    void publishFeedbackEvent(event);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
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
  void publishTaskEvent({
    eventType: "task.confirm_resolved",
    taskId,
    stepId: "",
    approved: false,
    at: Date.now(),
  });
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
app.post("/api/agent/workflow/feedback", (req, res) => {
  const body = req.body || {};
  const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
  const rating = body.rating === "up" || body.rating === "down" ? body.rating : "";
  if (!taskId || !rating) {
    res.status(400).json({ ok: false, error: "taskId and rating (up|down) are required" });
    return;
  }
  recordWorkflowFeedback({
    taskId,
    rating,
    comment: typeof body.comment === "string" ? body.comment : "",
    at: Date.now(),
  });
  res.json({ ok: true, taskId, rating });
});

app.get("/api/agent/workflow/feedback/recent", (req, res) => {
  const lim = req.query && req.query.limit != null ? Number(req.query.limit) : 20;
  res.json({ ok: true, items: listWorkflowFeedbackRecent(lim) });
});

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

