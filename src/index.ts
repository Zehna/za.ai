import { appInfo } from "./app-info.js";

export function main() {
  // Milestone 3 replaces this stub with the Fastify HTTP server.
  const info = appInfo();
  console.log(`${info.name} ${info.version} — ${info.description}`);
}

main();
