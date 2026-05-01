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

export function getSocket() {
  if (typeof window === "undefined") return null;
  if (socketSingleton) return socketSingleton;

  const url = getRealtimeUrl();
  if (!url) return null;

  socketSingleton = io(url, {
    transports: ["websocket"],
    autoConnect: true,
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

export function emitTasksUpdate(docId: DocId, tasksState: TasksState) {
  const s = getSocket();
  if (!s) return;
  s.emit("tasks:update", { docId, tasksState, clientId: getClientId(), ts: Date.now() });
}

