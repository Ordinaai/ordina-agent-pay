import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { BusinessApp } from "./business.tsx";
import { PayPage } from "./pay.tsx";
import "./styles.css";
import "./business.css";

// Doors: the playground (/), a business's link (/b/<handle>), the business view
// (/business), and the hosted pay page any agent can send a customer to (/pay/<token>).
const path = location.pathname;
const handle = path.match(/^\/b\/([a-z0-9-]{1,60})\/?$/)?.[1];
const payToken = path.match(/^\/pay\/([A-Za-z0-9_-]{16,64})\/?$/)?.[1];
const root = createRoot(document.getElementById("root")!);
root.render(payToken ? <PayPage token={payToken} /> : path.startsWith("/business") ? <BusinessApp /> : <App handle={handle} />);
