"use client";

import Link from "next/link";
import { useState } from "react";

import { PptViewer } from "@/components/PptViewer";
import type { PptPreviewPayload } from "@/lib/docToSlides";

const STORAGE_KEY = "ppt_preview_v1";

export default function PptPage() {
  const [{ payload, error }] = useState<{ payload: PptPreviewPayload | null; error: string | null }>(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { payload: null, error: "未找到可预览的 PPT 数据。请回到聊天页输入“生成PPT”。" };
      }
      const parsed = JSON.parse(raw) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as { title?: unknown }).title !== "string" ||
        !Array.isArray((parsed as { slides?: unknown }).slides)
      ) {
        return { payload: null, error: "PPT 数据格式不正确。请重新生成。" };
      }
      return { payload: parsed as PptPreviewPayload, error: null };
    } catch (e) {
      return { payload: null, error: e instanceof Error ? e.message : "解析失败" };
    }
  });

  if (error) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-50">
        <header className="border-b border-zinc-200 bg-white">
          <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 py-3">
            <div className="text-sm font-semibold text-zinc-900">PPT 预览</div>
            <Link
              href="/"
              className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50"
            >
              返回聊天
            </Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10">
          <div className="rounded-2xl bg-white p-6 text-sm text-zinc-700 shadow-sm ring-1 ring-zinc-200">
            {error}
          </div>
        </main>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        正在加载…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 py-3">
          <div className="text-sm font-semibold text-zinc-900">PPT 预览</div>
          <Link
            href="/"
            className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50"
          >
            返回聊天
          </Link>
        </div>
      </header>

      <PptViewer title={payload.title} slides={payload.slides} />
    </div>
  );
}

