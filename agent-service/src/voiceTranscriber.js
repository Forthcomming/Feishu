function env(name, fallback) {
  const v = process.env[name];
  if (typeof v === "string" && v.length > 0) return v;
  return fallback;
}

function asString(v) {
  return typeof v === "string" ? v : "";
}

function parseMessageContent(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = asString(raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeText(raw) {
  return asString(raw).replace(/\s+/g, " ").trim();
}

function isAudioMessageType(messageType) {
  const t = asString(messageType).trim().toLowerCase();
  return t === "audio" || t === "voice";
}

function readTextFromObject(obj) {
  if (!obj || typeof obj !== "object") return "";
  const directKeys = ["text", "transcript", "recognized_text", "recognition_text", "asr_text"];
  for (const key of directKeys) {
    const value = normalizeText(obj[key]);
    if (value) return value;
  }
  if (obj.data && typeof obj.data === "object") {
    const nested = readTextFromObject(obj.data);
    if (nested) return nested;
  }
  if (obj.content && typeof obj.content === "object") {
    const nested = readTextFromObject(obj.content);
    if (nested) return nested;
  }
  return "";
}

function readFileKey(contentObj) {
  if (!contentObj || typeof contentObj !== "object") return "";
  const key = asString(contentObj.file_key || contentObj.fileKey || contentObj.audio_file_key || contentObj.audioFileKey).trim();
  if (key) return key;
  if (contentObj.audio && typeof contentObj.audio === "object") {
    return readFileKey(contentObj.audio);
  }
  return "";
}

async function transcribeByEndpoint({ fileKey, message, contentObj, fetchImpl }) {
  const transcribeUrl = env("FEISHU_VOICE_TRANSCRIBE_URL", "");
  if (!transcribeUrl) return { ok: false, text: "", reason: "transcribe_url_not_configured" };
  if (typeof fetchImpl !== "function") return { ok: false, text: "", reason: "fetch_unavailable" };

  const timeoutMsRaw = Number(env("FEISHU_VOICE_TIMEOUT_MS", "15000"));
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(3000, Math.floor(timeoutMsRaw)) : 15000;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }, timeoutMs)
    : null;

  try {
    const token = env("FEISHU_VOICE_TRANSCRIBE_TOKEN", "");
    const headers = { "content-type": "application/json; charset=utf-8" };
    if (token) headers.authorization = `Bearer ${token}`;
    const body = {
      file_key: fileKey,
      message_id: asString(message?.message_id || message?.messageId),
      chat_id: asString(message?.chat_id || message?.chatId),
      content: contentObj || {},
    };
    const resp = await fetchImpl(transcribeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    const payloadText = await resp.text();
    if (!resp.ok) return { ok: false, text: "", reason: `transcribe_http_${resp.status}` };
    let parsed = null;
    try {
      parsed = JSON.parse(payloadText);
    } catch {
      parsed = payloadText;
    }
    const text = typeof parsed === "string" ? normalizeText(parsed) : readTextFromObject(parsed);
    if (!text) return { ok: false, text: "", reason: "transcribe_empty_text" };
    return { ok: true, text, reason: "" };
  } catch (e) {
    return { ok: false, text: "", reason: e && e.name === "AbortError" ? "transcribe_timeout" : "transcribe_request_failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function transcribeFeishuAudioMessage(message, { fetchImpl = globalThis.fetch } = {}) {
  const rawMessage = message && typeof message === "object" ? message : {};
  const contentObj = parseMessageContent(rawMessage.content || rawMessage);
  const contentText = readTextFromObject(contentObj);
  if (contentText) return { ok: true, text: contentText, reason: "" };

  const enabled = env("FEISHU_VOICE_ENABLED", "false") === "true";
  if (!enabled) return { ok: false, text: "", reason: "voice_disabled" };

  const fileKey = readFileKey(contentObj);
  if (!fileKey) return { ok: false, text: "", reason: "audio_file_key_missing" };
  return transcribeByEndpoint({ fileKey, message: rawMessage, contentObj, fetchImpl });
}

module.exports = {
  isAudioMessageType,
  transcribeFeishuAudioMessage,
  parseMessageContent,
  readFileKey,
  readTextFromObject,
};
