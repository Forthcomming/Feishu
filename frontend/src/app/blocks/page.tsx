"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { BlockItem } from "@/components/BlockItem";
import type { Block } from "@/lib/blocks";
import { makeBlockId } from "@/lib/blocks";
import {
  emitBlocksUpdate,
  joinDoc,
  onBlocksUpdate,
  onSnapshot,
  type BlocksUpdatePayload,
  type SnapshotPayload,
} from "@/lib/realtime/socket";

function makeMockBlocks(): Block[] {
  return [
    // 注意：mock 数据必须是确定性的，避免 SSR/CSR 生成不同 id 导致 hydration mismatch
    { id: "b_mock_1", type: "title", content: "需求评审：IM Agent（Demo）" },
    { id: "b_mock_2", type: "text", content: "目标：实现基于 Blocks JSON 的文档渲染与局部编辑能力。" },
    {
      id: "b_mock_3",
      type: "list",
      content: ["- 渲染 blocks[]（类似 Notion）", "- 支持增删改", "- 修改一个 block 不影响其它 block"].join("\n"),
    },
    {
      id: "b_mock_4",
      type: "text",
      content: "说明：list 类型使用多行文本作为 content，每行一条；渲染侧会实时预览为 bullet list。",
    },
    { id: "b_mock_5", type: "text", content: "你可以点击任意 block 直接编辑，或在任意位置插入新 block。" },
  ];
}

export default function BlocksPage() {
  const searchParams = useSearchParams();
  const device = searchParams.get("device");
  const isMobile = device === "mobile";
  const [blocks, setBlocks] = useState<Block[]>(() => makeMockBlocks());
  const lastServerTsRef = useRef(0);
  const docId = "demo";

  useEffect(() => {
    joinDoc(docId);

    const offSnapshot = onSnapshot((p: SnapshotPayload) => {
      if (p.docId !== docId) return;
      if (p.serverTs < lastServerTsRef.current) return;
      lastServerTsRef.current = p.serverTs;
      if (Array.isArray(p.blocks) && p.blocks.length > 0) setBlocks(p.blocks);
    });

    const offBlocksUpdate = onBlocksUpdate((p: BlocksUpdatePayload) => {
      if (p.docId !== docId) return;
      if (p.serverTs < lastServerTsRef.current) return;
      lastServerTsRef.current = p.serverTs;
      setBlocks(p.blocks);
    });

    return () => {
      offSnapshot();
      offBlocksUpdate();
    };
  }, []);

  const onChange = useCallback((id: string, nextContent: string) => {
    setBlocks((prev) => {
      const next = prev.map((b) => (b.id === id ? { ...b, content: nextContent } : b));
      emitBlocksUpdate(docId, next);
      return next;
    });
  }, [docId]);

  const onDelete = useCallback((id: string) => {
    setBlocks((prev) => {
      const next = prev.filter((b) => b.id !== id);
      emitBlocksUpdate(docId, next);
      return next;
    });
  }, [docId]);

  const onInsert = useCallback((atIndex: number, type: Block["type"]) => {
    const newBlock: Block = {
      id: makeBlockId(),
      type,
      content: type === "title" ? "新标题" : type === "list" ? "- 项目 1\n- 项目 2" : "新段落",
    };
    setBlocks((prev) => {
      const next = [...prev.slice(0, atIndex), newBlock, ...prev.slice(atIndex)];
      emitBlocksUpdate(docId, next);
      return next;
    });
  }, [docId]);

  const hasTitle = useMemo(() => blocks.some((b) => b.type === "title"), [blocks]);

  return (
    <div className={["mx-auto w-full px-4 py-6", isMobile ? "max-w-md" : "max-w-3xl"].join(" ")}>
      <header className="mb-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-900">Blocks 文档（Demo）</div>
          <div className="mt-1 text-xs text-zinc-500">
            {hasTitle ? "支持 title/text/list；输入即保存；局部更新" : "建议至少保留一个 title block"}
          </div>
          <div
            className={[
              "mt-2 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
              isMobile ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100" : "bg-blue-50 text-blue-700 ring-1 ring-blue-100",
            ].join(" ")}
          >
            {isMobile ? "移动端" : "电脑端"}
          </div>
        </div>
        <div className={["flex items-center gap-2", isMobile ? "flex-col items-stretch" : ""].join(" ")}>
          <button
            type="button"
            className={[
              "rounded-xl bg-white text-xs font-semibold text-zinc-900 ring-1 ring-zinc-200 hover:bg-zinc-50",
              isMobile ? "px-3 py-2.5" : "px-3 py-2",
            ].join(" ")}
            onClick={() => onInsert(0, "title")}
          >
            顶部插入标题
          </button>
          <button
            type="button"
            className={[
              "rounded-xl bg-zinc-900 text-xs font-semibold text-zinc-50 hover:bg-zinc-800",
              isMobile ? "px-3 py-2.5" : "px-3 py-2",
            ].join(" ")}
            onClick={() => onInsert(blocks.length, "text")}
          >
            末尾新增文本
          </button>
        </div>
      </header>

      <main className="space-y-2">
        {blocks.map((b, idx) => (
          <BlockItem
            key={b.id}
            block={b}
            index={idx}
            onChange={onChange}
            onDelete={onDelete}
            onInsert={onInsert}
          />
        ))}
      </main>
    </div>
  );
}

