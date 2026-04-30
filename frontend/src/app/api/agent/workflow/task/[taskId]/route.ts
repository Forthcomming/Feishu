import { NextResponse } from "next/server";

function getAgentServiceUrl() {
  return process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";
}

export async function GET(_: Request, ctx: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await ctx.params;
    const safeTaskId = typeof taskId === "string" ? taskId.trim() : "";
    if (!safeTaskId) return NextResponse.json({ ok: false, error: "taskId is required" }, { status: 400 });
    const upstream = await fetch(`${getAgentServiceUrl()}/api/agent/workflow/${encodeURIComponent(safeTaskId)}`, {
      method: "GET",
      cache: "no-store",
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8" },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

