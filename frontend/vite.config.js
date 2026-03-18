import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const configuredBase = env.VITE_BASE_PATH?.trim();
  const repository = env.GITHUB_REPOSITORY || "";
  const repoName = repository.includes("/") ? repository.split("/")[1] : "";
  const pagesBase = repoName ? `/${repoName}/` : "/";
  const base =
    configuredBase || (env.GITHUB_ACTIONS === "true" ? pagesBase : "/");

  return {
    base,
    plugins: [react()],
    resolve: {
      alias: {
        WebSdk: fileURLToPath(
          new URL("./src/digitalpersona/websdk.js", import.meta.url),
        ),
      },
    },
  };
});
