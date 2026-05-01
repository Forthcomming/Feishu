const { spawn } = require("node:child_process");
const iconv = require("iconv-lite");

function getCliBin() {
  const bin = process.env.LARK_CLI_BIN;
  return typeof bin === "string" && bin.trim() ? bin.trim() : "lark-cli";
}

function isWindowsCmd(bin) {
  if (process.platform !== "win32") return false;
  const lower = String(bin).toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

function shouldWrapWithCmd(bin) {
  if (process.platform !== "win32") return false;
  // When bin is a bare command name (no path), wrapping with cmd.exe makes resolution
  // consistent with interactive terminals (PATHEXT, .cmd shims, etc.).
  const s = String(bin);
  const hasPathSep = s.includes("\\") || s.includes("/");
  return isWindowsCmd(s) || !hasPathSep;
}

function runLarkCli(args, { timeoutMs = 30_000, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const bin = getCliBin();

    // On Windows, lark-cli is typically a .cmd shim. Spawn it via cmd.exe for reliability.
    const command = shouldWrapWithCmd(bin) ? "cmd.exe" : bin;
    const commandArgs = shouldWrapWithCmd(bin) ? ["/d", "/s", "/c", bin, ...args] : args;

    const child = spawn(command, commandArgs, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("lark-cli timeout"));
    }, timeoutMs);

    child.stdout.on("data", (d) => stdoutChunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderrChunks.push(Buffer.from(d)));

    if (typeof stdin === "string") {
      try {
        child.stdin.write(stdin, "utf8");
      } catch {
        // ignore
      }
    }
    try {
      child.stdin.end();
    } catch {
      // ignore
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err && err.code === "ENOENT") {
        reject(
          new Error(
            `spawn ${bin} ENOENT (not found). On Windows, set LARK_CLI_BIN to full path, e.g. C:\\Users\\light\\AppData\\Roaming\\npm\\lark-cli.cmd`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      const decode = (buf) => {
        if (!buf || buf.length === 0) return "";
        const utf8 = buf.toString("utf8");
        if (!utf8.includes("�")) return utf8;
        // Windows CLI commonly emits CP936/GBK; fallback to reduce mojibake in error messages.
        const gbk = iconv.decode(buf, "cp936");
        if (typeof gbk === "string" && gbk.trim()) return gbk;
        return utf8;
      };
      const stdout = decode(stdoutBuffer).trim();
      const stderr = decode(stderrBuffer).trim();
      if (code !== 0) {
        const msg = (stderr || stdout || "").trim();
        reject(new Error(msg || `lark-cli exited with code ${code}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

module.exports = { runLarkCli, tryParseJson };

