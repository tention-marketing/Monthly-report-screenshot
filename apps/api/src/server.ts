import { buildApp } from "./app.js";
import { createConfiguredRepository } from "./db/configured-repository.js";
import { createConfiguredScreenshotStorage } from "./storage/configured-storage.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

try {
  const repository = createConfiguredRepository(process.env);
  const screenshotStorage = createConfiguredScreenshotStorage(process.env);
  const allowedOrigins = process.env.EXTENSION_ORIGIN ? [process.env.EXTENSION_ORIGIN] : [];
  await buildApp({ logger: true, repository, screenshotStorage, allowedOrigins }).listen({ port, host });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
