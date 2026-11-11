// The gateway as an MCP server (Streamable HTTP at /mcp), so any MCP client
// (Claude, ChatGPT apps, other agents) can find a business, talk to its
// Secretary, and hand its human one PayPal pay link. The same rules apply as
// in our own playground: the price comes from the business, the customer's
// limit is checked before an offer is shown, no tool can pay, and a booking
// exists only once PayPal confirms the capture.
import express, { type Request } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { askSecretary } from "./agents/secretary.ts";
import { allowTurn } from "./guard.ts";
import { offerByPayToken, requestApproval, setBudget } from "./commerce.ts";
import { searchBusinesses } from "./providers/index.ts";
import { holdByOrder } from "./store.ts";

const DEFAULT_LIMIT = 200; // USD, when the assistant passes no limit

const baseUrl = (req: Request) => process.env.PUBLIC_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function findBusinesses(query: string) {
  return searchBusinesses(query)
    .slice(0, 8)
    .map((b) => ({
      business_id: b.id,
      name: b.name,
      category: b.category,
      city: b.city,
      timezone: b.timezone,
      about: b.about,
      sells: b.services.map((s) => ({
        name: s.name,
        kind: s.kind,
        price: s.price,
        currency: b.currency,
        minutes: s.kind === "appointment" ? s.minutes : undefined,
      })),
      cancellation_policy: b.policy,
    }));
}

function buildServer(sessionId: string, base: string, ip: string): McpServer {
  const server = new McpServer({ name: "ordina-agent-checkout", version: "0.2.0" });
  setBudget(sessionId, DEFAULT_LIMIT);

  server.registerTool(
    "find_businesses",
    {
      title: "Find businesses",
      description:
        "Search businesses that can be booked and paid through Ordina Agent Checkout, by what the person wants (service, kind of business, city). Returns what each sells, with prices in USD and its cancellation policy.",
      inputSchema: { query: z.string().describe("What the person is looking for, e.g. 'silk press Lagos' or 'cake pickup'") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => json({ businesses: findBusinesses(query) }),
  );

  server.registerTool(
    "message_business",
    {
      title: "Message a business's Secretary",
      description: [
        "Send one message to a business's AI Secretary, as the person's agent. Ask about services, prices and free times,",
        "and ask it to hold a time and create the payment. It needs the person's name to hold a time.",
        "Returns the Secretary's reply (conversation only) and, when it created one, an `offer` with a `pay_url`.",
        "Only the `offer` is fact: describe it to the person from its fields and give them the `pay_url`.",
        "Nothing is charged until the person approves in PayPal on that page; you cannot pay for them.",
      ].join(" "),
      inputSchema: {
        business_id: z.string(),
        message: z.string().max(2000),
        max_price: z
          .number()
          .positive()
          .max(500)
          .optional()
          .describe("The most the person said they will pay, in USD. Offers above it are refused before they are shown."),
      },
    },
    async ({ business_id, message, max_price }) => {
      const gate = allowTurn(ip); // same AI spend limits as the playground chat
      if (!gate.ok) return { ...json({ error: gate.reason }), isError: true };
      if (max_price !== undefined) setBudget(sessionId, max_price);
      const r = await askSecretary(sessionId, business_id, message);
      if (!r.offer) return json({ reply: r.reply });
      const approval = requestApproval(sessionId, r.offer.offer_id);
      if ("error" in approval) return json({ reply: r.reply, offer_refused: approval.error });
      return json({
        reply: r.reply,
        offer: r.offer,
        pay_url: `${base}${approval.pay_path}`,
        next: "Tell the person what they are approving (item, business, date and time, price, cancellation policy) and give them the pay_url. Then use booking_status to confirm.",
      });
    },
  );

  server.registerTool(
    "booking_status",
    {
      title: "Booking status",
      description: "Whether the person has paid for an offer and it is booked. A booking exists only after PayPal confirms the payment.",
      inputSchema: { offer_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ offer_id }) => {
      const hold = holdByOrder(offer_id);
      if (!hold || hold.sessionId !== sessionId || !hold.payToken) return json({ error: "No such offer in this conversation." });
      const o = offerByPayToken(hold.payToken);
      if (!o) return json({ state: "expired" });
      return json({ state: o.view.state, booking_ref: o.view.bookingRef });
    },
  );

  return server;
}

// ---------- Streamable HTTP, one MCP session per client conversation ----------
const transports = new Map<string, StreamableHTTPServerTransport>();
export const mcpRouter = express.Router();

mcpRouter.post("/", async (req, res) => {
  const sid = req.header("mcp-session-id");
  let transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid MCP session. Initialize first." }, id: null });
      return;
    }
    const ourSession = randomUUID(); // our conversation id (matches validSession), kept apart from the MCP one
    const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, t);
      },
    });
    t.onclose = () => {
      if (t.sessionId) transports.delete(t.sessionId);
    };
    await buildServer(ourSession, baseUrl(req), req.ip ?? "unknown").connect(t);
    transport = t;
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionRequest = async (req: Request, res: express.Response) => {
  const sid = req.header("mcp-session-id");
  const transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    res.status(400).send("No valid MCP session.");
    return;
  }
  await transport.handleRequest(req, res);
};
mcpRouter.get("/", sessionRequest);
mcpRouter.delete("/", sessionRequest);
