import { NextResponse } from "next/server";

import type { DocumentPayload } from "@/lib/docTypes";

type ContextMessage = { role: "user" | "assistant"; content: string };

function pickHighlights(contextMessages: ContextMessage[]) {
  const userLines = contextMessages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean)
    .slice(-5);

  if (userLines.length === 0) {
    return ["（未提供上下文消息）"];
  }
  return userLines;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as unknown;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const trigger = (body as { trigger?: unknown }).trigger;
    const contextMessages = (body as { contextMessages?: unknown }).contextMessages;

    if (trigger !== "生成文档") {
      return NextResponse.json({ error: "Unsupported trigger" }, { status: 400 });
    }

    const safeContext: ContextMessage[] = Array.isArray(contextMessages)
      ? (contextMessages as ContextMessage[]).filter(
          (m) =>
            m &&
            typeof m === "object" &&
            (m as ContextMessage).role &&
            ((m as ContextMessage).role === "user" || (m as ContextMessage).role === "assistant") &&
            typeof (m as ContextMessage).content === "string",
        )
      : [];

    const highlights = pickHighlights(safeContext);

    const payload: DocumentPayload = {
      title: "结构化文档（示例）",
      blocks: [
        { type: "heading", level: 2, text: "摘要" },
        {
          type: "paragraph",
          text: "根据最近的聊天内容，自动整理得到以下要点（当前为后端 stub，后续可替换为真实生成逻辑）。",
        },
        { type: "heading", level: 2, text: "关键信息" },
        { type: "bullets", items: highlights },
        { type: "heading", level: 2, text: "下一步" },
        { type: "numbered", items: ["补充缺失背景与目标", "确认产出结构（章节/块类型）", "对接真实 LLM/工作流"] },
      ],
    };

    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

