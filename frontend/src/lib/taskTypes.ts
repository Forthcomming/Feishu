export type Task = {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
};

