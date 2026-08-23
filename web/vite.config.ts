import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the UI runs on Vite and the API on uvicorn. In production
    // FastAPI serves this bundle itself, so there is no proxy and no second origin.
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: true } }
  },
  build: { outDir: "dist", sourcemap: true }
});
