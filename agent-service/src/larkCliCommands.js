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
  // Compatibility: lark-cli v1.0.x uses `im +chat-messages-list` with `--page-size`.
  // Keep args minimal; list should be read-only and safe by default.
  return ["im", "+chat-messages-list", "--as", identity, "--chat-id", safeChatId, "--page-size", String(safeLimit), "--format", "json"];
}

function buildDocsCreateArgs({ as, title, markdown, apiVersion, dryRun }) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeTitle = assertString("title", title, { maxLen: 200 });
  const safeMarkdown = assertString("markdown", markdown, { maxLen: 60_000 });
  // Default to v2 to avoid v1 deprecation/edge cases on some CLI versions.
  const version = typeof apiVersion === "string" && apiVersion.trim() ? apiVersion.trim() : "v2";

  // lark-cli contract differs by api-version:
  // - v2: expects --content + --doc-format (xml|markdown)
  // - v1: expects --title + --markdown
  // Ensure markdown starts with heading for readability.
  const markdownArg = safeMarkdown.startsWith("#") ? safeMarkdown : `# ${safeTitle}\n\n${safeMarkdown}`;

  const args = ["docs", "+create", "--as", identity, "--api-version", version];
  if (version === "v1") {
    args.push("--title", safeTitle, "--markdown", markdownArg);
  } else {
    // Prefer markdown for v2 (content supports @file, - for stdin via lark-cli itself).
    args.push("--doc-format", "markdown", "--content", "-");
  }
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

function buildDocsUpdateArgs({ as, doc, markdown, mode, apiVersion, dryRun, newTitle }) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeDoc = assertString("doc", doc, { maxLen: 512 });
  const safeMarkdown = assertString("markdown", markdown, { maxLen: 60_000 });
  const safeMode =
    typeof mode === "string" && mode.trim()
      ? assertEnum("mode", mode.trim(), ["append", "overwrite"])
      : "append";
  const version = typeof apiVersion === "string" && apiVersion.trim() ? apiVersion.trim() : "v2";

  // v2 update contract: --command + --content + --doc-format
  // Keep signature `mode` for callers; map to v2 `command`.
  const command = safeMode === "overwrite" ? "overwrite" : "append";
  const args = ["docs", "+update", "--as", identity, "--api-version", version, "--doc", safeDoc];
  if (version === "v1") {
    // Fallback: keep old v1 flags for compatibility when explicitly requested.
    args.push("--mode", safeMode, "--markdown", safeMarkdown);
  } else {
    args.push("--command", command, "--doc-format", "markdown", "--content", "-");
  }
  if (typeof newTitle === "string" && newTitle.trim()) args.push("--new-title", newTitle.trim());
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

function buildSlidesXmlPresentationsGetArgs({ as, xmlPresentationId, dryRun }) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeId = assertString("xmlPresentationId", xmlPresentationId, { maxLen: 128 });
  // Native API call. Keep args minimal (some cli builds don't support --format on native calls).
  const args = [
    "slides",
    "xml_presentations",
    "get",
    "--as",
    identity,
    "--params",
    JSON.stringify({ xml_presentation_id: safeId }),
  ];
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

function buildSlidesXmlPresentationSlideDeleteArgs({ as, xmlPresentationId, slideId, dryRun }) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeXmlId = assertString("xmlPresentationId", xmlPresentationId, { maxLen: 128 });
  const safeSlideId = assertString("slideId", slideId, { maxLen: 128 });
  const args = [
    "slides",
    "xml_presentation.slide",
    "delete",
    "--as",
    identity,
    "--params",
    JSON.stringify({ xml_presentation_id: safeXmlId, slide_id: safeSlideId }),
    "--yes",
  ];
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

module.exports = {
  buildImMessagesSendArgs,
  buildImMessagesListArgs,
  buildDocsCreateArgs,
  buildDocsUpdateArgs,
  buildSlidesCreateArgs,
  buildSlidesXmlPresentationsGetArgs,
  buildSlidesXmlPresentationSlideDeleteArgs,
};

