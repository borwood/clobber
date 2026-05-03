import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3400,
    host: "127.0.0.1",
    proxy: {
      "/hook": "http://127.0.0.1:3300",
      "/events": "http://127.0.0.1:3300",
      "/sessions": "http://127.0.0.1:3300",
      "/spawn": "http://127.0.0.1:3300",
      "/workspaces": "http://127.0.0.1:3300",
      "/roles": "http://127.0.0.1:3300",
    },
  },
});
