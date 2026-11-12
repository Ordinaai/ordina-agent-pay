import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies to the API on :8787; set API_URL to point the dev server elsewhere.
const api = process.env.API_URL ?? "http://localhost:8787";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": api, "/mcp": api, "/paypal-sandbox-mock": api },
  },
});
