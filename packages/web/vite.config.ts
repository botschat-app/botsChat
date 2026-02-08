import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "https://botschat-api.auxtenwpc.workers.dev",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
