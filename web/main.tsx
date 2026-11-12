import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { BusinessApp } from "./business.tsx";
import { ConnectPage } from "./connect.tsx";
import { PayPage } from "./pay.tsx";
import "./styles.css";
import "./business.css";
import "./connect.css";
import "./onboard.css";
import "./handshake.css";
import "./system.css"; // last: it owns the tokens and the shared pieces

// Doors: the front door (/), where customers pick the AI assistant they already use
// and add Ordina to it; the playground for people without one (/try); a business's
// link, which opens the playground pinned to it (/b/<handle>); the business view
// (/business); and the hosted pay page any agent can send a customer to (/pay/<token>).
const path = location.pathname;
const handle = path.match(/^\/b\/([a-z0-9-]{1,60})\/?$/)?.[1];
const payToken = path.match(/^\/pay\/([A-Za-z0-9_-]{16,64})\/?$/)?.[1];
const playground = handle !== undefined || /^\/try\/?$/.test(path);
const root = createRoot(document.getElementById("root")!);
root.render(
  payToken ? (
    <PayPage token={payToken} />
  ) : path.startsWith("/business") ? (
    <BusinessApp />
  ) : playground ? (
    <App handle={handle} />
  ) : (
    <ConnectPage />
  ),
);
