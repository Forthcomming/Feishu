// 最小闭环 Demo 后端：POST /api/tasks/doc 生成 Document，并把生成过程的 TaskStateEvent 推送到前端
// 设计目标：1-2 天内跑通 IM 输入 -> 生成文档 -> 展示结果；LLM 使用可替换的 stub 生成器。
const http = require("http");
const path = require("path");
const fs = require("fs");

const { generateDocument } = require("./docGenerator");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function getId(prefix) {
  // Node 版本不同时 fallback
  const anyCrypto = globalThis.crypto;
  if (anyCrypto && typeof anyCrypto.randomUUID === "function") return `${prefix}_${anyCrypto.randomUUID()}`;
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function serveStatic(res, filePath) {
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".js"
        ? "application/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": mime, "Content-Length": data.length });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/tasks/doc") {
      const body = await readJsonBody(req);
      const userText = String(body.userText || "").trim();
      if (!userText) {
        sendJson(res, 400, { error: "userText is required" });
        return;
      }

      const conversationId = String(body.conversationId || "demo_conversation");
      const taskId = getId("task");
      const docId = getId("doc");

      // TaskStateEvent 最小闭环：detecting/intent/executing 的分段 + completed
      const now = Date.now();
      const version = 1;
      const events = [];

      events.push({
        eventType: "TaskStateEvent",
        taskId,
        state: "detecting",
        stepProgress: { label: "开始识别意图" },
        at: now,
        version,
      });

      // 本 Demo 只实现 document-only 主路径（PRD 最小闭环）
      events.push({
        eventType: "TaskStateEvent",
        taskId,
        state: "intent",
        stepProgress: { label: "识别为生成文档(doc_only)" },
        at: now + 1,
        version,
      });

      events.push({
        eventType: "TaskStateEvent",
        taskId,
        state: "executing",
        stepProgress: { label: "生成摘要" },
        at: now + 2,
        version,
      });

      events.push({
        eventType: "TaskStateEvent",
        taskId,
        state: "executing",
        stepProgress: { label: "提取需求要点" },
        at: now + 3,
        version,
        // 逐步写入事件列表，便于前端展示与 Day2 进度细分
      });

      events.push({
        eventType: "TaskStateEvent",
        taskId,
        state: "executing",
        stepProgress: { label: "生成关键结论" },
        at: now + 4,
        version,
      });

      const document = generateDocument({
        docId,
        conversationId,
        userText,
        documentTemplateId: body.documentTemplateId || undefined,
      });

      events.push({
        eventType: "TaskStateEvent",
        taskId,
        state: "executing",
        stepProgress: { label: "组装文档块并固化结构" },
        at: now + 5,
        version,
      });

      events.push({
        eventType: "TaskStateEvent",
        taskId,
        state: "completed",
        stepProgress: { label: "文档生成完成" },
        at: Date.now(),
        version,
      });

      sendJson(res, 200, {
        task: {
          taskId,
          taskKind: "doc_only",
          conversationId,
          state: "completed",
          version,
        },
        events,
        document,
      });
      return;
    }

    // Static files
    const pathname = url.pathname;
    const safePath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.join(PUBLIC_DIR, safePath);
    serveStatic(res, filePath);
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, () => {
  // 便于本地调试
  console.log(`demo-minimal server listening on http://localhost:${PORT}`);
});

