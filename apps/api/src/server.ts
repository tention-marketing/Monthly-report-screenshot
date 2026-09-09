import { buildApp } from "./app.js";
import { createConfiguredRepository } from "./db/configured-repository.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

try {
  const repository = createConfiguredRepository(process.env);
  await buildApp({ logger: true, repository }).listen({ port, host });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
