"use client";

import { useEffect, useRef, useState } from "react";

import {
  emitBlocksUpdate,
  getSocket,
  onBlocksAck,
  onBlocksConflict,
  onBlocksUpdate,
  onDocSnapshot,
  type BlocksConflictPayload,
  type DocSnapshotPayload,
} from "@/lib/realtime/socket";

type MemoBlock = { id: string; type: "title" | "text" | "list"; content: string };

const MEMO_BLOCK_ID = "memo";
const FLUSH_DEBOUNCE_MS = 300;

function joinDocRoom(docId: string) {
  const s = getSocket();
  if (!s) return;
  s.emit("join", { docId });
}

function findMemo(blocks: MemoBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  const b = blocks.find((x) => x && x.id === MEMO_BLOCK_ID && x.type === "text");
  return b && typeof b.content === "string" ? b.content : "";
}

export function SharedMemo({ docId }: { docId: string }) {
  const [value, setValue] = useState<string>("");
  const [version, setVersion] = useState<number>(0);
  const [conflict, setConflict] = useState<{ serverContent: string; serverVersion: number } | null>(null);
  const localValueRef = useRef<string>("");
  const versionRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const lastSentRef = useRef<string>("");

  useEffect(() => {
    localValueRef.current = value;
  }, [value]);

  useEffect(() => {
    versionRef.current = version;
  }, [version]);

  useEffect(() => {
    if (!docId) return;
    joinDocRoom(docId);

    const offSnap = onDocSnapshot((p: DocSnapshotPayload) => {
      if (p.docId !== docId) return;
      const content = findMemo(p.blocks as MemoBlock[] | undefined);
      setValue(content);
      lastSentRef.current = content;
      setVersion(typeof p.blocksVersion === "number" ? p.blocksVersion : 0);
    });

    const offUpdate = onBlocksUpdate((p) => {
      if (p.docId !== docId) return;
      const content = findMemo(p.blocks as MemoBlock[] | undefined);
      setValue(content);
      lastSentRef.current = content;
      setVersion(typeof p.version === "number" ? p.version : versionRef.current);
    });

    const offAck = onBlocksAck((p) => {
      if (p.docId !== docId) return;
      setVersion(p.version);
    });

    const offConflict = onBlocksConflict((p: BlocksConflictPayload) => {
      if (p.docId !== docId) return;
      const serverContent = findMemo(p.serverBlocks as MemoBlock[] | undefined);
      setConflict({ serverContent, serverVersion: p.serverVersion });
    });

    return () => {
      offSnap();
      offUpdate();
      offAck();
      offConflict();
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [docId]);

  const flush = () => {
    const content = localValueRef.current;
    if (content === lastSentRef.current) return;
    lastSentRef.current = content;
    const block: MemoBlock = { id: MEMO_BLOCK_ID, type: "text", content };
    emitBlocksUpdate(docId, [block], versionRef.current);
  };

  const scheduleFlush = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flush();
    }, FLUSH_DEBOUNCE_MS);
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    scheduleFlush();
  };

  const acceptServer = () => {
    if (!conflict) return;
    setValue(conflict.serverContent);
    lastSentRef.current = conflict.serverContent;
    setVersion(conflict.serverVersion);
    setConflict(null);
  };

  const keepLocal = () => {
    if (!conflict) return;
    const content = localValueRef.current;
    lastSentRef.current = content;
    setVersion(conflict.serverVersion);
    const block: MemoBlock = { id: MEMO_BLOCK_ID, type: "text", content };
    emitBlocksUpdate(docId, [block], conflict.serverVersion);
    setConflict(null);
  };

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-zinc-700">共享备忘（多端协作）</div>
        <div className="text-[11px] text-zinc-400">v{version}</div>
      </div>
      {conflict ? (
        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <div className="font-semibold">内容撞车了（v{conflict.serverVersion}）</div>
          <div className="mt-1 whitespace-pre-wrap text-[11px] text-amber-800">
            对方当前：{conflict.serverContent || "（空）"}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-lg bg-zinc-900 px-2 py-1 text-[11px] font-semibold text-zinc-50 hover:bg-zinc-800"
              onClick={acceptServer}
            >
              采用对方
            </button>
            <button
              className="rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-zinc-900 ring-1 ring-zinc-200 hover:bg-zinc-50"
              onClick={keepLocal}
            >
              保留我方
            </button>
          </div>
        </div>
      ) : null}
      <textarea
        className="mt-2 block w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-300 focus:ring-2 focus:ring-zinc-200"
        rows={2}
        placeholder="两端可同时编辑，观察一致/冲突…"
        value={value}
        onChange={onChange}
        onBlur={flush}
      />
    </section>
  );
}
