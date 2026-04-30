export type Block = {
  id: string;
  type: "title" | "text" | "list";
  content: string;
};

export function makeBlockId(prefix: string = "b") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

export function parseList(content: string) {
  return content
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("- ") ? l.slice(2).trim() : l));
}

