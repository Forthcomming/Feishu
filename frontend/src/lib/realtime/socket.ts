import { io, type Socket } from "socket.io-client";

import type { Task } from "@/lib/taskTypes";

export type DocId = string;

export type TasksState = {
  tasks: Task[];
  activeTaskId?: string;
};

export type TasksUpdatePayload = {
  docId: DocId;
  tasksState: TasksState;
  serverTs: number;
};

export type TaskStateEvent = {
  eventType: "task.state";
  taskId: string;
  state: string;
  at: number;
};

export type TaskStepEvent = {
  eventType: "task.step";
  taskId: string;
  step: {
    stepId: string;
    label: string;
    status: "pending" | "running" | "completed" | "failed";
  };
  at: number;
};

export type TaskArtifactEvent = {
  eventType: "task.artifact";
  taskId: string;
  artifact: {
    artifactId: string;
    kind: string;
    title: string;
    url: string;
  };
  at: number;
};

export type TaskErrorEvent = {
  eventType: "task.error";
  taskId: string;
  stepId: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
  at: number;
};

export type TaskConfirmRequiredEvent = {
  eventType: "task.confirm_required";
  taskId: string;
  stepId: string;
  reason: string;
  options?: {
    approveEndpoint?: string;
    cancelEndpoint?: string;
  };
  at: number;
};

export type TaskSnapshotPayload = {
  taskId: string;
  state: string;
  steps: Array<{ stepId: string; label: string; status: "pending" | "running" | "completed" | "failed" }>;
  artifacts: Array<{ artifactId: string; kind: string; title: string; url: string }>;
  lastError?: string;
  confirmRequired?: { stepId: string; reason: string } | null;
  updatedAt: number;
};

export type Device = "desktop" | "mobile";

export type PresenceEntry = { socketId: string; device: Device; joinedAt: number };

export type ConversationSnapshotPayload = {
  cid: string;
  activeTaskId: string;
  presence: PresenceEntry[];
};

export type ConversationTaskActiveEvent = {
  eventType: "conversation.task_active";
  conversationId: string;
  taskId: string;
  state: string;
  at: number;
};

export type PresenceUpdatePayload = { cid: string; presence: PresenceEntry[] };

export type TaskConfirmResolvedEvent = {
  eventType: "task.confirm_resolved";
  taskId: string;
  stepId: string;
  approved: boolean;
  at: number;
};

export type BlocksConflictPayload = {
  docId: string;
  serverBlocks: Array<{ id: string; type: "title" | "text" | "list"; content: string }>;
  serverVersion: number;
};

export type BlocksUpdatePayload = {
  docId: string;
  blocks: Array<{ id: string; type: "title" | "text" | "list"; content: string }>;
  version: number;
  serverTs: number;
};

export type BlocksAckPayload = { docId: string; version: number; serverTs: number };

export type TasksConflictPayload = {
  docId: string;
  serverTasksState: TasksState;
  serverVersion: number;
};

let socketSingleton: Socket | null = null;

function getRealtimeUrl() {
  const url = process.env.NEXT_PUBLIC_REALTIME_URL;
  if (!url) return null;
  return url;
}

function makeClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

export function getClientId() {
  if (typeof window === "undefined") return "server";
  const key = "realtime_client_id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const next = makeClientId();
  sessionStorage.setItem(key, next);
  return next;
}

function readDeviceFromUrl(): Device {
  if (typeof window === "undefined") return "desktop";
  try {
    const p = new URLSearchParams(window.location.search);
    return p.get("device") === "mobile" ? "mobile" : "desktop";
  } catch {
    return "desktop";
  }
}

export function getSocket() {
  if (typeof window === "undefined") return null;
  if (socketSingleton) return socketSingleton;

  const url = getRealtimeUrl();
  if (!url) return null;

  socketSingleton = io(url, {
    transports: ["websocket"],
    autoConnect: true,
    query: { device: readDeviceFromUrl(), clientId: getClientId() },
  });

  return socketSingleton;
}

export function joinDoc(docId: DocId) {
  const s = getSocket();
  if (!s) return;
  s.emit("join", { docId, clientId: getClientId() });
}

export function joinTask(taskId: string) {
  const s = getSocket();
  if (!s) return;
  s.emit("task:join", { taskId, clientId: getClientId() });
}

export function onTasksUpdate(handler: (p: TasksUpdatePayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("tasks:update", handler);
  return () => s.off("tasks:update", handler);
}

export function onTaskSnapshot(handler: (p: TaskSnapshotPayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("task:snapshot", handler);
  return () => s.off("task:snapshot", handler);
}

export function onTaskState(handler: (p: TaskStateEvent) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("task.state", handler);
  return () => s.off("task.state", handler);
}

export function onTaskStep(handler: (p: TaskStepEvent) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("task.step", handler);
  return () => s.off("task.step", handler);
}

export function onTaskArtifact(handler: (p: TaskArtifactEvent) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("task.artifact", handler);
  return () => s.off("task.artifact", handler);
}

export function onTaskError(handler: (p: TaskErrorEvent) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("task.error", handler);
  return () => s.off("task.error", handler);
}

export function onTaskConfirmRequired(handler: (p: TaskConfirmRequiredEvent) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("task.confirm_required", handler);
  return () => s.off("task.confirm_required", handler);
}

export function emitTasksUpdate(docId: DocId, tasksState: TasksState, baseVersion?: number) {
  const s = getSocket();
  if (!s) return;
  const payload: Record<string, unknown> = { docId, tasksState, clientId: getClientId(), ts: Date.now() };
  if (typeof baseVersion === "number" && Number.isFinite(baseVersion)) payload.baseVersion = baseVersion;
  s.emit("tasks:update", payload);
}

export function emitBlocksUpdate(
  docId: DocId,
  blocks: Array<{ id: string; type: "title" | "text" | "list"; content: string }>,
  baseVersion?: number,
) {
  const s = getSocket();
  if (!s) return;
  const payload: Record<string, unknown> = { docId, blocks, clientId: getClientId(), ts: Date.now() };
  if (typeof baseVersion === "number" && Number.isFinite(baseVersion)) payload.baseVersion = baseVersion;
  s.emit("blocks:update", payload);
}

export function joinConversation(cid: string) {
  const s = getSocket();
  if (!s) return;
  s.emit("conversation:join", { cid, clientId: getClientId() });
}

export function leaveConversation(cid: string) {
  const s = getSocket();
  if (!s) return;
  s.emit("conversation:leave", { cid, clientId: getClientId() });
}

export function onConversationSnapshot(handler: (p: ConversationSnapshotPayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("conversation:snapshot", handler);
  return () => s.off("conversation:snapshot", handler);
}

export function onConversationTaskActive(handler: (p: ConversationTaskActiveEvent) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("conversation.task_active", handler);
  return () => s.off("conversation.task_active", handler);
}

export function onPresenceUpdate(handler: (p: PresenceUpdatePayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("presence:update", handler);
  return () => s.off("presence:update", handler);
}

export function onTaskConfirmResolved(handler: (p: TaskConfirmResolvedEvent) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("task.confirm_resolved", handler);
  return () => s.off("task.confirm_resolved", handler);
}

export function onBlocksUpdate(handler: (p: BlocksUpdatePayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("blocks:update", handler);
  return () => s.off("blocks:update", handler);
}

export function onBlocksAck(handler: (p: BlocksAckPayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("blocks:ack", handler);
  return () => s.off("blocks:ack", handler);
}

export function onBlocksConflict(handler: (p: BlocksConflictPayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("blocks:conflict", handler);
  return () => s.off("blocks:conflict", handler);
}

export function onTasksConflict(handler: (p: TasksConflictPayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("tasks:conflict", handler);
  return () => s.off("tasks:conflict", handler);
}

export type DocSnapshotPayload = {
  docId: string;
  blocks: Array<{ id: string; type: "title" | "text" | "list"; content: string }>;
  blocksVersion: number;
  tasksState: TasksState;
  tasksVersion: number;
  serverTs: number;
};

export function onDocSnapshot(handler: (p: DocSnapshotPayload) => void) {
  const s = getSocket();
  if (!s) return () => {};
  s.on("snapshot", handler);
  return () => s.off("snapshot", handler);
}

