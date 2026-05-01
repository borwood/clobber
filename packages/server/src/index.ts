import { createServer } from "./server.ts";

const PORT = 3300;

const app = createServer();
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`clobber-server listening on http://127.0.0.1:${PORT}`);
