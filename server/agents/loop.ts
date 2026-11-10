// A small manual agent loop over the Messages API. Both agents use it.
// The full assistant content (thinking blocks included) is appended back
// unchanged on every turn, so the history stays append-only.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";

export type AgentTool<S extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<unknown> | unknown;
};

export function tool<S extends z.ZodObject>(t: AgentTool<S>): AgentTool<S> {
  return t;
}

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ maxRetries: 2, timeout: 90_000 }));

export const aiMode = (): "claude" | "mock" =>
  process.env.MOCK_AI === "1" || !process.env.ANTHROPIC_API_KEY ? "mock" : "claude";

function toApiTool(t: AgentTool): Anthropic.Beta.BetaTool {
  const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: t.name,
    description: t.description,
    strict: true,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
  };
}

export type RunResult = {
  text: string;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number };
};

export async function runAgent(opts: {
  system: string;
  tools: AgentTool[];
  messages: Anthropic.Beta.BetaMessageParam[]; // mutated: the conversation grows in place
  maxIterations?: number;
  onToolCall?: (name: string, input: unknown, result: unknown) => void;
}): Promise<RunResult> {
  const apiTools = opts.tools.map(toApiTool);
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const max = opts.maxIterations ?? 8;

  for (let i = 0; i < max; i++) {
    const res = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
      system: opts.system,
      tools: apiTools,
      messages: opts.messages,
    });
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;

    opts.messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });

    if (res.stop_reason === "refusal") {
      return { text: "I can't help with that one.", stopReason: "refusal", usage };
    }
    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || calls.length === 0) {
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text, stopReason: res.stop_reason, usage };
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const t = opts.tools.find((x) => x.name === call.name);
      let content: string;
      let isError = false;
      if (!t) {
        content = `Unknown tool ${call.name}.`;
        isError = true;
      } else {
        const parsed = t.schema.safeParse(call.input);
        if (!parsed.success) {
          content = `Invalid input: ${parsed.error.issues.map((x) => x.message).join("; ")}`;
          isError = true;
        } else {
          try {
            const out = await t.run(parsed.data);
            isError = !!(out && typeof out === "object" && "error" in out);
            content = JSON.stringify(out);
            opts.onToolCall?.(call.name, parsed.data, out);
          } catch (err) {
            content = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
          }
        }
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError });
    }
    opts.messages.push({ role: "user", content: results });
  }
  return { text: "", stopReason: "max_iterations", usage };
}
