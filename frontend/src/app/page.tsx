"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { DocumentRenderer } from "@/components/DocumentRenderer";
import type { DocumentPayload } from "@/lib/docTypes";
import { TaskPanel } from "@/components/TaskPanel";
import type { Task } from "@/lib/taskTypes";
import {
  joinTask,
  onTaskArtifact,
  onTaskConfirmRequired,
  onTaskError,
  onTaskSnapshot,
  onTaskState,
  onTaskStep,
  type TaskArtifactEvent,
  type TaskConfirmRequiredEvent,
  type TaskErrorEvent,
  type TaskSnapshotPayload,
  type TaskStateEvent,
  type TaskStepEvent,
} from "@/lib/realtime/socket";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  kind: "text" | "doc";
  content: string | DocumentPayload;
};

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
  const hasSlidesRef = /(?:https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9]+)|(?:slides\/[A-Za-z0-9]+)/.test(t);
  const wantsEdit = /(更新|修改|补充|替换|继续|第\s*\d+\s*页|页码\s*\d+)/.test(t);
  return t.includes("生成PPT") || t.includes("需求文档") || (hasDocRef && wantsEdit) || (hasSlidesRef && wantsEdit);
}

function Bubble({ role, message }: { role: ChatRole; message: ChatMessage }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[80%] rounded-2xl px-4 py-2 text-sm leading-6 shadow-sm",
          isUser
            ? "bg-zinc-900 text-zinc-50"
            : "bg-white text-zinc-900 ring-1 ring-zinc-200",
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
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const currentWorkflowTaskIdRef = useRef<string | null>(null);
  const seenArtifactIdsRef = useRef<Set<string>>(new Set());
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

  const realtimeConfigured = useMemo(() => Boolean(process.env.NEXT_PUBLIC_REALTIME_URL), []);

  useEffect(() => {
    currentWorkflowTaskIdRef.current = effectiveTaskId || null;
    if (effectiveTaskId && realtimeConfigured) joinTask(effectiveTaskId);
  }, [effectiveTaskId, realtimeConfigured]);

  // If the workflow is triggered from Feishu IM (webhook), the GUI may not know the taskId.
  // In that case, discover latest taskId by configured delivery chatId and auto-subscribe.
  useEffect(() => {
    if (effectiveTaskId) return;
    const conversationId = process.env.NEXT_PUBLIC_DELIVERY_CHAT_ID ?? "";
    if (!conversationId.trim()) return;

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
        if (cancelled) return;
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
  }, [effectiveTaskId, router, searchParams]);

  const canSend = useMemo(() => !isLoading && input.trim().length > 0, [input, isLoading]);

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
          task?: { steps?: Array<{ stepId: string; status: "pending" | "running" | "completed" | "failed" }>; state?: string };
          artifacts?: Array<{ artifactId?: string; kind: string; title: string; url: string }>;
          error?: string | null;
        };
        if (!payload.ok || !payload.task?.steps) return;
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
        if (payload.task.state === "completed" || payload.task.state === "failed" || payload.task.state === "cancelled") {
          setActiveTaskId(undefined);
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

  useEffect(() => {
    if (!realtimeConfigured) return () => {};
    const offTaskSnapshot = onTaskSnapshot((p: TaskSnapshotPayload) => {
      if (!currentWorkflowTaskIdRef.current || p.taskId !== currentWorkflowTaskIdRef.current) return;
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
      if (p.state === "completed" || p.state === "failed") setActiveTaskId(undefined);
      if (p.state === "completed" || p.state === "failed" || p.state === "cancelled") setConfirmRequest(null);
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
        override: { dryRun: false, identity: "bot" },
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
    setMessages((prev) => [...prev, userMsg]);
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
            conversationId: "demo_conversation",
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
          content: `已启动飞书PPT生成任务（${startedTaskId}），生成后可直接打开飞书排练。`,
        };
        setMessages((prev) => [...prev, aiMsg]);
        return;
      }

      if (isWorkflowKeyword(text)) {
        const deliveryChatId = process.env.NEXT_PUBLIC_DELIVERY_CHAT_ID ?? "";
        const workflowDryRun = process.env.NEXT_PUBLIC_WORKFLOW_DRY_RUN !== "false";
        const hasDocRef = /(?:https?:\/\/[^\s"']+\/docx\/[A-Za-z0-9]+)|(?:docx\/[A-Za-z0-9]+)/.test(text);
        const hasSlidesRef = /(?:https?:\/\/[^\s"']+\/slides\/[A-Za-z0-9]+)|(?:slides\/[A-Za-z0-9]+)/.test(text);
        const targetArtifacts = hasSlidesRef ? ["slides"] : hasDocRef ? ["doc"] : ["doc"];
        const resp = await fetch("/api/agent/workflow/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: "demo_conversation",
            input: text,
            contextRange: { mode: "recent_messages", limit: 20 },
            targetArtifacts,
            delivery: { channel: "im_chat", chatId: deliveryChatId },
            // Use bot for IM ack/delivery by default, but use user identity for docs.create to ensure you can view the doc.
            execution: { dryRun: workflowDryRun, defaultIdentity: "bot", docIdentity: "user" },
          }),
        });
        if (!resp.ok) {
          const msg = await resp.text().catch(() => "");
          throw new Error(msg || `Request failed: ${resp.status}`);
        }
        const payload = (await resp.json()) as {
          ok: boolean;
          task?: { taskId: string; state: string };
        };
        if (!payload.ok || !payload.task?.taskId) {
          throw new Error("workflow start 返回格式不正确");
        }
        const startedTaskId = payload.task.taskId;
        seenArtifactIdsRef.current.clear();

        // Sync to Feishu after we have the taskId, and avoid triggering webhook to create another task.
        // agent-service webhook ignores messages starting with this prefix.
        if (syncChatId) {
          void (async () => {
            const resp2 = await fetch("/api/im/messages-send", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                as: "user",
                chatId: syncChatId,
                text: `已收到指令，任务已启动：${startedTaskId}`,
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
          content: `任务已启动（${startedTaskId}），正在执行…`,
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
    <div className={["flex flex-1 flex-col bg-zinc-50", isMobile ? "min-h-dvh" : ""].join(" ")}>
      <header className="border-b border-zinc-200 bg-white">
        <div
          className={[
            "mx-auto flex w-full items-center justify-between px-4 py-3",
            isMobile ? "max-w-md" : "max-w-3xl",
          ].join(" ")}
        >
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-zinc-900">飞书 IM（Demo）</div>
            <span
              className={[
                "ml-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                isMobile ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100" : "bg-blue-50 text-blue-700 ring-1 ring-blue-100",
              ].join(" ")}
            >
              {isMobile ? "移动端" : "电脑端"}
            </span>
          </div>
          <div className="text-xs text-zinc-500">{isLoading ? "AI 正在输入…" : "就绪"}</div>
        </div>
      </header>

      <main
        className={[
          "mx-auto flex w-full flex-1 flex-col gap-3 overflow-auto px-4 py-4",
          isMobile ? "max-w-md" : "max-w-3xl",
        ].join(" ")}
      >
        {confirmRequest ? (
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 shadow-sm">
            <div className="font-semibold">需要确认</div>
            <div className="mt-1 whitespace-pre-wrap">{confirmRequest.reason}</div>
            <div className="mt-2 flex gap-2">
              <button
                className="rounded-xl bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-50 hover:bg-zinc-800"
                onClick={() => void onApprove()}
              >
                确认执行
              </button>
              <button
                className="rounded-xl bg-white px-3 py-2 text-xs font-semibold text-zinc-900 ring-1 ring-zinc-200 hover:bg-zinc-50"
                onClick={() => void onCancel()}
              >
                取消任务
              </button>
            </div>
          </section>
        ) : null}
        {slidesRehearsalUrl ? (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 shadow-sm">
            <div className="font-semibold">飞书排练入口</div>
            <div className="mt-1">演示稿已生成，可直接在飞书内放映/排练并继续修改。</div>
            <div className="mt-2">
              <a
                href={slidesRehearsalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600"
              >
                打开飞书PPT排练
              </a>
            </div>
          </section>
        ) : null}
        <TaskPanel tasks={tasks} activeTaskId={activeTaskId} />
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} message={m} />
        ))}
        {isLoading ? (
          <Bubble
            role="assistant"
            message={{ id: makeId("m"), role: "assistant", kind: "text", content: "…" }}
          />
        ) : null}
        <div ref={bottomRef} />
      </main>

      <footer className="border-t border-zinc-200 bg-white">
        <div
          className={[
            "mx-auto flex w-full gap-2 px-4 py-3",
            isMobile ? "max-w-md" : "max-w-3xl",
          ].join(" ")}
        >
          <textarea
            className="min-h-[44px] max-h-32 flex-1 resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none focus:border-zinc-300 focus:ring-2 focus:ring-zinc-200"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
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
              "h-[44px] shrink-0 rounded-xl px-4 text-sm font-semibold shadow-sm",
              canSend
                ? "bg-zinc-900 text-zinc-50 hover:bg-zinc-800"
                : "bg-zinc-200 text-zinc-500 cursor-not-allowed",
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
