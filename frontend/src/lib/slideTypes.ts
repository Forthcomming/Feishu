export type Slide = {
  id: string;
  title: string;
  content: string[];
};

export function makeSlideId(prefix: string = "s") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

