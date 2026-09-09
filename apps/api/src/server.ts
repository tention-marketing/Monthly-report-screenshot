import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

try {
  await buildApp({ logger: true }).listen({ port, host });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
