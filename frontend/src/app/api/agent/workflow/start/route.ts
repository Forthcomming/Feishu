import { NextResponse } from "next/server";

function getAgentServiceUrl() {
  return process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";
}

export async function POST(req: Request) {
  try {
    const body = await req.text();
    const upstream = await fetch(`${getAgentServiceUrl()}/api/agent/workflow/start`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
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

