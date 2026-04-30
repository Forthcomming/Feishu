import type { DocBlock, DocumentPayload } from "@/lib/docTypes";
import { makeSlideId, type Slide } from "@/lib/slideTypes";

export type DocToSlidesOptions = {
  maxItemsPerSlide?: number;
};

function normalizeLine(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function ensureSlide(
  slides: Slide[],
  title: string,
  titleSuffix: string | undefined,
): Slide {
  const nextTitle = titleSuffix ? `${title}${titleSuffix}` : title;
  const s: Slide = { id: makeSlideId(), title: nextTitle, content: [] };
  slides.push(s);
  return s;
}

export function docBlocksToSlides(
  blocks: DocBlock[],
  opts: DocToSlidesOptions = {},
  fallbackTitle: string = "未命名",
): Slide[] {
  const maxItemsPerSlide = opts.maxItemsPerSlide ?? 5;
  const slides: Slide[] = [];

  let currentTitle = fallbackTitle;
  let current = ensureSlide(slides, currentTitle, undefined);

  const pushItem = (raw: string) => {
    const item = normalizeLine(raw);
    if (!item) return;

    if (maxItemsPerSlide > 0 && current.content.length >= maxItemsPerSlide) {
      current = ensureSlide(slides, currentTitle, "（续）");
    }
    current.content.push(item);
  };

  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;

    switch (b.type) {
      case "heading": {
        const t = normalizeLine(b.text);
        if (!t) break;
        currentTitle = t;
        current = ensureSlide(slides, currentTitle, undefined);
        break;
      }
      case "paragraph":
        pushItem(b.text);
        break;
      case "bullets":
      case "numbered":
        for (const it of b.items) pushItem(it);
        break;
    }
  }

  // 如果第一张 slide 只是占位且没有内容，但后续有 slide，则移除占位页
  if (slides.length > 1 && slides[0].title === fallbackTitle && slides[0].content.length === 0) {
    slides.shift();
  }

  // 兜底：确保至少一页
  if (slides.length === 0) {
    return [{ id: makeSlideId(), title: fallbackTitle, content: [] }];
  }

  return slides;
}

export type PptPreviewPayload = {
  title: string;
  slides: Slide[];
};

export function documentToPptPreviewPayload(
  doc: DocumentPayload,
  opts: DocToSlidesOptions = {},
): PptPreviewPayload {
  const title = normalizeLine(doc.title) || "未命名";
  const slides = docBlocksToSlides(doc.blocks, opts, title);
  return { title, slides };
}

