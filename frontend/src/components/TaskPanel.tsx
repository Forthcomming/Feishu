import type { Task } from "@/lib/taskTypes";

function statusDotClass(status: Task["status"]) {
  switch (status) {
    case "pending":
      return "bg-zinc-300";
    case "running":
      return "bg-blue-500";
    case "done":
      return "bg-emerald-500";
    case "failed":
      return "bg-rose-500";
  }
}

export function TaskPanel({ tasks, activeTaskId }: { tasks: Task[]; activeTaskId?: string }) {
  if (tasks.length === 0) return null;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="text-xs font-semibold text-zinc-700">执行进度</div>
      <div className="mt-2 space-y-1">
        {tasks.map((t) => {
          const isActive = t.id === activeTaskId || t.status === "running";
          return (
            <div
              key={t.id}
              className={[
                "flex items-center justify-between rounded-xl px-2 py-2 text-sm",
                isActive ? "bg-blue-50 ring-1 ring-blue-100" : "bg-zinc-50",
              ].join(" ")}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className={["h-2.5 w-2.5 rounded-full", statusDotClass(t.status)].join(" ")} />
                <span className="truncate text-zinc-900">{t.title}</span>
              </div>
              <div className="shrink-0 text-xs text-zinc-500">
                {t.status === "done" ? <span className="text-emerald-600">✓</span> : null}
                {t.status === "failed" ? <span className="text-rose-600">!</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

