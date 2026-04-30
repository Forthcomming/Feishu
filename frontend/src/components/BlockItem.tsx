"use client";

import { memo, useCallback } from "react";

import type { Block } from "@/lib/blocks";
import { parseList } from "@/lib/blocks";

type InsertType = Block["type"];

export const BlockItem = memo(function BlockItem({
  block,
  index,
  onChange,
  onDelete,
  onInsert,
}: {
  block: Block;
  index: number;
  onChange: (id: string, nextContent: string) => void;
  onDelete: (id: string) => void;
  onInsert: (atIndex: number, type: InsertType) => void;
}) {
  const inputId = `block_${block.id}`;
  const isTitle = block.type === "title";
  const isList = block.type === "list";

  const onChangeContent = useCallback(
    (next: string) => onChange(block.id, next),
    [block.id, onChange],
  );

  return (
    <section className="group rounded-xl border border-transparent px-2 py-2 hover:border-zinc-200 hover:bg-white">
      <div className="flex items-start gap-2">
        <div className="w-8 shrink-0 pt-2 text-right text-xs text-zinc-400 tabular-nums">
          {index + 1}
        </div>

        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="sr-only">
            {block.type}
          </label>

          {isTitle ? (
            <input
              id={inputId}
              className="w-full rounded-lg bg-transparent px-2 py-2 text-lg font-semibold text-zinc-900 outline-none focus:bg-zinc-50 focus:ring-2 focus:ring-zinc-200"
              value={block.content}
              onChange={(e) => onChangeContent(e.target.value)}
              placeholder="标题…"
            />
          ) : (
            <textarea
              id={inputId}
              className="w-full resize-none rounded-lg bg-transparent px-2 py-2 text-sm leading-6 text-zinc-900 outline-none focus:bg-zinc-50 focus:ring-2 focus:ring-zinc-200"
              value={block.content}
              onChange={(e) => onChangeContent(e.target.value)}
              placeholder={isList ? "列表（每行一条，可用 - 开头）…" : "正文…"}
              rows={isList ? 4 : 3}
            />
          )}

          {isList ? (
            <ul className="mt-1 list-disc space-y-1 pl-6 text-sm leading-6 text-zinc-800">
              {parseList(block.content).map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <button
          className="mt-2 shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          type="button"
          onClick={() => onDelete(block.id)}
        >
          删除
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2 pl-10">
        <span className="text-xs text-zinc-400">插入</span>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"
          onClick={() => onInsert(index, "text")}
        >
          上方文本
        </button>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"
          onClick={() => onInsert(index + 1, "text")}
        >
          下方文本
        </button>
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"
          onClick={() => onInsert(index + 1, "list")}
        >
          下方列表
        </button>
      </div>
    </section>
  );
},
// 关键：只要 block 引用不变，就不重渲染该项（实现“局部更新”）。
(prev, next) => prev.block === next.block && prev.index === next.index);

