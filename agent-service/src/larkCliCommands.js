function assertString(name, v, { maxLen = 4000 } = {}) {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  const s = v.trim();
  if (!s) throw new Error(`${name} is required`);
  if (s.length > maxLen) throw new Error(`${name} is too long`);
  return s;
}

function assertEnum(name, v, allowed) {
  if (!allowed.includes(v)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return v;
}

function buildImMessagesSendArgs({ as, chatId, text, dryRun }) {
  const identity = assertEnum("as", as ?? "bot", ["bot", "user"]);
  const safeChatId = assertString("chatId", chatId, { maxLen: 128 });
  const safeText = assertString("text", text, { maxLen: 4000 });
  // Note: some lark-cli shortcut commands don't support --format; keep args minimal for compatibility.
  const args = ["im", "+messages-send", "--as", identity, "--chat-id", safeChatId, "--text", safeText];
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

function buildImMessagesListArgs({ as, chatId, limit }) {
  const identity = assertEnum("as", as ?? "bot", ["bot", "user"]);
  const safeChatId = assertString("chatId", chatId, { maxLen: 128 });
  const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20;
  // Keep args minimal; list should be read-only and safe by default.
  return ["im", "+messages-list", "--as", identity, "--chat-id", safeChatId, "--limit", String(safeLimit), "--format", "json"];
}

function escapeTitleForXml(title) {
  return title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildDocsCreateArgs({ as, title, markdown, apiVersion, dryRun }) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeTitle = assertString("title", title, { maxLen: 200 });
  const safeMarkdown = assertString("markdown", markdown, { maxLen: 60_000 });
  const version = typeof apiVersion === "string" && apiVersion.trim() ? apiVersion.trim() : "v2";

  const content = `<title>${escapeTitleForXml(safeTitle)}</title>\n${safeMarkdown}`;
  const args = [
    "docs",
    "+create",
    "--as",
    identity,
    "--api-version",
    version,
    "--doc-format",
    "markdown",
    "--content",
    content,
    "--format",
    "json",
  ];
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

function buildSlidesCreateArgs({ as, title, slidesXmlArray, dryRun }) {
  const identity = assertEnum("as", as ?? "bot", ["bot", "user"]);
  const safeTitle = assertString("title", title, { maxLen: 200 });
  const slides =
    Array.isArray(slidesXmlArray) && slidesXmlArray.length > 0
      ? slidesXmlArray.map((s) => assertString("slideXML", s, { maxLen: 60_000 }))
      : [];
  if (slides.length > 10) throw new Error("slidesXmlArray exceeds maximum of 10 slides for +create");

  // Compatibility: some lark-cli versions don't support `--format` for slides shortcuts.
  const args = ["slides", "+create", "--as", identity, "--title", safeTitle];
  if (slides.length > 0) args.push("--slides", JSON.stringify(slides));
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

module.exports = { buildImMessagesSendArgs, buildImMessagesListArgs, buildDocsCreateArgs, buildSlidesCreateArgs };

