import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The public REST API sends no CORS headers, so the browser reaches it through
// the dev (and preview) server: /lcd/* is forwarded to QORE_REST_PROXY_TARGET
// and /rpc/* to QORE_RPC_PROXY_TARGET (the CometBFT RPC, used for tx search —
// the REST node's own tx-search endpoint is broken, see src/qwill/history.ts).
// In production, serve the app behind a proxy that does the same, or set
// VITE_QORE_REST_URL / VITE_QORE_RPC_URL to endpoints that allow your origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const restTarget = env.QORE_REST_PROXY_TARGET || "http://localhost:1317";
  const rpcTarget = env.QORE_RPC_PROXY_TARGET || "https://rpc-testnet.qore.host";
  const proxy = {
    "/lcd": { target: restTarget, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/lcd/, "") },
    "/rpc": { target: rpcTarget, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/rpc/, "") },
  };
  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { proxy },
  };
});
