import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MatrixInstance } from "./instance";
import { messengerOf, type Messenger } from "./messengers";

/** Where the plugin writes the companions' configuration, and how the plugin and the companions reach each other. */
export type MatrixLayout = {
  /**
   * The plugin's own volume, such as `/config`, which holds the secrets. Each companion's
   * configuration is in a subdirectory, `synapse` or `whatsapp`, which is a volume of its own
   * shared with that companion alone: no companion reads the secrets of another.
   */
  configDirectory: string;
  /** The name in the homeserver's user ids; it never leaves the Instance. */
  serverName: string;
  /** Synapse's address on the plugin's internal network, such as `http://plugin-matrix-synapse:8008`. */
  synapseUrl: string;
  /** Each bridge's address on that network, such as `http://plugin-matrix-whatsapp:29318`. */
  bridgeUrls: { whatsapp: string };
};

/** The secrets generated on the first start and kept in the plugin's own volume. */
export type MatrixSecrets = {
  registrationSharedSecret: string;
  macaroonSecretKey: string;
  formSecret: string;
  bridges: { whatsapp: BridgeSecrets };
};

type BridgeSecrets = { asToken: string; hsToken: string; senderLocalpart: string; provisioningSecret: string };

const secret = () => randomBytes(32).toString("base64url");

/** Where each companion keeps its own data, in a volume of its own: Synapse's media, the bridge's session. */
const dataDirectory = "/data";

/** Where a companion sees its own configuration volume: `start.sh`, `ready` and its files. */
const companionConfigDirectory = "/config";

/**
 * The paths of the files the plugin writes: the secrets, and each companion's configuration
 * volume, into which `ready` is written last: the companion waits for it before it starts.
 */
export function pathsOf(layout: MatrixLayout) {
  const synapse = join(layout.configDirectory, "synapse");
  const whatsapp = join(layout.configDirectory, "whatsapp");
  return {
    secrets: join(layout.configDirectory, "secrets.json"),
    synapse: { directory: synapse, config: join(synapse, "homeserver.yaml"), start: join(synapse, "start.sh"), ready: join(synapse, "ready") },
    whatsapp: {
      directory: whatsapp,
      config: join(whatsapp, "config.yaml"),
      registration: join(whatsapp, "registration.yaml"),
      start: join(whatsapp, "start.sh"),
      ready: join(whatsapp, "ready"),
    },
  };
}

/**
 * The secrets of the plugin's volume, generated on the first start and kept from then on. A file
 * that cannot be read, or lacks one of the secrets, fails the start: replacing it would lock the
 * Sources out of their Matrix users and the bridge out of the homeserver.
 */
export async function secretsOf(layout: MatrixLayout): Promise<MatrixSecrets> {
  const file = pathsOf(layout).secrets;
  await mkdir(layout.configDirectory, { recursive: true });
  const text = await readIfExists(file);
  const stored = text === null ? null : parseSecrets(text, file);
  const secrets: MatrixSecrets = {
    registrationSharedSecret: stored?.registrationSharedSecret ?? secret(),
    macaroonSecretKey: stored?.macaroonSecretKey ?? secret(),
    formSecret: stored?.formSecret ?? secret(),
    // A Messenger added in a later version gets its bridge's secrets then.
    bridges: { whatsapp: stored?.bridges.whatsapp ?? bridgeSecrets() },
  };
  if (stored?.bridges.whatsapp === undefined) await write(file, `${JSON.stringify(secrets, null, 2)}\n`);
  return secrets;
}

function bridgeSecrets(): BridgeSecrets {
  return { asToken: secret(), hsToken: secret(), senderLocalpart: `bridge-${randomBytes(8).toString("hex")}`, provisioningSecret: secret() };
}

type StoredSecrets = Omit<MatrixSecrets, "bridges"> & { bridges: Partial<MatrixSecrets["bridges"]> };

/** The stored secrets, or an error naming the file when it is corrupt or incomplete. */
function parseSecrets(text: string, file: string): StoredSecrets {
  const corrupt = (why: string) =>
    new Error(`${file} is corrupt (${why}). Restore it from a backup; deleting it makes new secrets, which lock out every Matrix Source.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corrupt("not JSON");
  }
  if (!isRecord(parsed)) throw corrupt("not an object");
  for (const key of ["registrationSharedSecret", "macaroonSecretKey", "formSecret"]) {
    if (!isSecret(parsed[key])) throw corrupt(`no ${key}`);
  }
  const bridges = parsed.bridges;
  if (!isRecord(bridges)) throw corrupt("no bridges");
  for (const [id, bridge] of Object.entries(bridges)) {
    if (!isRecord(bridge) || !["asToken", "hsToken", "senderLocalpart", "provisioningSecret"].every((key) => isSecret(bridge[key]))) {
      throw corrupt(`incomplete secrets of the ${id} bridge`);
    }
  }
  return parsed as StoredSecrets;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSecret = (value: unknown) => typeof value === "string" && value.length > 0;

/**
 * Writes the configuration and the start script of Synapse and of each bridge into that companion's
 * volume, then the `ready` file it waits for, and returns how the plugin reaches them.
 * The files are written anew on every start, so that an update of the plugin brings its settings
 * along; the secrets and Synapse's signing key are kept.
 */
export async function writeConfiguration(layout: MatrixLayout): Promise<MatrixInstance> {
  const paths = pathsOf(layout);
  for (const companion of [paths.synapse, paths.whatsapp]) {
    await mkdir(companion.directory, { recursive: true });
    await rm(companion.ready, { force: true });
  }
  const secrets = await secretsOf(layout);

  const signingKey = join(paths.synapse.directory, "signing.key");
  if ((await readIfExists(signingKey)) === null) {
    await write(signingKey, `ed25519 a_${randomBytes(2).toString("hex")} ${signingSeed()}\n`);
  }
  const registrationText = registration(layout.serverName, layout.bridgeUrls.whatsapp, secrets.bridges.whatsapp);
  await write(join(paths.synapse.directory, "log.yaml"), synapseLogging);
  await write(join(paths.synapse.directory, "whatsapp-registration.yaml"), registrationText);
  await write(paths.synapse.config, synapseConfig(layout, secrets));
  await write(paths.synapse.start, synapseStart);
  await write(paths.whatsapp.registration, registrationText);
  await write(paths.whatsapp.config, whatsappConfig(layout, secrets.bridges.whatsapp));
  await write(paths.whatsapp.start, whatsappStart);
  await write(paths.synapse.ready, "");
  await write(paths.whatsapp.ready, "");

  return {
    homeserver: { url: layout.synapseUrl, serverName: layout.serverName, registrationSharedSecret: secrets.registrationSharedSecret },
    bridges: { whatsapp: { url: layout.bridgeUrls.whatsapp, provisioningSecret: secrets.bridges.whatsapp.provisioningSecret } },
  };
}

/** An ed25519 seed as Synapse keeps it: the 32 bytes of the private key, unpadded base64. */
function signingSeed(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return der.subarray(der.length - 32).toString("base64").replace(/=+$/, "");
}

/** A YAML scalar; JSON strings are valid YAML. */
const q = (value: string) => JSON.stringify(value);

const portOf = (url: string) => new URL(url).port;

const header = "# Written by the Matrix plugin on every start; changes here are overwritten.";

/** Warnings and errors only, to Synapse's log. */
const synapseLogging = `${header}
version: 1
formatters:
  plain:
    format: "%(name)s %(levelname)s %(message)s"
handlers:
  console:
    class: logging.StreamHandler
    formatter: plain
root:
  level: WARNING
  handlers: [console]
disable_existing_loggers: false
`;

/**
 * Synapse serving only the Instance: no federation, no registration but the shared-secret one the
 * plugin uses, no presence, and its media in its own volume. Its database comes from
 * `DATABASE_URL` when it starts (`synapseStart`).
 */
function synapseConfig(layout: MatrixLayout, secrets: MatrixSecrets): string {
  const config = join(dataDirectory, "config");
  return `${header}
server_name: ${q(layout.serverName)}
public_baseurl: ${q(`${layout.synapseUrl}/`)}
listeners:
  # Only the client API, on the plugin's internal network: no federation listener, no published port.
  - port: ${portOf(layout.synapseUrl)}
    type: http
    bind_addresses: ["0.0.0.0"]
    tls: false
    x_forwarded: false
    resources:
      - names: [client]
        compress: false
log_config: ${q(join(config, "log.yaml"))}
media_store_path: ${q(join(dataDirectory, "media"))}
signing_key_path: ${q(join(config, "signing.key"))}
report_stats: false
enable_registration: false
registration_shared_secret: ${q(secrets.registrationSharedSecret)}
macaroon_secret_key: ${q(secrets.macaroonSecretKey)}
form_secret: ${q(secrets.formSecret)}
# Federation is off: no other homeserver is ever contacted or let in.
federation_domain_whitelist: []
trusted_key_servers: []
allow_public_rooms_over_federation: false
allow_public_rooms_without_auth: false
presence:
  enabled: false
url_preview_enabled: false
# A newly linked account brings dozens of chats at once, whose invitations a Source accepts in one run;
# a join is also an event its user sends, so the limit on sending events must let them through too.
rc_joins:
  local:
    per_second: 10
    burst_count: 1000
rc_message:
  per_second: 10
  burst_count: 1000
app_service_config_files:
  - ${q(join(config, "whatsapp-registration.yaml"))}
`;
}

/**
 * Run by the Synapse companion: copies its configuration out of its configuration volume, adds the
 * database from `DATABASE_URL`, and runs Synapse as its own user, as the image does.
 */
const synapseStart = `#!/bin/sh
${header}
set -eu
mkdir -p ${dataDirectory}/config ${dataDirectory}/media
cp ${["homeserver.yaml", "log.yaml", "signing.key", "whatsapp-registration.yaml"].map((file) => join(companionConfigDirectory, file)).join(" ")} ${dataDirectory}/config/
python - <<'PYTHON'
import json, os, urllib.parse
url = urllib.parse.urlparse(os.environ["DATABASE_URL"])
args = {
    "user": urllib.parse.unquote(url.username or ""),
    "password": urllib.parse.unquote(url.password or ""),
    "dbname": url.path.lstrip("/"),
    "host": url.hostname,
    "port": url.port or 5432,
    "cp_min": 1,
    "cp_max": 5,
}
with open("${dataDirectory}/config/database.yaml", "w") as file:
    json.dump({"database": {"name": "psycopg2", "args": args}}, file)
PYTHON
chown -R 991:991 ${dataDirectory}
chmod 600 ${dataDirectory}/config/*
exec gosu 991:991 python -m synapse.app.homeserver -c ${dataDirectory}/config/homeserver.yaml -c ${dataDirectory}/config/database.yaml
`;

function registration(serverName: string, url: string, bridge: BridgeSecrets): string {
  const messenger = whatsapp();
  const domain = serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${header}
id: whatsapp
url: ${q(url)}
as_token: ${q(bridge.asToken)}
hs_token: ${q(bridge.hsToken)}
sender_localpart: ${q(bridge.senderLocalpart)}
rate_limited: false
namespaces:
  users:
    - regex: ${q(`^@${messenger.botLocalpart}:${domain}$`)}
      exclusive: true
    - regex: ${q(`^@${messenger.ghostPrefix}.*:${domain}$`)}
      exclusive: true
`;
}

/** Stands for the bridge's egress proxy, which only the bridge's container knows (`whatsappStart`). */
const proxyPlaceholder = "@HTTPS_PROXY@";

/**
 * mautrix-whatsapp, receive only: it never shows the account online or typing, and it gets no
 * read receipts or typing notifications from Matrix to pass on. Its session stays in SQLite in its
 * own volume, outside Postgres (ADR-0006), and it reaches WhatsApp through its egress proxy. The
 * bridge adds its defaults for everything else.
 */
function whatsappConfig(layout: MatrixLayout, bridge: BridgeSecrets): string {
  return `${header}
network:
  os_name: Family Agenda
  browser_name: unknown
  proxy: ${q(proxyPlaceholder)}
  send_presence_on_typing: false
  force_active_delivery_receipts: false
  enable_status_broadcast: false
  disable_status_broadcast_send: true
  call_start_notices: false
  url_previews: false
bridge:
  personal_filtering_spaces: false
  bridge_notices: false
  bridge_status_notices: none
  permissions:
    ${q(layout.serverName)}: user
database:
  type: sqlite3-fk-wal
  uri: ${q(`file:${join(dataDirectory, "mautrix-whatsapp.db")}?_txlock=immediate`)}
homeserver:
  address: ${q(layout.synapseUrl)}
  domain: ${q(layout.serverName)}
appservice:
  address: ${q(layout.bridgeUrls.whatsapp)}
  # On every address, so that the plugin reaches its provisioning API.
  hostname: 0.0.0.0
  port: ${portOf(layout.bridgeUrls.whatsapp)}
  id: whatsapp
  bot:
    username: ${whatsapp().botLocalpart}
    displayname: WhatsApp bridge bot
  # No read receipts or typing notifications from Matrix, so none reach WhatsApp.
  ephemeral_events: false
  as_token: ${q(bridge.asToken)}
  hs_token: ${q(bridge.hsToken)}
  username_template: ${whatsapp().ghostPrefix}{{.}}
matrix:
  message_status_events: false
  delivery_receipts: false
  message_error_notices: false
  federate_rooms: false
provisioning:
  shared_secret: ${q(bridge.provisioningSecret)}
  allow_matrix_auth: false
backfill:
  enabled: true
  max_initial_messages: 50
  max_catchup_messages: 500
encryption:
  allow: false
logging:
  min_level: warn
  writers:
    - type: stdout
      format: json
`;
}

/**
 * Run by the WhatsApp companion: copies its configuration out of its configuration volume, puts in its
 * egress proxy, and runs the bridge as its own user, as the image does, without letting it
 * rewrite the configuration.
 */
const whatsappStart = `#!/bin/sh
${header}
set -eu
mkdir -p ${dataDirectory}
sed "s|${proxyPlaceholder}|\${HTTPS_PROXY:-}|" ${companionConfigDirectory}/config.yaml > ${dataDirectory}/config.yaml
cp ${companionConfigDirectory}/registration.yaml ${dataDirectory}/registration.yaml
chown -R 1337:1337 ${dataDirectory}
chmod 600 ${dataDirectory}/config.yaml ${dataDirectory}/registration.yaml
exec su-exec 1337:1337 /usr/bin/mautrix-whatsapp -c ${dataDirectory}/config.yaml -r ${dataDirectory}/registration.yaml -n
`;

/** The WhatsApp Messenger, whose bot and ghost users its bridge's configuration names. */
function whatsapp(): Messenger {
  const messenger = messengerOf("whatsapp");
  if (!messenger) throw new Error("The WhatsApp Messenger is missing from messengers.ts.");
  return messenger;
}

/** Writes a file whole or not at all: into a temporary file next to it, then renamed over it. */
async function write(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

/** A file's text, or null when it does not exist; any other failure to read it is thrown. */
async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}
