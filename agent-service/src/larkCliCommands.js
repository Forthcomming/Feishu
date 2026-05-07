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

const V2_UPDATE_COMMANDS = new Set([
  "block_delete",
  "block_insert_after",
  "block_copy_insert_after",
  "block_replace",
  "block_move_after",
  "append",
]);

function normalizeUpdateMarkdownForCommand(markdown, cmd) {
  if (typeof markdown !== "string") throw new Error("markdown must be a string");
  if (cmd === "str_replace") {
    if (markdown.length > 60_000) throw new Error("markdown is too long");
    return markdown;
  }
  const s = markdown.trim();
  if (!s) throw new Error("markdown is required");
  if (s.length > 60_000) throw new Error("markdown is too long");
  return markdown;
}

function buildDocsUpdateArgs({
  as,
  doc,
  markdown,
  mode,
  apiVersion,
  dryRun,
  newTitle,
  command: explicitCommand,
  pattern,
  blockId,
  docFormat,
  revisionId,
  srcBlockIds,
}) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeDoc = assertString("doc", doc, { maxLen: 512 });
  const safeMode =
    typeof mode === "string" && mode.trim()
      ? assertEnum("mode", mode.trim(), ["append"])
      : "append";
  const version = typeof apiVersion === "string" && apiVersion.trim() ? apiVersion.trim() : "v2";

  let cmd =
    typeof explicitCommand === "string" && explicitCommand.trim()
      ? assertEnum("command", explicitCommand.trim(), Array.from(V2_UPDATE_COMMANDS))
      : null;

  if (!cmd) {
    cmd = "append";
  }

  const args = ["docs", "+update", "--as", identity, "--api-version", version, "--doc", safeDoc];

  if (version === "v1") {
    const safeMarkdown = assertString("markdown", markdown, { maxLen: 60_000 });
    args.push("--mode", safeMode, "--markdown", safeMarkdown);
    if (typeof newTitle === "string" && newTitle.trim()) args.push("--new-title", newTitle.trim());
    if (dryRun !== false) args.push("--dry-run");
    return args;
  }

  args.push("--command", cmd);

  if (typeof revisionId === "number" && Number.isFinite(revisionId) && revisionId !== -1) {
    args.push("--revision-id", String(Math.floor(revisionId)));
  }

  if (cmd === "block_delete") {
    const bid =
      typeof blockId === "string" && blockId.trim()
        ? blockId.trim()
        : (() => {
            throw new Error("blockId is required for block_delete");
          })();
    if (bid.length > 200) throw new Error("blockId is too long");
    args.push("--block-id", bid);
  } else if (cmd === "block_insert_after" || cmd === "block_replace") {
    const bid =
      typeof blockId === "string" && blockId.trim()
        ? blockId.trim()
        : (() => {
            throw new Error("blockId is required for " + cmd);
          })();
    if (bid.length > 200) throw new Error("blockId is too long");
    args.push("--block-id", bid);
    const fmt =
      typeof docFormat === "string" && docFormat.trim()
        ? assertEnum("docFormat", docFormat.trim(), ["xml", "markdown"])
        : "markdown";
    args.push("--doc-format", fmt);
    normalizeUpdateMarkdownForCommand(typeof markdown === "string" ? markdown : "", cmd);
    args.push("--content", "-");
  } else if (cmd === "block_copy_insert_after" || cmd === "block_move_after") {
    const bid =
      typeof blockId === "string" && blockId.trim()
        ? blockId.trim()
        : (() => {
            throw new Error("blockId is required for " + cmd);
          })();
    args.push("--block-id", bid);
    const src =
      typeof srcBlockIds === "string" && srcBlockIds.trim()
        ? srcBlockIds.trim()
        : (() => {
            throw new Error("srcBlockIds is required for " + cmd);
          })();
    args.push("--src-block-ids", src);
  } else if (cmd === "append") {
    const fmt =
      typeof docFormat === "string" && docFormat.trim()
        ? assertEnum("docFormat", docFormat.trim(), ["xml", "markdown"])
        : "markdown";
    args.push("--doc-format", fmt);
    normalizeUpdateMarkdownForCommand(typeof markdown === "string" ? markdown : "", cmd);
    args.push("--content", "-");
  }

  if (typeof newTitle === "string" && newTitle.trim()) args.push("--new-title", newTitle.trim());
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

function buildDocsFetchArgs({
  as,
  doc,
  apiVersion,
  detail,
  scope,
  keyword,
  docFormat,
  contextBefore,
  contextAfter,
  startBlockId,
  endBlockId,
  maxDepth,
  revisionId,
  dryRun,
}) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeDoc = assertString("doc", doc, { maxLen: 512 });
  const version = typeof apiVersion === "string" && apiVersion.trim() ? apiVersion.trim() : "v2";
  const args = ["docs", "+fetch", "--as", identity, "--api-version", version, "--doc", safeDoc];

  if (version === "v2") {
    const d = detail && String(detail).trim() ? String(detail).trim() : "simple";
    assertEnum("detail", d, ["simple", "with-ids", "full"]);
    args.push("--detail", d);

    const df = docFormat && String(docFormat).trim() ? String(docFormat).trim() : "xml";
    assertEnum("docFormat", df, ["xml", "markdown", "text"]);
    args.push("--doc-format", df);

    const sc = scope && String(scope).trim() ? String(scope).trim() : "full";
    assertEnum("scope", sc, ["full", "outline", "range", "keyword", "section"]);
    args.push("--scope", sc);

    if (typeof revisionId === "number" && Number.isFinite(revisionId)) {
      args.push("--revision-id", String(Math.floor(revisionId)));
    }
    if (typeof keyword === "string" && keyword.trim()) {
      args.push("--keyword", keyword.trim());
    }
    if (typeof contextBefore === "number" && Number.isFinite(contextBefore)) {
      args.push("--context-before", String(Math.floor(contextBefore)));
    }
    if (typeof contextAfter === "number" && Number.isFinite(contextAfter)) {
      args.push("--context-after", String(Math.floor(contextAfter)));
    }
    if (typeof startBlockId === "string" && startBlockId.trim()) {
      args.push("--start-block-id", startBlockId.trim());
    }
    if (typeof endBlockId === "string" && endBlockId.trim()) {
      args.push("--end-block-id", endBlockId.trim());
    }
    if (typeof maxDepth === "number" && Number.isFinite(maxDepth)) {
      args.push("--max-depth", String(Math.floor(maxDepth)));
    }
  }

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

function buildSlidesXmlPresentationSlideGetArgs({ as, xmlPresentationId, slideId, dryRun }) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeXmlId = assertString("xmlPresentationId", xmlPresentationId, { maxLen: 128 });
  const safeSlideId = assertString("slideId", slideId, { maxLen: 128 });
  const args = [
    "slides",
    "xml_presentation.slide",
    "get",
    "--as",
    identity,
    "--params",
    JSON.stringify({ xml_presentation_id: safeXmlId, slide_id: safeSlideId }),
  ];
  if (dryRun !== false) args.push("--dry-run");
  return args;
}

function buildSlidesXmlPresentationSlideReplaceArgs({ as, xmlPresentationId, slideId, dryRun }) {
  const identity = assertEnum("as", as ?? "user", ["bot", "user"]);
  const safeXmlId = assertString("xmlPresentationId", xmlPresentationId, { maxLen: 128 });
  const safeSlideId = assertString("slideId", slideId, { maxLen: 128 });
  const args = [
    "slides",
    "xml_presentation.slide",
    "replace",
    "--as",
    identity,
    "--params",
    JSON.stringify({ xml_presentation_id: safeXmlId, slide_id: safeSlideId }),
    "--data",
    "-",
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
  buildDocsFetchArgs,
  buildSlidesCreateArgs,
  buildSlidesXmlPresentationsGetArgs,
  buildSlidesXmlPresentationSlideDeleteArgs,
  buildSlidesXmlPresentationSlideGetArgs,
  buildSlidesXmlPresentationSlideReplaceArgs,
};

