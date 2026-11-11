import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { BusinessApp } from "./business.tsx";
import "./styles.css";
import "./business.css";

// Three doors: the customer app (/), a business's own link (/b/<handle>), and
// the business owner's app (/business).
const path = location.pathname;
const handle = path.match(/^\/b\/([a-z0-9-]{1,60})\/?$/)?.[1];
const root = createRoot(document.getElementById("root")!);
root.render(path.startsWith("/business") ? <BusinessApp /> : <App handle={handle} />);
