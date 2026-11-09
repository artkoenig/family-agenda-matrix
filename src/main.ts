/**
 * Runs the Matrix Source as an HTTP plugin on PORT (8080 by default), as its image does: writes
 * the configuration of Synapse and the bridges into their volumes, then serves.
 */
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { writeConfiguration } from "./configuration";
import { createMatrixPlugin } from "./plugin";

const port = Number(process.env.PORT ?? 8080);
const instance = await writeConfiguration({
  configDirectory: process.env.MATRIX_CONFIG_DIRECTORY ?? "/config",
  serverName: process.env.MATRIX_SERVER_NAME ?? "family-agenda.local",
  // The companions' service names, as the compose generator names them for the plugin id `matrix`.
  synapseUrl: process.env.MATRIX_SYNAPSE_URL ?? "http://plugin-matrix-synapse:8008",
  bridgeUrls: { whatsapp: process.env.MATRIX_WHATSAPP_URL ?? "http://plugin-matrix-whatsapp:29318" },
});
await servePlugin(createMatrixPlugin({ instance }), { port });
console.log(`Matrix Source plugin listening on port ${port}`);
