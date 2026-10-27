import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { WebSocketServer } from "ws";

loadDotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });
loadDotenv();
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp(config);

// Realtime audio will run over this WebSocket server in a later brief.
const wss = new WebSocketServer({ noServer: true });
app.server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});
wss.on("connection", (ws) => ws.close(1008, "Not implemented yet"));

await app.listen({ host: config.SERVER_HOST, port: config.SERVER_PORT });
app.log.info(`Hot Seat server listening on http://${config.SERVER_HOST}:${config.SERVER_PORT}`);
