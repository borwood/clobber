import { createServer } from "./server.ts";
import { createEventStore } from "./event-store.ts";

const PORT = 3300;
const envDb = process.env["CLOBBER_DB"];
const DB_PATH = envDb && envDb.length > 0 ? envDb : "./clobber.db";

const store = createEventStore(DB_PATH);
const app = createServer({ store });
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`clobber-server listening on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
