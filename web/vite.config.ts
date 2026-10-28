import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Read the same SERVER_PORT as the API server so the proxy can never drift.
// PORT is deliberately not used: hosts and tools set it for the web process.
const serverPort = process.env.SERVER_PORT ?? "3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${serverPort}`, "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true } },
  },
});
