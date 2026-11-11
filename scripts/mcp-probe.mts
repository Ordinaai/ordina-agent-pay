// Acts as an outside agent: connects to the running gateway's /mcp and asks for a booking.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const c = new Client({ name: "probe", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp")));
const text = (r: any) => JSON.parse(r.content[0].text);
const found = text(await c.callTool({ name: "find_businesses", arguments: { query: "silk press" } }));
console.log("found:", found.businesses.map((b: any) => b.name).join(", "));
const r = text(
  await c.callTool({
    name: "message_business",
    arguments: { business_id: found.businesses[0].business_id, message: "Hi, I'm booking for Ada Obi. A silk press please, hold the earliest time and create the payment.", max_price: 60 },
  }),
);
console.log(JSON.stringify({ reply: r.reply, offer: r.offer, pay_url: r.pay_url }, null, 2));
await c.close();
