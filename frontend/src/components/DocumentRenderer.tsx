import type { DocBlock, DocumentPayload } from "@/lib/docTypes";

function renderBlock(block: DocBlock, idx: number) {
  switch (block.type) {
    case "heading": {
      const cls =
        block.level === 1
          ? "text-base font-semibold"
          : block.level === 2
            ? "text-sm font-semibold"
            : "text-sm font-medium";
      return (
        <div key={idx} className={cls}>
          {block.text}
        </div>
      );
    }
    case "paragraph":
      return (
        <p key={idx} className="text-sm leading-6 text-zinc-800">
          {block.text}
        </p>
      );
    case "bullets":
      return (
        <ul key={idx} className="list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-800">
          {block.items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      );
    case "numbered":
      return (
        <ol key={idx} className="list-decimal space-y-1 pl-5 text-sm leading-6 text-zinc-800">
          {block.items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      );
  }
}

export function DocumentRenderer({ payload }: { payload: DocumentPayload }) {
  return (
    <article className="space-y-3">
      <div className="text-sm font-semibold text-zinc-900">{payload.title}</div>
      <div className="space-y-3">{payload.blocks.map(renderBlock)}</div>
    </article>
  );
}

