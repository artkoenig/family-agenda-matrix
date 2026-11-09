import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeConfiguration, type MatrixLayout } from "../src/configuration";

describe("the configuration the plugin writes for Synapse and the bridges", () => {
  let root: string;
  let layout: MatrixLayout;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agenda-matrix-"));
    layout = {
      configDirectory: root,
      serverName: "family-agenda.local",
      synapseUrl: "http://plugin-matrix-synapse:8008",
      bridgeUrls: { whatsapp: "http://plugin-matrix-whatsapp:29318" },
    };
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const read = (...path: string[]) => readFile(join(root, ...path), "utf8");

  it("keeps Synapse to the Instance: no federation, no registration, no presence", async () => {
    await writeConfiguration(layout);

    const homeserver = await read("synapse", "homeserver.yaml");
    expect(homeserver).toContain("enable_registration: false");
    expect(homeserver).toContain("federation_domain_whitelist: []");
    expect(homeserver).toMatch(/presence:\n {2}enabled: false/);
    expect(homeserver).toContain("      - names: [client]");
    expect(homeserver).not.toContain("federation]");
    expect(homeserver).toContain("  - port: 8008");
    // Media stays in Synapse's own volume; its database comes from DATABASE_URL when it starts.
    expect(homeserver).toContain('media_store_path: "/data/media"');
    expect(homeserver).not.toContain("database:");
    expect(await read("synapse", "start.sh")).toContain('os.environ["DATABASE_URL"]');
    // A Source joins all the chats of a newly linked account in one run.
    expect(homeserver).toMatch(/rc_joins:\n {2}local:\n {4}per_second: 10\n {4}burst_count: 1000/);
    expect(homeserver).toMatch(/rc_message:\n {2}per_second: 10\n {2}burst_count: 1000/);
    expect(await read("synapse", "signing.key")).toMatch(/^ed25519 a_[0-9a-f]{4} [A-Za-z0-9+/]{43}\n$/);
  });

  it("configures the WhatsApp bridge to receive only, matching its registration and what the plugin reads", async () => {
    const instance = await writeConfiguration(layout);

    const config = await read("whatsapp", "config.yaml");
    const registration = await read("whatsapp", "registration.yaml");
    expect(config).toContain("send_presence_on_typing: false");
    expect(config).toContain("ephemeral_events: false");
    expect(config).toContain("delivery_receipts: false");
    expect(config).toContain('address: "http://plugin-matrix-synapse:8008"');
    expect(config).toContain('proxy: "@HTTPS_PROXY@"');
    expect(await read("whatsapp", "start.sh")).toContain("${HTTPS_PROXY:-}");
    const asToken = /as_token: "([^"]+)"/.exec(registration)?.[1];
    expect(config).toContain(`as_token: "${asToken}"`);
    expect(registration).toContain(String.raw`regex: "^@whatsapp_.*:family-agenda\\.local$"`);
    expect(registration).toContain('url: "http://plugin-matrix-whatsapp:29318"');
    expect(await read("synapse", "whatsapp-registration.yaml")).toBe(registration);
    expect(config).toContain(`shared_secret: "${instance.bridges.whatsapp!.provisioningSecret}"`);
    expect(instance.homeserver.url).toBe("http://plugin-matrix-synapse:8008");
    expect(instance.bridges.whatsapp!.url).toBe("http://plugin-matrix-whatsapp:29318");
    expect(await read("synapse", "homeserver.yaml")).toContain(`registration_shared_secret: "${instance.homeserver.registrationSharedSecret}"`);
  });

  it("writes the ready file the companions wait for last, and keeps every file to its owner", async () => {
    await writeConfiguration(layout);

    expect(await read("ready")).toBe("");
    for (const file of ["secrets.json", "synapse/homeserver.yaml", "synapse/signing.key", "whatsapp/config.yaml"]) {
      expect((await stat(join(root, file))).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps its secrets and signing key when it runs again", async () => {
    const first = await writeConfiguration(layout);
    const files = () => Promise.all([read("secrets.json"), read("whatsapp", "registration.yaml"), read("synapse", "signing.key")]);
    const before = await files();

    expect(await writeConfiguration(layout)).toEqual(first);
    expect(await files()).toEqual(before);
  });
});
