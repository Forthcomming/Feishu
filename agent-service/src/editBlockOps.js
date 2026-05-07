const UPDATE_BLOCK = "UPDATE_BLOCK";
const DELETE_BLOCK = "DELETE_BLOCK";
const INSERT_BLOCK = "INSERT_BLOCK";

const BLOCK_OPS = new Set([UPDATE_BLOCK, DELETE_BLOCK, INSERT_BLOCK]);

function toBlockOp(op) {
  const raw = String(op || "").trim();
  if (BLOCK_OPS.has(raw)) return raw;
  const s = raw.toLowerCase();
  if (s === "delete") return DELETE_BLOCK;
  if (s === "insert_after" || s === "insert") return INSERT_BLOCK;
  if (s === "replace" || s === "rewrite_style" || s === "condense" || s === "update") return UPDATE_BLOCK;
  return UPDATE_BLOCK;
}

module.exports = {
  UPDATE_BLOCK,
  DELETE_BLOCK,
  INSERT_BLOCK,
  BLOCK_OPS,
  toBlockOp,
};
