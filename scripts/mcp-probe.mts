// Acts as an outside agent: connects to a running gateway's /mcp and asks for a booking.
//   node node_modules/tsx/dist/cli.mjs scripts/mcp-probe.mts [base url, default http://localhost:8787]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const c = new Client({ name: "probe", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
const text = (r: any) => JSON.parse(r.content[0].text);
const found = text(await c.callTool({ name: "find_businesses", arguments: { query: "silk press" } }));
console.log("found:", found.businesses.map((b: any) => b.name).join(", "));
// The demo salon, when it is there; businesses that signed up themselves may be listed too.
const salon = found.businesses.find((b: any) => b.name === "Lumen Hair Studio") ?? found.businesses[0];
const r = text(
  await c.callTool({
    name: "message_business",
    arguments: { business_id: salon.business_id, message: "Hi, I am booking for Ada Obi. A silk press please, hold the earliest time and create the payment.", max_price: 60 },
  }),
);
console.log(JSON.stringify({ reply: r.reply, offer: r.offer, pay_url: r.pay_url }, null, 2));
await c.close();
