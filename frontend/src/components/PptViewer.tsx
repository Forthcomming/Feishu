"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { Slide } from "@/lib/slideTypes";

export function PptViewer({
  title,
  slides,
  initialIndex = 0,
}: {
  title: string;
  slides: Slide[];
  initialIndex?: number;
}) {
  const safeSlides = slides.length > 0 ? slides : [{ id: "s_empty", title: "未命名", content: [] }];
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initialIndex), safeSlides.length - 1));
  const clampedIndex = Math.min(Math.max(0, index), safeSlides.length - 1);

  const canPrev = clampedIndex > 0;
  const canNext = clampedIndex < safeSlides.length - 1;

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setIndex((i) => Math.min(safeSlides.length - 1, i + 1)), [safeSlides.length]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goPrev, goNext]);

  const current = safeSlides[clampedIndex];
  const pageLabel = useMemo(
    () => `${clampedIndex + 1} / ${safeSlides.length}`,
    [clampedIndex, safeSlides.length],
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-900">PPT 预览</div>
          <div className="mt-1 truncate text-xs text-zinc-500">{title}</div>
        </div>
        <div className="shrink-0 text-xs font-semibold text-zinc-500 tabular-nums">{pageLabel}</div>
      </header>

      <main className="flex-1">
        <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
          <div className="text-lg font-semibold text-zinc-900">{current.title}</div>
          {current.content.length > 0 ? (
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-zinc-800">
              {current.content.map((t, i) => (
                <li key={`${current.id}_${i}`}>{t}</li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 text-sm text-zinc-500">（本页暂无内容）</div>
          )}
        </section>
      </main>

      <footer className="flex items-center justify-between gap-3">
        <button
          type="button"
          className={[
            "rounded-xl px-4 py-2 text-sm font-semibold shadow-sm ring-1",
            canPrev
              ? "bg-white text-zinc-900 ring-zinc-200 hover:bg-zinc-50"
              : "bg-zinc-100 text-zinc-400 ring-zinc-200 cursor-not-allowed",
          ].join(" ")}
          onClick={goPrev}
          disabled={!canPrev}
        >
          上一页
        </button>

        <div className="text-xs text-zinc-500">快捷键：← / →</div>

        <button
          type="button"
          className={[
            "rounded-xl px-4 py-2 text-sm font-semibold shadow-sm ring-1",
            canNext
              ? "bg-zinc-900 text-zinc-50 ring-zinc-900 hover:bg-zinc-800"
              : "bg-zinc-200 text-zinc-500 ring-zinc-200 cursor-not-allowed",
          ].join(" ")}
          onClick={goNext}
          disabled={!canNext}
        >
          下一页
        </button>
      </footer>
    </div>
  );
}

