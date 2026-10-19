/**
 * Entry point: `pnpm --filter @open-managed-agents/matter start`.
 * See README.md for the environment variables.
 */

import { createMatterService, listen, loadMatterConfig, MatterConfigError } from "./server.js";

const main = async () => {
  let config;
  try {
    config = loadMatterConfig(process.env);
  } catch (error) {
    if (error instanceof MatterConfigError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
  const service = await createMatterService(config);
  await service.start();
  const server = await listen(service, config);
  console.log(
    `[matter] listening on ${config.host}:${config.port}; ${service.host.running().length} connection(s) running`,
  );
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[matter] ${signal}: shutting down`);
    server.close();
    void service.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

void main();
