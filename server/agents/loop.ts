// A small manual agent loop over the Messages API. Both agents use it.
// The full assistant content (thinking blocks included) is appended back
// unchanged on every turn, so the history stays append-only.
//
// Claude is reached one of two ways:
// - directly, with ANTHROPIC_API_KEY (the Claude API);
// - through Cencori, an AI gateway (cencori.com), with CENCORI_API_KEY.
// Either way the history is the same list in Claude's message format.
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

export type AiGateway = "anthropic" | "cencori";

/** Which way Claude is reached, or null for the offline scripted agents. AI_GATEWAY picks when both keys are set. */
export function aiGateway(): AiGateway | null {
  if (process.env.MOCK_AI === "1") return null;
  const anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const cencoriKey = !!process.env.CENCORI_API_KEY;
  const pick = process.env.AI_GATEWAY?.trim().toLowerCase();
  if (pick === "cencori") return cencoriKey ? "cencori" : null;
  if (pick === "anthropic") return anthropicKey ? "anthropic" : null;
  if (anthropicKey) return "anthropic";
  if (cencoriKey) return "cencori";
  return null;
}

export const aiMode = (): "claude" | "mock" => (aiGateway() ? "claude" : "mock");

function jsonSchemaOf(t: AgentTool): Record<string, unknown> {
  const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export type RunResult = {
  text: string;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number };
};

type Step = {
  content: Anthropic.Beta.BetaContentBlockParam[];
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number };
};

async function anthropicStep(system: string, tools: AgentTool[], messages: Anthropic.Beta.BetaMessageParam[]): Promise<Step> {
  const res = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    cache_control: { type: "ephemeral" },
    system,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      strict: true,
      input_schema: jsonSchemaOf(t) as Anthropic.Beta.BetaTool.InputSchema,
    })),
    messages,
  });
  return {
    content: res.content as Anthropic.Beta.BetaContentBlockParam[],
    stopReason: res.stop_reason,
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
  };
}

// ---------- Cencori ----------
// Its chat endpoint (the one the `cencori` SDK's ai.chat calls) takes tools in the OpenAI
// "function" shape, and passes Claude's own message format through to Claude. Tool results
// must go as Claude tool_result blocks: sent as OpenAI "tool" messages they reach Claude
// without their tool_use_id and are refused (measured 12 Nov 2026).

const CENCORI_URL = () => (process.env.CENCORI_BASE_URL ?? "https://cencori.com").replace(/\/+$/, "");
const KEEP_BLOCKS = new Set(["text", "tool_use", "tool_result"]);

/** The history as Cencori takes it: Claude's format, minus blocks only the Claude API itself understands. */
export function cencoriMessages(system: string, messages: Anthropic.Beta.BetaMessageParam[]) {
  const out: { role: string; content: unknown }[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = (m.content as unknown as Record<string, unknown>[])
      .filter((b) => KEEP_BLOCKS.has(String(b.type)))
      .map(({ cache_control: _drop, ...b }) => b);
    if (blocks.length) out.push({ role: m.role, content: blocks });
  }
  return out;
}

type CencoriToolCall = { id: string; function: { name: string; arguments?: string } };
export type CencoriReply = {
  content?: string | null;
  toolCalls?: CencoriToolCall[];
  tool_calls?: CencoriToolCall[];
  finish_reason?: string;
  choices?: { message?: { content?: string | null; tool_calls?: CencoriToolCall[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: string;
  details?: unknown;
  message?: string;
};

/** Cencori's reply as Claude content blocks, so the history and the loop stay the same. */
export function fromCencori(data: CencoriReply): Step {
  const choice = data.choices?.[0];
  const text = (data.content ?? choice?.message?.content ?? "").toString();
  const calls = data.toolCalls ?? data.tool_calls ?? choice?.message?.tool_calls ?? [];
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const c of calls) {
    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(c.function.arguments || "{}");
      input = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
    } catch {
      input = { unreadable_arguments: String(c.function.arguments ?? "") }; // fails the tool's schema check
    }
    content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
  }
  const finish = data.finish_reason ?? choice?.finish_reason;
  const stopReason = calls.length
    ? "tool_use"
    : finish === "length"
      ? "max_tokens"
      : finish === "content_filter"
        ? "refusal"
        : "end_turn";
  return {
    content,
    stopReason,
    usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0, cacheRead: 0 },
  };
}

async function cencoriStep(system: string, tools: AgentTool[], messages: Anthropic.Beta.BetaMessageParam[]): Promise<Step> {
  const body = JSON.stringify({
    model: MODEL,
    maxTokens: 8000,
    stream: false,
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: jsonSchemaOf(t) },
    })),
    messages: cencoriMessages(system, messages),
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    let res: Response;
    try {
      res = await fetch(`${CENCORI_URL()}/api/ai/chat`, {
        method: "POST",
        headers: { CENCORI_API_KEY: process.env.CENCORI_API_KEY ?? "", "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      lastError = err; // network trouble: try again
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as CencoriReply;
    if (res.ok) return fromCencori(data);
    const detail = [data.error, typeof data.details === "string" ? data.details : data.message].filter(Boolean).join(": ");
    lastError = new Error(`Cencori ${res.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`);
    if (res.status !== 429 && res.status < 500) break; // the request itself is wrong: retrying will not help
  }
  throw lastError instanceof Error ? lastError : new Error("Cencori could not be reached.");
}

export async function runAgent(opts: {
  system: string;
  tools: AgentTool[];
  messages: Anthropic.Beta.BetaMessageParam[]; // mutated: the conversation grows in place
  maxIterations?: number;
  onToolCall?: (name: string, input: unknown, result: unknown) => void;
}): Promise<RunResult> {
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const max = opts.maxIterations ?? 8;
  const step = aiGateway() === "cencori" ? cencoriStep : anthropicStep;

  for (let i = 0; i < max; i++) {
    const res = await step(opts.system, opts.tools, opts.messages);
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    usage.cacheRead += res.usage.cacheRead;

    // Claude refuses an empty assistant turn later in the history, so an empty reply keeps a placeholder.
    opts.messages.push({ role: "assistant", content: res.content.length ? res.content : [{ type: "text", text: "..." }] });

    if (res.stopReason === "refusal") {
      return { text: "I can't help with that one.", stopReason: "refusal", usage };
    }
    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
    if (res.stopReason !== "tool_use" || calls.length === 0) {
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text, stopReason: res.stopReason, usage };
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
