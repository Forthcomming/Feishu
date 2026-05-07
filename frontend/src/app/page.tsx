"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { DocumentRenderer } from "@/components/DocumentRenderer";
import type { DocumentPayload } from "@/lib/docTypes";
import { TaskPanel } from "@/components/TaskPanel";
import { SharedMemo } from "@/components/SharedMemo";
import type { Task } from "@/lib/taskTypes";
import {
  joinConversation,
  joinTask,
  leaveConversation,
  onConversationSnapshot,
  onConversationTaskActive,
  onPresenceUpdate,
  onTaskArtifact,
  onTaskConfirmRequired,
  onTaskConfirmResolved,
  onTaskError,
  onTaskFeedbackSubmitted,
  onTaskSnapshot,
  onTaskState,
  onTaskStep,
  type ConversationSnapshotPayload,
  type ConversationTaskActiveEvent,
  type PresenceEntry,
  type PresenceUpdatePayload,
  type TaskArtifactEvent,
  type TaskConfirmRequiredEvent,
  type TaskErrorEvent,
  type TaskFeedbackSubmittedEvent,
  type TaskSnapshotPayload,
  type TaskStateEvent,
  type TaskStepEvent,
} from "@/lib/realtime/socket";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  kind: "text" | "doc" | "task_separator";
  content: string | DocumentPayload;
};

type WorkflowStartContextDebug = {
  enriched?: boolean;
  usedChatId?: string;
  usedIdentity?: string;
  lines?: number;
  topK?: number;
  error?: string;
};

function formatContextDebugLine(d: WorkflowStartContextDebug | undefined): string {
  if (!d || typeof d !== "object") return "";
  const enriched = d.enriched === true;
  const lines = typeof d.lines === "number" ? d.lines : 0;
  const topK = typeof d.topK === "number" && d.topK > 0 ? d.topK : 0;
  const err = typeof d.error === "string" && d.error.trim() ? d.error.trim() : "";
  if (enriched) {
    const tail = topK ? `，选用 Top-${topK} 条` : "";
    return `【上下文】已用群聊增强输入（召回约 ${lines} 行${tail}）。`;
  }
  return `【上下文】未增强（约 ${lines} 行${err ? `；${err}` : ""}）。`;
}

function buildWorkflowAckWithContext(contextDebug: WorkflowStartContextDebug | undefined, body: string): string {
  const line = formatContextDebugLine(contextDebug);
  return line ? `${line}\n\n${body}` : body;
}

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

async function fakeAiReply(userText: string) {
  await new Promise((r) => setTimeout(r, 700));
  const trimmed = userText.trim();
  if (!trimmed) return "我没有收到内容，可以再发一次吗？";
  return `已收到：${trimmed}\n\n（当前为前端 stub；后续可接真实接口）`;
}

function isWorkflowKeyword(text: string) {
  const t = text.trim();
  if (!t) return false;
  const hasDocRef = /(?:https?:\/\/[^\s"']+\/docx\/[A-Za-z0-9]+)|(?:docx\/[A-Za-z0-9]+)/.test(t);
  const hasSlidesRef = /(?:https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9_-]+)|(?:slides\/[A-Za-z0-9_-]+)/.test(t);
  // 与 agent-service editIntentParser 常见编辑动词对齐；缺「插入」等会导致带 docx 链接的插入指令只走 stub、不启动 workflow。
  const wantsEdit =
    /(更新|修改|补充|替换|继续|插入|新增|添加|删掉|删去|删除|去掉|移除|润色|重写|精简|压缩|改成|改为|第\s*\d+\s*页|页码\s*\d+)/.test(
      t,
    );
  return t.includes("生成PPT") || t.includes("需求文档") || (hasDocRef && wantsEdit) || (hasSlidesRef && wantsEdit);
}

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled", "idle"]);

async function isTerminalTask(taskId: string): Promise<boolean> {
  const safeTaskId = String(taskId || "").trim();
  if (!safeTaskId) return true;
  try {
    const resp = await fetch(`/api/agent/workflow/task/${encodeURIComponent(safeTaskId)}`, { cache: "no-store" });
    if (!resp.ok) return false;
    const payload = (await resp.json()) as { ok?: boolean; task?: { state?: string } };
    const state = typeof payload?.task?.state === "string" ? payload.task.state.trim() : "";
    return TERMINAL_TASK_STATES.has(state);
  } catch {
    return false;
  }
}

function TaskRunDivider({ label }: { label?: string }) {
  return (
    <div className="my-6 flex items-center gap-3" role="separator" aria-label={label ?? "任务分隔"}>
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-zinc-400/70 to-zinc-300/50" />
      <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-indigo-800 ring-1 ring-indigo-200/90">
        {label?.trim() ? label : "开启新任务"}
      </span>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent via-zinc-400/70 to-zinc-300/50" />
    </div>
  );
}

function Bubble({ role, message }: { role: ChatRole; message: ChatMessage }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 shadow-sm",
          isUser
            ? "bg-indigo-600 text-white shadow-indigo-900/10"
            : "bg-white/95 text-zinc-900 ring-1 ring-zinc-200/80 shadow-zinc-900/5",
        ].join(" ")}
      >
        {message.kind === "doc" && !isUser ? (
          <DocumentRenderer payload={message.content as DocumentPayload} />
        ) : (
          <div className="whitespace-pre-wrap">{message.content as string}</div>
        )}
      </div>
    </div>
  );
}

function removeTaskIdFromCurrentUrl() {
  if (typeof window === "undefined") return;
  try {
    const next = new URLSearchParams(window.location.search);
    next.delete("taskId");
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `/?${qs}` : "/");
  } catch {
    // ignore
  }
}

function isCancelledState(state: unknown): boolean {
  return typeof state === "string" && state.trim() === "cancelled";
}

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const device = searchParams.get("device");
  const taskIdFromUrl = searchParams.get("taskId");
  const isMobile = device === "mobile";
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: makeId("m"),
      role: "assistant",
      kind: "text",
      content: "你好，我是 AI 助手。你可以在下面输入消息。",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(undefined);
  const [startedWorkflowTaskId, setStartedWorkflowTaskId] = useState<string | null>(null);
  const [slidesRehearsalUrl, setSlidesRehearsalUrl] = useState("");
  const [confirmRequest, setConfirmRequest] = useState<{ taskId: string; stepId: string; reason: string } | null>(
    null,
  );
  const [feedbackEligibleTaskId, setFeedbackEligibleTaskId] = useState<string | undefined>(undefined);
  const [feedbackNote, setFeedbackNote] = useState<string>("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState<boolean>(false);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const currentWorkflowTaskIdRef = useRef<string | null>(null);
  /** 已提交反馈的 taskId（多端同步：快照 / 事件 / 轮询 / 本机提交） */
  const feedbackSubmittedTaskIdsRef = useRef<Set<string>>(new Set());
  const seenArtifactIdsRef = useRef<Set<string>>(new Set());
  /** 用户点「解绑任务」后，忽略 snapshot 里缓存的 activeTaskId，避免立刻把旧 taskId 写回 URL；新任务以 conversation.task_active 为准。 */
  const pauseSnapshotTaskBindRef = useRef(false);
  /** 仅在 pause=true 时生效：记录被主动解绑/取消的 taskId，避免同一个旧任务被立刻回填。 */
  const pausedTaskIdRef = useRef<string>("");
  /** 用于在「当前绑定的 taskId」变化时插入分割线；空串表示尚未记录到非空任务。 */
  const prevBoundTaskIdForDividerRef = useRef<string>("");
  /** 本机 onSend 已插入「新任务」分割线时，下一次 taskId 变化由 effect 跳过，避免重复。 */
  const skipDividerOnNextTaskIdChangeRef = useRef(false);

  const cidFromUrl = searchParams.get("conversationId");
  const conversationId = useMemo(() => {
    const fromUrl = typeof cidFromUrl === "string" ? cidFromUrl.trim() : "";
    const fromEnv = (process.env.NEXT_PUBLIC_DELIVERY_CHAT_ID ?? "").trim();
    return fromUrl || fromEnv || "demo_conversation";
  }, [cidFromUrl]);
  const appendArtifactsToMessages = (
    artifacts: Array<{ artifactId?: string; kind: string; title: string; url: string }>,
  ) => {
    const newMsgs: ChatMessage[] = [];
    for (const a of artifacts) {
      const aid =
        typeof a.artifactId === "string" && a.artifactId.trim() ? a.artifactId.trim() : `${a.kind}:${a.title}:${a.url}`;
      if (seenArtifactIdsRef.current.has(aid)) continue;
      seenArtifactIdsRef.current.add(aid);
      if (a.kind === "slides" && typeof a.url === "string" && a.url.trim()) setSlidesRehearsalUrl(a.url);
      const content = a.url ? `已生成${a.kind.toUpperCase()}：${a.title}\n${a.url}` : `已生成${a.kind.toUpperCase()}：${a.title}`;
      newMsgs.push({ id: makeId("m"), role: "assistant", kind: "text", content });
    }
    if (newMsgs.length > 0) setMessages((prev) => [...prev, ...newMsgs]);
  };

  const effectiveTaskId = useMemo(() => {
    const trimmed = typeof taskIdFromUrl === "string" ? taskIdFromUrl.trim() : "";
    return trimmed || startedWorkflowTaskId || "";
  }, [taskIdFromUrl, startedWorkflowTaskId]);

  // 任务 ID 从 A 切到 B 时补一条分割线（IM / 快照 / poll 绑定新任务也会走到这里）；本机发工作流时已插入分割线的由 skip 去重。
  useEffect(() => {
    const tid = (effectiveTaskId ?? "").trim();
    if (!tid) return;

    const prev = prevBoundTaskIdForDividerRef.current;
    if (prev && prev !== tid) {
      if (skipDividerOnNextTaskIdChangeRef.current) {
        skipDividerOnNextTaskIdChangeRef.current = false;
      } else {
        const label = "开启新任务";
        const sep: ChatMessage = {
          id: makeId("sep"),
          role: "assistant",
          kind: "task_separator",
          content: label,
        };
        setMessages((m) => [...m, sep]);
      }
    }
    prevBoundTaskIdForDividerRef.current = tid;
  }, [effectiveTaskId]);

  const realtimeConfigured = useMemo(() => Boolean(process.env.NEXT_PUBLIC_REALTIME_URL), []);

  const clearBoundTask = () => {
    pauseSnapshotTaskBindRef.current = true;
    pausedTaskIdRef.current = (currentWorkflowTaskIdRef.current || "").trim();
    prevBoundTaskIdForDividerRef.current = "";
    skipDividerOnNextTaskIdChangeRef.current = false;
    setStartedWorkflowTaskId(null);
    setTasks([]);
    setActiveTaskId(undefined);
    setConfirmRequest(null);
    setFeedbackEligibleTaskId(undefined);
    setSlidesRehearsalUrl("");
    seenArtifactIdsRef.current.clear();
    const next = new URLSearchParams(searchParams.toString());
    next.delete("taskId");
    router.replace(`/?${next.toString()}`);
  };

  /** 同一页再次发起工作流时先卸下旧 task，避免叠在旧进度上；不暂停 snapshot（马上要绑新 id）。 */
  const detachPreviousTaskBeforeStart = () => {
    pauseSnapshotTaskBindRef.current = false;
    pausedTaskIdRef.current = "";
    setStartedWorkflowTaskId(null);
    setTasks([]);
    setActiveTaskId(undefined);
    setConfirmRequest(null);
    setFeedbackEligibleTaskId(undefined);
    setSlidesRehearsalUrl("");
    seenArtifactIdsRef.current.clear();
    const next = new URLSearchParams(searchParams.toString());
    next.delete("taskId");
    router.replace(`/?${next.toString()}`);
  };

  useEffect(() => {
    currentWorkflowTaskIdRef.current = effectiveTaskId || null;
    if (effectiveTaskId && realtimeConfigured) joinTask(effectiveTaskId);
  }, [effectiveTaskId, realtimeConfigured]);

  // If the GUI has no taskId yet, discover the latest non-terminal task for this conversation.
  // - Without realtime: this is the only way to auto-subscribe.
  // - With realtime: snapshot / conversation.task_active are primary, but this still runs when
  //   realtime store lost activeTaskId (e.g. server restart) or events were missed — complements push.
  useEffect(() => {
    if (effectiveTaskId) return;
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(`/api/agent/conversation/${encodeURIComponent(conversationId)}/latest-task`, {
          cache: "no-store",
        });
        if (!resp.ok) return;
        const payload = (await resp.json()) as { ok: boolean; found?: boolean; taskId?: string };
        const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
        if (!payload.ok || !payload.found || !taskId) return;
        if (pauseSnapshotTaskBindRef.current && taskId === pausedTaskIdRef.current) return;
        const terminal = await isTerminalTask(taskId);
        if (terminal) return;
        if (cancelled) return;
        if (pauseSnapshotTaskBindRef.current && taskId !== pausedTaskIdRef.current) {
          pauseSnapshotTaskBindRef.current = false;
          pausedTaskIdRef.current = "";
        }
        setStartedWorkflowTaskId(taskId);
        {
          const next = new URLSearchParams(searchParams.toString());
          next.set("taskId", taskId);
          router.replace(`/?${next.toString()}`);
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveTaskId, realtimeConfigured, conversationId, router, searchParams]);

  // Scene E: join the conversation room for cross-device presence + task active push.
  useEffect(() => {
    if (!realtimeConfigured) return;
    if (!conversationId) return;

    joinConversation(conversationId);

    const offSnapshot = onConversationSnapshot((p: ConversationSnapshotPayload) => {
      if (p.cid !== conversationId) return;
      setPresence(Array.isArray(p.presence) ? p.presence : []);
      const tid = typeof p.activeTaskId === "string" ? p.activeTaskId.trim() : "";
      if (!tid || tid === currentWorkflowTaskIdRef.current) return;
      if (pauseSnapshotTaskBindRef.current && tid === pausedTaskIdRef.current) return;
      void (async () => {
        const terminal = await isTerminalTask(tid);
        if (terminal) return;
        if (pauseSnapshotTaskBindRef.current && tid !== pausedTaskIdRef.current) {
          pauseSnapshotTaskBindRef.current = false;
          pausedTaskIdRef.current = "";
        }
        setStartedWorkflowTaskId(tid);
        const next = new URLSearchParams(searchParams.toString());
        next.set("taskId", tid);
        router.replace(`/?${next.toString()}`);
      })();
    });

    const offActive = onConversationTaskActive((p: ConversationTaskActiveEvent) => {
      if (p.conversationId !== conversationId) return;
      const tid = typeof p.taskId === "string" ? p.taskId.trim() : "";
      if (!tid) return;
      if (tid === currentWorkflowTaskIdRef.current) return;
      pauseSnapshotTaskBindRef.current = false;
      pausedTaskIdRef.current = "";
      seenArtifactIdsRef.current.clear();
      setSlidesRehearsalUrl("");
      setTasks([]);
      setActiveTaskId(undefined);
      setStartedWorkflowTaskId(tid);
      const next = new URLSearchParams(searchParams.toString());
      next.set("taskId", tid);
      router.replace(`/?${next.toString()}`);
    });

    const offPresence = onPresenceUpdate((p: PresenceUpdatePayload) => {
      if (p.cid !== conversationId) return;
      setPresence(Array.isArray(p.presence) ? p.presence : []);
    });

    const offConfirmResolved = onTaskConfirmResolved((p) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
      setConfirmRequest(null);
    });

    return () => {
      offSnapshot();
      offActive();
      offPresence();
      offConfirmResolved();
      leaveConversation(conversationId);
    };
  }, [realtimeConfigured, conversationId, router, searchParams]);

  const canSend = useMemo(() => !isLoading && input.trim().length > 0, [input, isLoading]);

  const presenceCounts = useMemo(() => {
    let desktop = 0;
    let mobile = 0;
    for (const p of presence) {
      if (p.device === "mobile") mobile += 1;
      else desktop += 1;
    }
    return { desktop, mobile };
  }, [presence]);

  const toTaskStatus = (status: "pending" | "running" | "completed" | "failed"): Task["status"] => {
    if (status === "completed") return "done";
    if (status === "failed") return "failed";
    return status;
  };

  useEffect(() => {
    if (!effectiveTaskId) return;
    if (realtimeConfigured) return;

    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const resp = await fetch(`/api/agent/workflow/task/${encodeURIComponent(effectiveTaskId)}`, { cache: "no-store" });
        if (!resp.ok) return;
        const payload = (await resp.json()) as {
          ok: boolean;
          task?: {
            steps?: Array<{ stepId: string; status: "pending" | "running" | "completed" | "failed" }>;
            state?: string;
            feedbackSubmitted?: { rating: string; at: number };
          };
          artifacts?: Array<{ artifactId?: string; kind: string; title: string; url: string }>;
          error?: string | null;
        };
        if (!payload.ok || !payload.task?.steps) return;
        if (payload.task.feedbackSubmitted && effectiveTaskId) {
          feedbackSubmittedTaskIdsRef.current.add(effectiveTaskId);
          setFeedbackEligibleTaskId(undefined);
        }
        setTasks(payload.task.steps.map((s) => ({ id: s.stepId, title: s.stepId, status: toTaskStatus(s.status) })));
        const slidesArtifact = Array.isArray(payload.artifacts)
          ? payload.artifacts.find((a) => a.kind === "slides" && typeof a.url === "string" && a.url.trim())
          : null;
        if (slidesArtifact?.url) {
          setSlidesRehearsalUrl(slidesArtifact.url);
        }
        appendArtifactsToMessages(Array.isArray(payload.artifacts) ? payload.artifacts : []);
        const active = payload.task.steps.find((s) => s.status === "running");
        setActiveTaskId(active?.stepId);
        if (
          payload.task.state === "completed" ||
          payload.task.state === "failed" ||
          payload.task.state === "cancelled" ||
          payload.task.state === "idle"
        ) {
          setActiveTaskId(undefined);
        }
        if (isCancelledState(payload.task.state)) {
          pauseSnapshotTaskBindRef.current = true;
          pausedTaskIdRef.current = (effectiveTaskId || "").trim();
          setStartedWorkflowTaskId(null);
          setTasks([]);
          setActiveTaskId(undefined);
          setConfirmRequest(null);
          setSlidesRehearsalUrl("");
          setFeedbackEligibleTaskId(undefined);
          removeTaskIdFromCurrentUrl();
        }
        if (payload.task.state === "idle" && effectiveTaskId && !payload.task.feedbackSubmitted) {
          if (!feedbackSubmittedTaskIdsRef.current.has(effectiveTaskId)) {
            setFeedbackEligibleTaskId(effectiveTaskId);
          }
        }
      } finally {
        // noop
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 1200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [effectiveTaskId, realtimeConfigured]);

  // Hard guard for refresh/back-forward: if URL still carries a cancelled taskId, auto-unbind it.
  useEffect(() => {
    if (!effectiveTaskId) return;
    let aborted = false;
    void (async () => {
      try {
        const resp = await fetch(`/api/agent/workflow/task/${encodeURIComponent(effectiveTaskId)}`, { cache: "no-store" });
        if (!resp.ok || aborted) return;
        const payload = (await resp.json()) as { ok?: boolean; task?: { state?: string } };
        if (!payload?.ok || aborted) return;
        if (!isCancelledState(payload?.task?.state)) return;
        pauseSnapshotTaskBindRef.current = true;
        pausedTaskIdRef.current = (effectiveTaskId || "").trim();
        setStartedWorkflowTaskId(null);
        setTasks([]);
        setActiveTaskId(undefined);
        setConfirmRequest(null);
        setSlidesRehearsalUrl("");
        setFeedbackEligibleTaskId(undefined);
        removeTaskIdFromCurrentUrl();
      } catch {
        // ignore
      }
    })();
    return () => {
      aborted = true;
    };
  }, [effectiveTaskId]);

  useEffect(() => {
    if (!realtimeConfigured) return () => {};
    const offTaskSnapshot = onTaskSnapshot((p: TaskSnapshotPayload) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
      if (p.feedbackSubmitted) {
        feedbackSubmittedTaskIdsRef.current.add(p.taskId);
        setFeedbackEligibleTaskId(undefined);
      }
      const nextTasks = p.steps.map((s) => ({ id: s.stepId, title: s.label, status: toTaskStatus(s.status) }));
      setTasks(nextTasks);
      appendArtifactsToMessages(
        Array.isArray(p.artifacts)
          ? p.artifacts.map((a) => ({ artifactId: a.artifactId, kind: a.kind, title: a.title, url: a.url }))
          : [],
      );
      const active = p.steps.find((s) => s.status === "running");
      setActiveTaskId(active?.stepId);
      if (p.confirmRequired && p.confirmRequired.stepId) {
        setConfirmRequest({ taskId: p.taskId, stepId: p.confirmRequired.stepId, reason: p.confirmRequired.reason });
      }
    });

    const offTaskState = onTaskState((p: TaskStateEvent) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
      if (p.state === "completed" || p.state === "failed" || p.state === "idle") setActiveTaskId(undefined);
      if (p.state === "completed" || p.state === "failed" || p.state === "cancelled" || p.state === "idle") {
        setConfirmRequest(null);
      }
      if (isCancelledState(p.state)) {
        pauseSnapshotTaskBindRef.current = true;
        pausedTaskIdRef.current = (p.taskId || "").trim();
        setStartedWorkflowTaskId(null);
        setTasks([]);
        setActiveTaskId(undefined);
        setConfirmRequest(null);
        setSlidesRehearsalUrl("");
        setFeedbackEligibleTaskId(undefined);
        removeTaskIdFromCurrentUrl();
      }
      if (p.state === "idle" && !feedbackSubmittedTaskIdsRef.current.has(p.taskId)) {
        setFeedbackEligibleTaskId(p.taskId);
      }
      if (p.state === "failed" || p.state === "cancelled") {
        setFeedbackEligibleTaskId(undefined);
      }
    });

    const offTaskStep = onTaskStep((p: TaskStepEvent) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
      setTasks((prev) => {
        const exists = prev.some((t) => t.id === p.step.stepId);
        const status = toTaskStatus(p.step.status);
        if (!exists) return [...prev, { id: p.step.stepId, title: p.step.label, status }];
        return prev.map((t) => (t.id === p.step.stepId ? { ...t, title: p.step.label, status } : t));
      });
      if (p.step.status === "running") setActiveTaskId(p.step.stepId);
      if (p.step.status === "completed" || p.step.status === "failed") {
        setActiveTaskId((prev) => (prev === p.step.stepId ? undefined : prev));
      }
    });

    const offTaskArtifact = onTaskArtifact((p: TaskArtifactEvent) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
      appendArtifactsToMessages([{ artifactId: p.artifact.artifactId, kind: p.artifact.kind, title: p.artifact.title, url: p.artifact.url }]);
    });

    const offTaskError = onTaskError((p: TaskErrorEvent) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
      const aiMsg: ChatMessage = {
        id: makeId("m"),
        role: "assistant",
        kind: "text",
        content: `任务失败：${p.error.message}`,
      };
      setMessages((prev) => [...prev, aiMsg]);
      setTasks((prev) => prev.map((t) => (t.id === p.stepId ? { ...t, status: "failed" } : t)));
      setActiveTaskId(undefined);
      setConfirmRequest(null);
      setFeedbackEligibleTaskId(undefined);
    });

    const offTaskFeedbackSubmitted = onTaskFeedbackSubmitted((p: TaskFeedbackSubmittedEvent) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
      feedbackSubmittedTaskIdsRef.current.add(p.taskId);
      setFeedbackEligibleTaskId(undefined);
    });

    const offTaskConfirm = onTaskConfirmRequired((p: TaskConfirmRequiredEvent) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
      setConfirmRequest({ taskId: p.taskId, stepId: p.stepId, reason: p.reason });
      const aiMsg: ChatMessage = {
        id: makeId("m"),
        role: "assistant",
        kind: "text",
        content: `需要确认：${p.reason}\n（请在页面上点击“确认执行”或“取消任务”）`,
      };
      setMessages((prev) => [...prev, aiMsg]);
    });

    return () => {
      offTaskSnapshot();
      offTaskState();
      offTaskStep();
      offTaskArtifact();
      offTaskError();
      offTaskFeedbackSubmitted();
      offTaskConfirm();
    };
  }, [realtimeConfigured]);

  const onApprove = async () => {
    if (!confirmRequest) return;
    await fetch("/api/agent/workflow/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: confirmRequest.taskId,
        stepId: confirmRequest.stepId,
        approved: true,
        override: { dryRun: false, defaultIdentity: "bot" },
      }),
    });
    setConfirmRequest(null);
  };

  const onCancel = async () => {
    if (!confirmRequest) return;
    await fetch("/api/agent/workflow/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: confirmRequest.taskId }),
    });
    setConfirmRequest(null);
  };

  async function onSend() {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    const userMsg: ChatMessage = { id: makeId("m"), role: "user", kind: "text", content: text };
    const contextMessages = [...messages, userMsg]
      .filter((m) => m.kind === "text")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content as string }));
    const willStartWorkflow = text.includes("生成PPT") || isWorkflowKeyword(text);
    if (willStartWorkflow) {
      setFeedbackEligibleTaskId(undefined);
      skipDividerOnNextTaskIdChangeRef.current = true;
      detachPreviousTaskBeforeStart();
    }
    const taskSep: ChatMessage | null = willStartWorkflow
      ? {
          id: makeId("sep"),
          role: "assistant",
          kind: "task_separator",
          content: "开启新任务",
        }
      : null;
    setMessages((prev) => (taskSep ? [...prev, taskSep, userMsg] : [...prev, userMsg]));
    setIsLoading(true);

    try {
      const syncChatId = process.env.NEXT_PUBLIC_DELIVERY_CHAT_ID ?? "";
      const syncDryRun = process.env.NEXT_PUBLIC_WORKFLOW_DRY_RUN !== "false";

      if (text.includes("生成PPT")) {
        const deliveryChatId = process.env.NEXT_PUBLIC_DELIVERY_CHAT_ID ?? "";
        const workflowDryRun = process.env.NEXT_PUBLIC_WORKFLOW_DRY_RUN !== "false";
        const resp = await fetch("/api/agent/workflow/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId,
            input: text,
            contextRange: { mode: "recent_messages", limit: 20 },
            targetArtifacts: ["slides"],
            delivery: { channel: "im_chat", chatId: deliveryChatId },
            execution: { dryRun: workflowDryRun, defaultIdentity: "bot", docIdentity: "user", slidesIdentity: "user" },
          }),
        });
        if (!resp.ok) {
          const msg = await resp.text().catch(() => "");
          throw new Error(msg || `Request failed: ${resp.status}`);
        }
        const payload = (await resp.json()) as {
          ok: boolean;
          task?: { taskId: string; state: string };
          contextDebug?: WorkflowStartContextDebug;
        };
        if (!payload.ok || !payload.task?.taskId) {
          throw new Error("workflow start 返回格式不正确");
        }
        const startedTaskId = payload.task.taskId;
        seenArtifactIdsRef.current.clear();
        setSlidesRehearsalUrl("");
        setTasks([]);
        setActiveTaskId(undefined);
        setStartedWorkflowTaskId(startedTaskId);
        {
          const next = new URLSearchParams(searchParams.toString());
          next.set("taskId", startedTaskId);
          router.replace(`/?${next.toString()}`);
        }
        const aiMsg: ChatMessage = {
          id: makeId("m"),
          role: "assistant",
          kind: "text",
          content: buildWorkflowAckWithContext(
            payload.contextDebug,
            `已启动飞书PPT生成任务（${startedTaskId}），生成后可直接打开飞书排练。`,
          ),
        };
        setMessages((prev) => [...prev, aiMsg]);
        return;
      }

      if (isWorkflowKeyword(text)) {
        const deliveryChatId = process.env.NEXT_PUBLIC_DELIVERY_CHAT_ID ?? "";
        const workflowDryRun = process.env.NEXT_PUBLIC_WORKFLOW_DRY_RUN !== "false";
        const hasDocRef = /(?:https?:\/\/[^\s"']+\/docx\/[A-Za-z0-9]+)|(?:docx\/[A-Za-z0-9]+)/.test(text);
        const hasSlidesRef = /(?:https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9_-]+)|(?:slides\/[A-Za-z0-9_-]+)/.test(text);
        const targetArtifacts = hasSlidesRef ? ["slides"] : hasDocRef ? ["doc"] : ["doc"];
        const resp = await fetch("/api/agent/workflow/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId,
            input: text,
            contextRange: { mode: "recent_messages", limit: 20 },
            targetArtifacts,
            delivery: { channel: "im_chat", chatId: deliveryChatId },
            // Use bot for IM ack/delivery by default, but use user identity for docs.create to ensure you can view the doc.
            execution: {
              dryRun: workflowDryRun,
              defaultIdentity: "bot",
              docIdentity: "user",
              slidesIdentity: "user",
            },
          }),
        });
        if (!resp.ok) {
          const msg = await resp.text().catch(() => "");
          throw new Error(msg || `Request failed: ${resp.status}`);
        }
        const payload = (await resp.json()) as {
          ok: boolean;
          task?: { taskId: string; state: string };
          contextDebug?: WorkflowStartContextDebug;
        };
        if (!payload.ok || !payload.task?.taskId) {
          throw new Error("workflow start 返回格式不正确");
        }
        const startedTaskId = payload.task.taskId;
        seenArtifactIdsRef.current.clear();

        // Sync to Feishu after we have the taskId, and avoid triggering webhook to create another task.
        // agent-service treats this as bot-ack style noise in context; text avoids deliverable-like phrasing.
        if (syncChatId) {
          void (async () => {
            const resp2 = await fetch("/api/im/messages-send", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                as: "user",
                chatId: syncChatId,
                text: "已收到指令，任务已开始",
                dryRun: syncDryRun,
              }),
            });
            if (!resp2.ok) {
              const msg = await resp2.text().catch(() => "");
              throw new Error(msg || `HTTP ${resp2.status}`);
            }
          })().catch((e) => {
            const errText = e instanceof Error ? e.message : String(e);
            const aiMsg: ChatMessage = {
              id: makeId("m"),
              role: "assistant",
              kind: "text",
              content: `同步到飞书失败：${errText}`,
            };
            setMessages((prev) => [...prev, aiMsg]);
          });
        }
        setTasks([]);
        setActiveTaskId(undefined);
        setStartedWorkflowTaskId(startedTaskId);
        {
          const next = new URLSearchParams(searchParams.toString());
          next.set("taskId", startedTaskId);
          router.replace(`/?${next.toString()}`);
        }
        const aiMsg: ChatMessage = {
          id: makeId("m"),
          role: "assistant",
          kind: "text",
          content: buildWorkflowAckWithContext(payload.contextDebug, "已收到指令，任务已开始，正在执行…"),
        };
        setMessages((prev) => [...prev, aiMsg]);
        return;
      }

      if (text === "生成文档") {
        const resp = await fetch("/api/generate-doc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trigger: "生成文档", contextMessages }),
        });
        if (!resp.ok) {
          const msg = await resp.text().catch(() => "");
          throw new Error(msg || `Request failed: ${resp.status}`);
        }
        const payload = (await resp.json()) as DocumentPayload;
        const aiMsg: ChatMessage = { id: makeId("m"), role: "assistant", kind: "doc", content: payload };
        setMessages((prev) => [...prev, aiMsg]);
      } else {
        const reply = await fakeAiReply(text);
        const aiMsg: ChatMessage = { id: makeId("m"), role: "assistant", kind: "text", content: reply };
        setMessages((prev) => [...prev, aiMsg]);
      }
    } catch (e) {
      skipDividerOnNextTaskIdChangeRef.current = false;
      const errText = e instanceof Error ? e.message : String(e);
      const aiMsg: ChatMessage = {
        id: makeId("m"),
        role: "assistant",
        kind: "text",
        content: `请求失败：${errText}`,
      };
      setMessages((prev) => [...prev, aiMsg]);
    } finally {
      setIsLoading(false);
      // 下一帧滚到底部
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-gradient-to-b from-slate-50 via-white to-zinc-100 font-sans text-zinc-900">
      <header className="sticky top-0 z-10 border-b border-zinc-200/80 bg-white/85 backdrop-blur-md">
        <div
          className={[
            "mx-auto flex w-full max-w-full items-center justify-between gap-3 px-4 py-3.5",
            isMobile ? "max-w-md" : "max-w-6xl",
          ].join(" ")}
        >
          <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
            <div className="truncate text-sm font-semibold tracking-tight text-zinc-900">飞书 IM</div>
            <span
              className={[
                "w-fit rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                isMobile
                  ? "bg-emerald-500/10 text-emerald-700 ring-1 ring-emerald-500/20"
                  : "bg-indigo-500/10 text-indigo-700 ring-1 ring-indigo-500/20",
              ].join(" ")}
            >
              {isMobile ? "移动" : "桌面"}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {realtimeConfigured && conversationId ? (
              <span
                title={`会话 ${conversationId}`}
                className="rounded-md bg-zinc-100/90 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-200/80"
              >
                在线 · 桌{presenceCounts.desktop} 移{presenceCounts.mobile}
              </span>
            ) : null}
            {effectiveTaskId ? (
              <button
                type="button"
                title="从地址栏移除 taskId，并暂停用会话快照自动回填，便于连续测新任务"
                className="rounded-md bg-white px-2 py-0.5 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-200/80 transition hover:bg-zinc-50"
                onClick={clearBoundTask}
              >
                解绑任务
              </button>
            ) : null}
            <div
              className={[
                "rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1",
                isLoading
                  ? "bg-amber-500/10 text-amber-800 ring-amber-500/20"
                  : "bg-zinc-100 text-zinc-500 ring-zinc-200/80",
              ].join(" ")}
            >
              {isLoading ? "处理中" : "就绪"}
            </div>
          </div>
        </div>
      </header>

      <main
        className={[
          "mx-auto flex min-h-0 w-full flex-1 flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4",
          isMobile ? "max-w-md" : "max-w-6xl",
        ].join(" ")}
      >
        <div
          className={[
            "min-h-0 flex-1",
            isMobile ? "space-y-3" : "grid grid-cols-[300px_minmax(0,1fr)] gap-4",
          ].join(" ")}
        >
          <aside
            className={[
              "space-y-3",
              isMobile ? "" : "max-h-full overflow-y-auto pr-1",
            ].join(" ")}
          >
          {confirmRequest ? (
            <section className="rounded-2xl border border-amber-200/90 bg-amber-50/90 p-4 text-sm text-amber-950 shadow-sm ring-1 ring-amber-100/80">
              <div className="text-xs font-bold uppercase tracking-wide text-amber-800/90">需要确认</div>
              <div className="mt-2 whitespace-pre-wrap leading-relaxed">{confirmRequest.reason}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded-xl bg-zinc-900 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-zinc-800"
                  onClick={() => void onApprove()}
                >
                  确认执行
                </button>
                <button
                  className="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-zinc-800 ring-1 ring-zinc-200/90 transition hover:bg-zinc-50"
                  onClick={() => void onCancel()}
                >
                  取消任务
                </button>
              </div>
            </section>
          ) : null}
          {slidesRehearsalUrl ? (
            <section className="rounded-2xl border border-emerald-200/90 bg-emerald-50/90 p-4 text-sm text-emerald-950 shadow-sm ring-1 ring-emerald-100/80">
              <div className="text-xs font-bold uppercase tracking-wide text-emerald-800/90">飞书排练</div>
              <div className="mt-2 leading-relaxed text-emerald-900/90">演示稿已生成，可在飞书内放映或继续修改。</div>
              <div className="mt-3">
                <a
                  href={slidesRehearsalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-500"
                >
                  打开排练
                </a>
              </div>
            </section>
          ) : null}
          <TaskPanel tasks={tasks} activeTaskId={activeTaskId} />
          {feedbackEligibleTaskId && feedbackEligibleTaskId === effectiveTaskId ? (
            <section className="rounded-2xl border border-zinc-200/90 bg-white p-3 text-xs text-zinc-700 shadow-sm ring-1 ring-zinc-100/80">
              <div className="font-semibold text-zinc-800">本次任务结果是否有帮助？</div>
              <textarea
                value={feedbackNote}
                onChange={(e) => setFeedbackNote(e.target.value.slice(0, 500))}
                placeholder="附一句说明（可选，最多 500 字）"
                rows={2}
                disabled={feedbackSubmitting}
                className="mt-2 block w-full resize-y rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-800 outline-none transition focus:border-zinc-400"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {(["up", "down"] as const).map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    disabled={feedbackSubmitting}
                    className={
                      rating === "up"
                        ? "rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-60"
                        : "rounded-lg bg-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-800 transition hover:bg-zinc-300 disabled:opacity-60"
                    }
                    onClick={() =>
                      void (async () => {
                        const tid = feedbackEligibleTaskId;
                        if (!tid || feedbackSubmitting) return;
                        setFeedbackSubmitting(true);
                        try {
                          await fetch("/api/agent/feedback/rating", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                              taskId: tid,
                              conversationId,
                              rating,
                              note: feedbackNote,
                            }),
                          });
                          feedbackSubmittedTaskIdsRef.current.add(tid);
                        } finally {
                          setFeedbackSubmitting(false);
                          setFeedbackNote("");
                          setFeedbackEligibleTaskId(undefined);
                        }
                      })()
                    }
                  >
                    {rating === "up" ? "有用" : "需改进"}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {realtimeConfigured && conversationId ? <SharedMemo docId={conversationId} /> : null}
          </aside>

          <section
            className={[
              "flex min-h-[46dvh] flex-col rounded-2xl border border-zinc-200/70 bg-white/70 p-1 shadow-sm ring-1 ring-zinc-100/80 backdrop-blur-sm",
              isMobile ? "" : "min-h-0 h-full",
            ].join(" ")}
          >
          <div className="flex items-center justify-between px-3 pb-1 pt-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">对话</span>
            {effectiveTaskId ? (
              <span className="max-w-[55%] truncate font-mono text-[10px] text-zinc-400" title={effectiveTaskId}>
                {effectiveTaskId.length > 18 ? `${effectiveTaskId.slice(0, 14)}…` : effectiveTaskId}
              </span>
            ) : null}
          </div>
          <div
            className={[
              "space-y-1 px-3 pb-3 pt-1",
              isMobile ? "" : "min-h-0 flex-1 overflow-y-auto",
            ].join(" ")}
          >
            {messages.map((m) =>
              m.kind === "task_separator" ? (
                <TaskRunDivider key={m.id} label={typeof m.content === "string" ? m.content : undefined} />
              ) : (
                <Bubble key={m.id} role={m.role} message={m} />
              ),
            )}
            {isLoading ? (
              <Bubble
                role="assistant"
                message={{ id: makeId("m"), role: "assistant", kind: "text", content: "…" }}
              />
            ) : null}
            <div ref={bottomRef} />
          </div>
          </section>
        </div>
      </main>

      <footer className="sticky bottom-0 z-10 mt-auto border-t border-zinc-200/80 bg-white/90 backdrop-blur-md">
        <div
          className={[
            "mx-auto flex w-full max-w-full gap-2 px-4 py-3",
            isMobile ? "max-w-md" : "max-w-6xl",
          ].join(" ")}
        >
          <textarea
            className="min-h-[44px] max-h-32 flex-1 resize-none rounded-xl border border-zinc-200/90 bg-white px-3 py-2.5 text-sm text-zinc-900 shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            placeholder="输入消息 · Enter 发送 · Shift+Enter 换行"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            disabled={isLoading}
          />
          <button
            className={[
              "h-[44px] shrink-0 rounded-xl px-5 text-sm font-semibold shadow-sm transition",
              canSend
                ? "bg-indigo-600 text-white hover:bg-indigo-500"
                : "cursor-not-allowed bg-zinc-200 text-zinc-500",
            ].join(" ")}
            onClick={() => void onSend()}
            disabled={!canSend}
          >
            发送
          </button>
        </div>
      </footer>
    </div>
  );
}
