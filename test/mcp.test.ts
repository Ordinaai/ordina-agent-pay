// The MCP door, end to end over Streamable HTTP with the real SDK client:
// find a business, ask its Secretary, get one pay link, and a booking exists
// only after the (mock) PayPal capture on the hosted pay page's API.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.MOCK_AI = "1";
process.env.DATA_DIR = ":memory:";
delete process.env.PAYPAL_FLOW;
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PUBLIC_URL;

const express = (await import("express")).default;
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { mcpRouter } = await import("../server/mcp.ts");
const { seedDemoBusinesses } = await import("../server/seed.ts");
const commerce = await import("../server/commerce.ts");
const paypal = await import("../server/paypal.ts");
const store = await import("../server/store.ts");

seedDemoBusinesses();

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/mcp", mcpRouter);
  server = await new Promise<Server>((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

async function connect() {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}
type Text = { content: Array<{ type: string; text: string }> };
const parse = (r: unknown) => JSON.parse((r as Text).content[0].text);

describe("MCP server", () => {
  it("lists the three tools and no tool that pays", async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["booking_status", "find_businesses", "message_business"]);
    await c.close();
  });

  it("finds, offers a pay link, and books only after PayPal captures", async () => {
    const c = await connect();
    const found = parse(await c.callTool({ name: "find_businesses", arguments: { query: "haircut" } }));
    const biz = found.businesses[0];
    expect(biz.business_id).toBeTruthy();

    const r = parse(
      await c.callTool({
        name: "message_business",
        arguments: { business_id: biz.business_id, message: "Hi, I'm booking for Ada Obi. A haircut please, hold the earliest time and create the payment." },
      }),
    );
    expect(r.offer.business_id).toBe(biz.business_id);
    expect(r.pay_url).toMatch(new RegExp(`^${base}/pay/[A-Za-z0-9_-]{16,64}$`));

    const status = () => c.callTool({ name: "booking_status", arguments: { offer_id: r.offer.offer_id } }).then(parse);
    expect((await status()).state).toBe("awaiting_approval");

    // the customer approves on the pay page; the page's API captures
    const token = r.pay_url.split("/pay/")[1];
    const o = commerce.offerByPayToken(token)!;
    paypal.mockApprove(o.view.orderId);
    const out = await commerce.captureAndConfirm(o.sessionId, o.view.orderId);
    expect(out.ok).toBe(true);
    const done = await status();
    expect(done.state).toBe("booked");
    expect(done.booking_ref).toBeTruthy();
    await c.close();
  });

  it("refuses an offer above the person's limit before it is shown", async () => {
    const c = await connect();
    const biz = parse(await c.callTool({ name: "find_businesses", arguments: { query: "haircut" } })).businesses[0];
    const r = parse(
      await c.callTool({
        name: "message_business",
        arguments: { business_id: biz.business_id, message: "Hi, I'm booking for Ada Obi. A haircut please, hold it and create the payment.", max_price: 1 },
      }),
    );
    expect(r.pay_url).toBeUndefined();
    expect(r.offer_refused ?? r.reply).toBeTruthy();
    await c.close();
  });

  it("does not show one conversation's offer to another", async () => {
    const a = await connect();
    const b = await connect();
    const biz = parse(await a.callTool({ name: "find_businesses", arguments: { query: "haircut" } })).businesses[0];
    const r = parse(
      await a.callTool({
        name: "message_business",
        arguments: { business_id: biz.business_id, message: "Hi, I'm booking for Ada Obi. A haircut please, hold it and create the payment." },
      }),
    );
    const other = parse(await b.callTool({ name: "booking_status", arguments: { offer_id: r.offer.offer_id } }));
    expect(other.error).toBeTruthy();
    await a.close();
    await b.close();
  });

  it("rejects requests without an initialized session", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });
});

void store;
