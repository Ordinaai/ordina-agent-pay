// Claude through Cencori: what is sent, and how the reply comes back into the loop.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { aiGateway, cencoriMessages, fromCencori, runAgent, tool } from "../server/agents/loop.ts";

const keys = ["ANTHROPIC_API_KEY", "CENCORI_API_KEY", "AI_GATEWAY", "MOCK_AI"] as const;
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});
const only = (env: Partial<Record<(typeof keys)[number], string>>) => {
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
};

describe("which way Claude is reached", () => {
  it("uses Cencori when only its key is set, and the Claude API first when both are", () => {
    only({ CENCORI_API_KEY: "csk_test" });
    expect(aiGateway()).toBe("cencori");
    only({ CENCORI_API_KEY: "csk_test", ANTHROPIC_API_KEY: "sk-test" });
    expect(aiGateway()).toBe("anthropic");
    only({ CENCORI_API_KEY: "csk_test", ANTHROPIC_API_KEY: "sk-test", AI_GATEWAY: "cencori" });
    expect(aiGateway()).toBe("cencori");
    only({});
    expect(aiGateway()).toBe(null);
    only({ CENCORI_API_KEY: "csk_test", MOCK_AI: "1" });
    expect(aiGateway()).toBe(null);
  });
});

describe("the Cencori message shape", () => {
  it("keeps tool results as Claude tool_result blocks and drops blocks only the Claude API takes", () => {
    const msgs = cencoriMessages("SYS", [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x", signature: "s" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "check", input: { a: 1 } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}", cache_control: { type: "ephemeral" } }] },
    ]);
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(msgs[2].content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "check", input: { a: 1 } },
    ]);
    expect(msgs[3].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }]);
  });

  it("turns tool calls into tool_use blocks, and bad arguments into input the schema refuses", () => {
    const step = fromCencori({
      content: "",
      toolCalls: [
        { id: "toolu_a", function: { name: "check", arguments: '{"date":"2026-11-13"}' } },
        { id: "toolu_b", function: { name: "check", arguments: "{not json" } },
      ],
      finish_reason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(step.stopReason).toBe("tool_use");
    expect(step.content).toEqual([
      { type: "tool_use", id: "toolu_a", name: "check", input: { date: "2026-11-13" } },
      { type: "tool_use", id: "toolu_b", name: "check", input: { unreadable_arguments: "{not json" } },
    ]);
    expect(step.usage).toEqual({ input: 10, output: 5, cacheRead: 0 });
    expect(fromCencori({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] }).stopReason).toBe("end_turn");
  });
});

describe("a full tool loop over Cencori", () => {
  it("runs the tool, sends its result back, and ends on Claude's answer", async () => {
    only({ CENCORI_API_KEY: "csk_test" });
    const bodies: Record<string, unknown>[] = [];
    const replies = [
      { content: "", toolCalls: [{ id: "toolu_x", function: { name: "times", arguments: '{"date":"2026-11-13"}' } }], finish_reason: "tool_calls" },
      { content: "10:00 or 14:30.", finish_reason: "stop" },
    ];
    vi.stubGlobal("fetch", async (url: string, init: { body: string; headers: Record<string, string> }) => {
      expect(url).toBe("https://cencori.com/api/ai/chat");
      expect(init.headers.CENCORI_API_KEY).toBe("csk_test");
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200 });
    });
    const ran: unknown[] = [];
    const history: Parameters<typeof runAgent>[0]["messages"] = [{ role: "user", content: "Free tomorrow?" }];
    const r = await runAgent({
      system: "SYS",
      messages: history,
      tools: [tool({ name: "times", description: "Free times", schema: z.object({ date: z.string() }), run: (i) => (ran.push(i), { times: ["10:00", "14:30"] }) })],
    });
    expect(r.text).toBe("10:00 or 14:30.");
    expect(ran).toEqual([{ date: "2026-11-13" }]);
    expect((bodies[0].tools as { type: string; function: { name: string } }[])[0]).toMatchObject({ type: "function", function: { name: "times" } });
    const second = bodies[1].messages as { role: string; content: unknown }[];
    expect(second.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_x", content: JSON.stringify({ times: ["10:00", "14:30"] }), is_error: false }],
    });
    expect(history).toHaveLength(4);
  });

  it("does not retry a request Cencori calls invalid, and says why", async () => {
    only({ CENCORI_API_KEY: "csk_test" });
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ error: "provider_invalid_request", details: "bad tool_use_id" }), { status: 400 });
    });
    await expect(runAgent({ system: "S", tools: [], messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      /Cencori 400: provider_invalid_request: bad tool_use_id/,
    );
    expect(calls).toBe(1);
  });
});
