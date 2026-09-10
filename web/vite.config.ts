import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // The backend's port is CLEARRAG_PORT in the repo-root .env -- the same value
  // Settings.port reads. Loading it here rather than hardcoding a number is what keeps
  // the proxy from quietly targeting whatever unrelated process owns the old port: a
  // stale target does not fail, it returns someone else's 404s. npm runs scripts with
  // this file's directory as the cwd, so ".." is the repository root.
  const env = loadEnv(mode, "..", "");
  const apiPort = env.CLEARRAG_PORT || "8010";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // The Results view and the Learn charts import evals/results/*.json from the
      // repository root, one level above this package; Vite's dev server refuses to
      // serve files outside its root unless told otherwise. Relative to the root.
      fs: { allow: [".."] },
      // In development the UI runs on Vite and the API on uvicorn. In production
      // FastAPI serves this bundle itself, so there is no proxy and no second origin.
      proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } }
    },
    build: { outDir: "dist", sourcemap: true }
  };
});
