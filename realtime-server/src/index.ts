import http from "node:http";
import process from "node:process";

import { createClient, type RedisClientType } from "redis";
import { Server } from "socket.io";

type DocId = string;

type Block = {
  id: string;
  type: "title" | "text" | "list";
  content: string;
};

type Task = {
  id: string;
  title: string;
  status: "pending" | "running" | "done";
};

type TasksState = {
  tasks: Task[];
  activeTaskId?: string;
};

type Snapshot = {
  blocks: Block[];
  blocksVersion: number;
  tasksState: TasksState;
  tasksVersion: number;
  serverTs: number;
};

type Device = "desktop" | "mobile";
type PresenceEntry = { socketId: string; device: Device; joinedAt: number };

type TaskStep = {
  stepId: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
};

type TaskArtifact = {
  artifactId: string;
  kind: string;
  title: string;
  url: string;
};

type TaskSnapshot = {
  taskId: string;
  state: string;
  steps: TaskStep[];
  artifacts: TaskArtifact[];
  lastError?: string;
  confirmRequired?: { stepId: string; reason: string } | null;
  updatedAt: number;
};

function env(name: string, fallback?: string) {
  const v = process.env[name];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof fallback === "string") return fallback;
  throw new Error(`Missing env: ${name}`);
}

function envOptional(name: string) {
  const v = process.env[name];
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function blocksKey(docId: DocId) {
  return `doc:${docId}:blocks`;
}
function tasksKey(docId: DocId) {
  return `doc:${docId}:tasks`;
}
function tsKey(docId: DocId) {
  return `doc:${docId}:ts`;
}
function taskKey(taskId: string) {
  return `task:${taskId}:snapshot`;
}
function blocksVersionKey(docId: DocId) {
  return `doc:${docId}:blocks_version`;
}
function tasksVersionKey(docId: DocId) {
  return `doc:${docId}:tasks_version`;
}
function conversationKey(cid: string) {
  return `conversation:${cid}:active`;
}

function safeDocId(raw: unknown): DocId | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

function safeConversationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

function readDevice(raw: unknown): Device {
  if (raw === "mobile") return "mobile";
  return "desktop";
}

async function main() {
  const port = Number(process.env.PORT ?? 3003);
  const redisUrl = envOptional("REDIS_URL");
  const allowOrigin = process.env.ALLOW_ORIGIN ?? "*";

  const memory = new Map<string, string>();
  const presenceByCid = new Map<string, Map<string, { device: Device; joinedAt: number }>>();
  const cidsBySocket = new Map<string, Set<string>>();

  function addPresence(cid: string, socketId: string, device: Device) {
    if (!presenceByCid.has(cid)) presenceByCid.set(cid, new Map());
    presenceByCid.get(cid)!.set(socketId, { device, joinedAt: Date.now() });
    if (!cidsBySocket.has(socketId)) cidsBySocket.set(socketId, new Set());
    cidsBySocket.get(socketId)!.add(cid);
  }

  function removePresence(cid: string, socketId: string) {
    const m = presenceByCid.get(cid);
    if (m) {
      m.delete(socketId);
      if (m.size === 0) presenceByCid.delete(cid);
    }
    const s = cidsBySocket.get(socketId);
    if (s) {
      s.delete(cid);
      if (s.size === 0) cidsBySocket.delete(socketId);
    }
  }

  function listPresence(cid: string): PresenceEntry[] {
    const m = presenceByCid.get(cid);
    if (!m) return [];
    return Array.from(m.entries()).map(([socketId, v]) => ({ socketId, device: v.device, joinedAt: v.joinedAt }));
  }

  const redis: RedisClientType | null = redisUrl ? createClient({ url: redisUrl }) : null;
  if (redis) {
    redis.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[redis] error", err);
    });
    await redis.connect();
  } else {
    // eslint-disable-next-line no-console
    console.warn("[realtime] REDIS_URL not set, falling back to in-memory store (dev only)");
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === "POST" && url === "/api/conversation-events") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}") as {
            eventType?: string;
            conversationId?: string;
            taskId?: string;
            state?: string;
            at?: number;
          };
          const cid = safeConversationId(payload.conversationId);
          if (!cid || !payload.eventType) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: "conversationId and eventType are required" }));
            return;
          }
          if (payload.eventType === "conversation.task_active" && typeof payload.taskId === "string" && payload.taskId.trim()) {
            const taskId = payload.taskId.trim();
            await writeConversationActiveTaskId(cid, taskId);
            io.to(`conversation:${cid}`).emit("conversation.task_active", {
              eventType: "conversation.task_active",
              conversationId: cid,
              taskId,
              state: typeof payload.state === "string" ? payload.state : "unknown",
              at: typeof payload.at === "number" ? payload.at : Date.now(),
            });
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    if (method === "POST" && url === "/api/task-events") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}") as {
            eventType?: string;
            taskId?: string;
            state?: string;
            step?: TaskStep;
            artifact?: TaskArtifact;
            error?: { message?: string };
            at?: number;
          };
          const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
          if (!taskId || !payload.eventType) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: "taskId and eventType are required" }));
            return;
          }

          const snap = await readTaskSnapshot(taskId);
          const next: TaskSnapshot = {
            ...snap,
            taskId,
            updatedAt: Date.now(),
          };

          if (payload.eventType === "task.state" && typeof payload.state === "string") {
            next.state = payload.state;
          }
          if (payload.eventType === "task.step" && payload.step) {
            const idx = next.steps.findIndex((s) => s.stepId === payload.step!.stepId);
            if (idx >= 0) next.steps[idx] = payload.step;
            else next.steps.push(payload.step);
          }
          if (payload.eventType === "task.artifact" && payload.artifact) {
            next.artifacts = [...next.artifacts, payload.artifact];
          }
          if (payload.eventType === "task.error") {
            next.lastError = payload.error?.message ?? "unknown error";
          }
          if (payload.eventType === "task.confirm_required") {
            next.confirmRequired = {
              stepId: typeof (payload as any).stepId === "string" ? (payload as any).stepId : "unknown",
              reason: typeof (payload as any).reason === "string" ? (payload as any).reason : "需要确认",
            };
          }
          if (payload.eventType === "task.confirm_resolved") {
            next.confirmRequired = null;
          }
          if (payload.eventType === "task.step" && payload.step) {
            // Clear confirm flag once the gated step progresses.
            if (next.confirmRequired && payload.step.stepId === next.confirmRequired.stepId && payload.step.status !== "pending") {
              next.confirmRequired = null;
            }
          }
          if (payload.eventType === "task.state" && (payload.state === "completed" || payload.state === "failed" || payload.state === "cancelled")) {
            next.confirmRequired = null;
          }

          await writeTaskSnapshot(taskId, next);
          io.to(`task:${taskId}`).emit(payload.eventType, payload);

          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("ok");
  });

  const io = new Server(server, {
    cors: {
      origin: allowOrigin === "*" ? true : allowOrigin.split(",").map((s) => s.trim()),
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  async function readSnapshot(docId: DocId): Promise<Snapshot> {
    const keys = [blocksKey(docId), tasksKey(docId), tsKey(docId), blocksVersionKey(docId), tasksVersionKey(docId)];
    const [blocksRaw, tasksRaw, serverTsRaw, blocksVerRaw, tasksVerRaw] = redis
      ? await redis.mGet(keys)
      : keys.map((k) => memory.get(k) ?? null);
    const blocks = blocksRaw ? (JSON.parse(blocksRaw) as Block[]) : [];
    const tasksState = tasksRaw
      ? (JSON.parse(tasksRaw) as TasksState)
      : ({ tasks: [], activeTaskId: undefined } satisfies TasksState);
    const serverTs = serverTsRaw ? Number(serverTsRaw) : 0;
    const blocksVersion = blocksVerRaw ? Number(blocksVerRaw) : 0;
    const tasksVersion = tasksVerRaw ? Number(tasksVerRaw) : 0;
    return { blocks, blocksVersion, tasksState, tasksVersion, serverTs };
  }

  async function writeBlocks(docId: DocId, nextBlocks: Block[], nextVersion: number): Promise<number> {
    const nextTs = Date.now();
    const payload = {
      [blocksKey(docId)]: JSON.stringify(nextBlocks),
      [tsKey(docId)]: String(nextTs),
      [blocksVersionKey(docId)]: String(nextVersion),
    };
    if (redis) await redis.mSet(payload);
    else Object.entries(payload).forEach(([k, v]) => memory.set(k, v));
    return nextTs;
  }

  async function writeTasks(docId: DocId, nextState: TasksState, nextVersion: number): Promise<number> {
    const nextTs = Date.now();
    const payload = {
      [tasksKey(docId)]: JSON.stringify(nextState),
      [tsKey(docId)]: String(nextTs),
      [tasksVersionKey(docId)]: String(nextVersion),
    };
    if (redis) await redis.mSet(payload);
    else Object.entries(payload).forEach(([k, v]) => memory.set(k, v));
    return nextTs;
  }

  async function readConversationActiveTaskId(cid: string): Promise<string> {
    const key = conversationKey(cid);
    const raw = redis ? await redis.get(key) : memory.get(key) ?? null;
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw) as { activeTaskId?: unknown };
      return typeof parsed.activeTaskId === "string" ? parsed.activeTaskId : "";
    } catch {
      return "";
    }
  }

  async function writeConversationActiveTaskId(cid: string, taskId: string): Promise<void> {
    const key = conversationKey(cid);
    const payload = JSON.stringify({ activeTaskId: taskId, updatedAt: Date.now() });
    if (redis) await redis.set(key, payload);
    else memory.set(key, payload);
  }

  async function readTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    const key = taskKey(taskId);
    const raw = redis ? await redis.get(key) : memory.get(key) ?? null;
    if (!raw) {
      return {
        taskId,
        state: "idle",
        steps: [],
        artifacts: [],
        updatedAt: 0,
      };
    }
    return JSON.parse(raw) as TaskSnapshot;
  }

  async function writeTaskSnapshot(taskId: string, snapshot: TaskSnapshot): Promise<void> {
    const key = taskKey(taskId);
    const serialized = JSON.stringify(snapshot);
    if (redis) await redis.set(key, serialized);
    else memory.set(key, serialized);
  }

  io.on("connection", (socket) => {
    const device = readDevice((socket.handshake.query as Record<string, unknown> | undefined)?.device);

    socket.on("join", async (payload: unknown) => {
      const docId = safeDocId((payload as any)?.docId);
      if (!docId) return;
      await socket.join(docId);
      const snap = await readSnapshot(docId);
      socket.emit("snapshot", { docId, ...snap });
    });

    socket.on("blocks:update", async (payload: unknown) => {
      const docId = safeDocId((payload as any)?.docId);
      const nextBlocks = (payload as any)?.blocks as Block[] | undefined;
      if (!docId || !Array.isArray(nextBlocks)) return;

      const baseVersionRaw = (payload as any)?.baseVersion;
      const hasBase = typeof baseVersionRaw === "number" && Number.isFinite(baseVersionRaw);
      const currentVersion = Number(
        (redis ? await redis.get(blocksVersionKey(docId)) : memory.get(blocksVersionKey(docId)) ?? "0") || "0",
      );
      if (hasBase && baseVersionRaw !== currentVersion) {
        const snap = await readSnapshot(docId);
        socket.emit("blocks:conflict", {
          docId,
          serverBlocks: snap.blocks,
          serverVersion: currentVersion,
        });
        return;
      }
      const nextVersion = currentVersion + 1;
      const serverTs = await writeBlocks(docId, nextBlocks, nextVersion);
      socket.broadcast.to(docId).emit("blocks:update", { docId, blocks: nextBlocks, version: nextVersion, serverTs });
      socket.emit("blocks:ack", { docId, version: nextVersion, serverTs });
    });

    socket.on("tasks:update", async (payload: unknown) => {
      const docId = safeDocId((payload as any)?.docId);
      const nextState = (payload as any)?.tasksState as TasksState | undefined;
      if (!docId || !nextState || !Array.isArray(nextState.tasks)) return;

      const baseVersionRaw = (payload as any)?.baseVersion;
      const hasBase = typeof baseVersionRaw === "number" && Number.isFinite(baseVersionRaw);
      const currentVersion = Number(
        (redis ? await redis.get(tasksVersionKey(docId)) : memory.get(tasksVersionKey(docId)) ?? "0") || "0",
      );
      if (hasBase && baseVersionRaw !== currentVersion) {
        const snap = await readSnapshot(docId);
        socket.emit("tasks:conflict", {
          docId,
          serverTasksState: snap.tasksState,
          serverVersion: currentVersion,
        });
        return;
      }
      const nextVersion = currentVersion + 1;
      const serverTs = await writeTasks(docId, nextState, nextVersion);
      socket.broadcast.to(docId).emit("tasks:update", { docId, tasksState: nextState, version: nextVersion, serverTs });
      socket.emit("tasks:ack", { docId, version: nextVersion, serverTs });
    });

    socket.on("task:join", async (payload: unknown) => {
      const taskId = typeof (payload as { taskId?: unknown })?.taskId === "string" ? (payload as { taskId: string }).taskId : "";
      if (!taskId) return;
      await socket.join(`task:${taskId}`);
      const snap = await readTaskSnapshot(taskId);
      socket.emit("task:snapshot", snap);
    });

    socket.on("conversation:join", async (payload: unknown) => {
      const cid =
        safeConversationId((payload as any)?.cid) ||
        safeConversationId((payload as any)?.conversationId);
      if (!cid) return;
      await socket.join(`conversation:${cid}`);
      addPresence(cid, socket.id, device);
      const activeTaskId = await readConversationActiveTaskId(cid);
      const presence = listPresence(cid);
      socket.emit("conversation:snapshot", { cid, activeTaskId, presence });
      io.to(`conversation:${cid}`).emit("presence:update", { cid, presence });
    });

    socket.on("conversation:leave", async (payload: unknown) => {
      const cid =
        safeConversationId((payload as any)?.cid) ||
        safeConversationId((payload as any)?.conversationId);
      if (!cid) return;
      await socket.leave(`conversation:${cid}`);
      removePresence(cid, socket.id);
      io.to(`conversation:${cid}`).emit("presence:update", { cid, presence: listPresence(cid) });
    });

    socket.on("disconnect", () => {
      const cids = cidsBySocket.get(socket.id);
      if (!cids) return;
      const cidList = Array.from(cids);
      for (const cid of cidList) {
        removePresence(cid, socket.id);
        io.to(`conversation:${cid}`).emit("presence:update", { cid, presence: listPresence(cid) });
      }
    });
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[realtime] listening on :${port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

