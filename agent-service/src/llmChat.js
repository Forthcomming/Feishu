function envOptional(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function parseBoolEnv(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return null;
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return null;
}

function resolveProvider() {
  const explicit = envOptional("LLM_PROVIDER");
  if (explicit) return explicit.trim().toLowerCase();
  const hasDoubao = Boolean(envOptional("DOUBAO_API_KEY") && envOptional("DOUBAO_ENDPOINT_ID"));
  const hasDeepSeek = Boolean(envOptional("DEEPSEEK_API_KEY"));
  if (hasDeepSeek && !hasDoubao) return "deepseek";
  if (hasDoubao) return "doubao";
  if (hasDeepSeek) return "deepseek";
  return "";
}

function buildConfig({ purpose }) {
  const provider = resolveProvider();
  if (provider === "doubao") {
    const apiKey = envOptional("DOUBAO_API_KEY");
    const baseUrl = envOptional("DOUBAO_BASE_URL") ?? "https://ark.cn-beijing.volces.com/api/v3";
    let model = envOptional("DOUBAO_ENDPOINT_ID");
    if (purpose === "content") {
      model = envOptional("DOUBAO_CONTENT_ENDPOINT_ID") ?? envOptional("DOUBAO_ENDPOINT_ID");
    } else if (purpose === "edit_intent") {
      model = envOptional("DOUBAO_EDIT_INTENT_ENDPOINT_ID") ?? envOptional("DOUBAO_ENDPOINT_ID");
    }
    if (!apiKey || !model) throw new Error("LLM is required: missing DOUBAO_API_KEY or DOUBAO_ENDPOINT_ID");
    return { provider, apiKey, baseUrl, model };
  }

  if (provider === "deepseek") {
    const apiKey = envOptional("DEEPSEEK_API_KEY");
    const baseUrl = envOptional("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com";
    let model = envOptional("DEEPSEEK_MODEL") ?? "deepseek-v4-flash";
    if (purpose === "edit_intent") {
      model = envOptional("DEEPSEEK_EDIT_INTENT_MODEL") ?? model;
    }
    if (!apiKey) throw new Error("LLM is required: missing DEEPSEEK_API_KEY");
    return { provider, apiKey, baseUrl, model };
  }

  throw new Error("LLM is required: missing LLM_PROVIDER/DOUBAO/DEEPSEEK env");
}

async function callChatCompletions({ system, user, temperature, timeoutMs, purpose }) {
  const cfg = buildConfig({ purpose });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const maxAttempts = Math.max(1, Math.min(4, Number(envOptional("LLM_RETRY_MAX_ATTEMPTS") ?? envOptional("DOUBAO_RETRY_MAX_ATTEMPTS") ?? "3")));
  const baseDelayMs = Math.max(200, Math.min(20_000, Number(envOptional("LLM_RETRY_BASE_DELAY_MS") ?? envOptional("DOUBAO_RETRY_BASE_DELAY_MS") ?? "800")));
  const enableRetry = parseBoolEnv(envOptional("LLM_RETRY_ENABLED")) ?? true;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: typeof temperature === "number" ? temperature : 0,
          }),
          signal: controller.signal,
        });
        const raw = await resp.text();
        if (!resp.ok) {
          const isRateLimit =
            resp.status === 429 ||
            /RateLimitExceeded\.EndpointTPMExceeded|Tokens Per Minute|TooManyRequests|rate limit/i.test(raw || "");
          if (enableRetry && isRateLimit && attempt < maxAttempts) {
            const retryAfterHeader = resp.headers?.get ? resp.headers.get("retry-after") : null;
            const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
            const jitter = Math.floor(Math.random() * 200);
            const backoff = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
            const waitMs = Number.isFinite(retryAfterSec) ? Math.max(0, retryAfterSec * 1000) : backoff;
            await sleep(waitMs);
            continue;
          }
          throw new Error(raw || `llm http ${resp.status}`);
        }
        const parsed = JSON.parse(raw);
        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error("llm returned empty content");
        return content.trim();
      } catch (e) {
        lastErr = e;
        if (e && typeof e === "object" && String(e.name || "") === "AbortError") throw e;
        if (enableRetry && attempt < maxAttempts) {
          const jitter = Math.floor(Math.random() * 200);
          const backoff = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
          await sleep(backoff);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error("llm request failed");
  } finally {
    clearTimeout(t);
  }
}

module.exports = { callChatCompletions };

