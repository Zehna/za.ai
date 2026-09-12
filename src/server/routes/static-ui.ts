import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
/** public/ relative to dist/server/routes (build) or src/server/routes (tsx). */
const publicDir = path.resolve(currentDir, "../../../public");

export function registerStaticUi(app: FastifyInstance): void {
  app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
  });
}
