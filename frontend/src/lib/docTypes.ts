export type DocBlock =
  | {
      type: "heading";
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      type: "paragraph";
      text: string;
    }
  | {
      type: "bullets";
      items: string[];
    }
  | {
      type: "numbered";
      items: string[];
    };

export type DocumentPayload = {
  title: string;
  blocks: DocBlock[];
};

