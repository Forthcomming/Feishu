import { NextResponse } from "next/server";

import type { PptPreviewPayload } from "@/lib/docToSlides";
import { makeSlideId, type Slide } from "@/lib/slideTypes";

type ContextMessage = { role: "user" | "assistant"; content: string };

function normalizeLine(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function splitToItems(text: string) {
  return text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("- ") ? l.slice(2).trim() : l));
}

function buildSlidesFromItems(title: string, items: string[], maxItemsPerSlide: number): Slide[] {
  const safeTitle = normalizeLine(title) || "未命名";
  const max = maxItemsPerSlide > 0 ? maxItemsPerSlide : 5;

  if (items.length === 0) {
    return [{ id: makeSlideId(), title: safeTitle, content: ["（未提供上下文消息）"] }];
  }

  const slides: Slide[] = [];
  let page = 0;
  for (let i = 0; i < items.length; i += max) {
    page += 1;
    const suffix = page === 1 ? "" : "（续）";
    const chunk = items.slice(i, i + max).map(normalizeLine).filter(Boolean);
    slides.push({ id: makeSlideId(), title: `${safeTitle}${suffix}`, content: chunk });
  }
  return slides;
}

function pickKeyLines(contextMessages: ContextMessage[]) {
  const userLines = contextMessages
    .filter((m) => m.role === "user")
    .flatMap((m) => splitToItems(m.content))
    .map(normalizeLine)
    .filter(Boolean)
    .slice(-20);

  return userLines;
}

function extractTitleFromInstruction(instruction: string) {
  const t = normalizeLine(instruction);
  if (!t) return "评审PPT";
  // 取一句最像标题的短句：优先冒号前/首句，且限制长度
  const first = t.split(/[。！？\n]/g)[0]?.trim() ?? t;
  const head = first.includes("：") ? first.split("：")[0].trim() : first;
  const title = head.slice(0, 24);
  return title || "评审PPT";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as unknown;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const trigger = (body as { trigger?: unknown }).trigger;
    const contextMessages = (body as { contextMessages?: unknown }).contextMessages;
    const instruction = (body as { instruction?: unknown }).instruction;

    if (trigger !== "生成PPT") {
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

    const safeInstruction = typeof instruction === "string" ? instruction : "";
    const title = extractTitleFromInstruction(safeInstruction) || "评审PPT";

    const items = pickKeyLines(safeContext);
    const slides = buildSlidesFromItems(title, items, 5);

    const payload: PptPreviewPayload = { title, slides };
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

