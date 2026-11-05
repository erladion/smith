// A fake OpenAI-compatible server that answers from a script, the way
// llama-server would: streamed SSE chunks, plain JSON, or an error.
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Delta = Record<string, unknown>;
export type Reply =
  | { deltas: Delta[]; finish: string; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { content: string }
  | { status: number; error: Record<string, unknown> };

export interface FakeServer {
  baseURL: string;
  /** Replies to send, in order. */
  script: Reply[];
  /** Request bodies received. */
  requests: Record<string, any>[];
  close: () => Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const state = { script: [] as Reply[], requests: [] as Record<string, any>[] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.requests.push(JSON.parse(body));
      const reply = state.script.shift();
      if (!reply) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fake server: script exhausted" } }));
        return;
      }
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: reply.error }));
        return;
      }
      if ("content" in reply) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "c",
            object: "chat.completion",
            created: 0,
            model: "fake",
            choices: [{ index: 0, message: { role: "assistant", content: reply.content }, finish_reason: "stop" }],
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choices: unknown[], extra = {}) =>
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake", choices, ...extra })}\n\n`);
      for (const delta of reply.deltas) chunk([{ index: 0, delta, finish_reason: null }]);
      chunk([{ index: 0, delta: {}, finish_reason: reply.finish }]);
      const usage = reply.usage ?? { prompt_tokens: 100, completion_tokens: 10 };
      chunk([], { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    get script() {
      return state.script;
    },
    set script(s) {
      state.script = s;
    },
    get requests() {
      return state.requests;
    },
    set requests(r) {
      state.requests = r;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** A tool call streamed in fragments: id and name first, arguments split across chunks. */
export function toolCallDeltas(name: string, args: Record<string, unknown>, id = "call_1"): Delta[] {
  const json = JSON.stringify(args);
  return [
    { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { arguments: json.slice(0, 7) } }] },
    { tool_calls: [{ index: 0, function: { arguments: json.slice(7) } }] },
  ];
}
