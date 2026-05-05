// In-memory workflow feedback (GUI / legacy POST /api/agent/workflow/feedback).
// For durable analytics use Redis via publishFeedbackEvent; this is for local dev & quick inspection.

const MAX_ITEMS = 1000;
const items = [];

function record(entry) {
  const e = {
    taskId: String(entry && entry.taskId ? entry.taskId : "").trim(),
    rating: entry && entry.rating === "down" ? "down" : "up",
    comment:
      typeof entry?.comment === "string" && entry.comment.length > 2000
        ? entry.comment.slice(0, 2000)
        : typeof entry?.comment === "string"
          ? entry.comment
          : "",
    at: typeof entry?.at === "number" && Number.isFinite(entry.at) ? entry.at : Date.now(),
  };
  if (!e.taskId) return;
  items.unshift(e);
  while (items.length > MAX_ITEMS) items.pop();
}

function listRecent(limit) {
  const n = Number(limit);
  const cap = Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : 20;
  return items.slice(0, cap);
}

module.exports = { record, listRecent };
