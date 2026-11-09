import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { IngestResult, RunContext, SourceRecord } from "@family-agenda/plugin-contract";
import { PluginError } from "@family-agenda/plugin-kit";
import { createPluginHandler } from "@family-agenda/plugin-kit/server";
import { pluginClient, type Call } from "@family-agenda/plugin-kit/testing";
import { describePluginContract } from "@family-agenda/plugin-kit/vitest";
import type { MatrixInstance } from "../src/instance";
import { createMatrixPlugin, type MatrixPluginOptions } from "../src/plugin";
import { FakeHomeserver } from "./fake-homeserver";

const now = new Date("2026-09-14T07:30:00Z");
const days = 24 * 60 * 60 * 1000;

const homeserver = new FakeHomeserver();
await homeserver.start();
afterAll(() => homeserver.close());

const handlerOf = (options: Partial<MatrixPluginOptions> = {}) =>
  createPluginHandler(createMatrixPlugin({ instance: homeserver.instance(), timeoutMs: 5000, log: () => undefined, ...options }));

const plugin = (options: Partial<MatrixPluginOptions> = {}): Call => pluginClient(handlerOf(options));

/** Calls an endpoint as the core does; an error answer becomes the PluginError it carries. */
async function invoke<T = unknown>(of: Call, name: Parameters<Call>[0], body?: unknown): Promise<T> {
  const answer = await of(name, body);
  if (answer.status >= 300) {
    const error = answer.body as { kind: PluginError["kind"]; message: string };
    throw new PluginError(error.kind, error.message);
  }
  return answer.body as T;
}

const context = (config: RunContext["config"], syncCursor: string | null = null, at = now) => ({
  config,
  syncCursor,
  now: at.toISOString(),
  timeZone: "Europe/Berlin",
});

/** Adds a Source as the core does: the plugin creates its Matrix user, whose values go into its configuration. */
async function addSource(of: Call = plugin()): Promise<RunContext["config"]> {
  const config = { plain: { messenger: "whatsapp" }, secrets: {} };
  const prepared = await invoke<RunContext["config"]>(of, "sourceAdded", { config, now: now.toISOString(), timeZone: "Europe/Berlin" });
  return { plain: { ...config.plain, ...prepared.plain }, secrets: prepared.secrets };
}

const userOf = (config: RunContext["config"]) => config.plain.userId as string;

/** The Source Attributes the core keeps for a Source, as the poll results declare and archive them. */
function recordingAttributes() {
  const active = new Map<string, string>();
  return {
    apply(attributes: IngestResult["attributes"]) {
      for (const { externalId, name } of attributes?.declared ?? []) active.set(externalId, name);
      for (const externalId of attributes?.archived ?? []) active.delete(externalId);
    },
    declare(attributes: { externalId: string; name: string }[]) {
      this.apply({ declared: attributes, archived: [] });
      return Promise.resolve();
    },
    names: () => Object.fromEntries(active),
  };
}

async function poll(
  config: RunContext["config"],
  syncCursor: string | null = null,
  of: Call = plugin(),
  at = now,
  attributes = recordingAttributes(),
): Promise<IngestResult> {
  const result = await invoke<IngestResult>(of, "poll", context(config, syncCursor, at));
  attributes.apply(result.attributes);
  return result;
}

const allowListing = (config: RunContext["config"], ...chats: string[]): RunContext["config"] => ({
  ...config,
  plain: { ...config.plain, chats },
});

const choicesOf = async (config: RunContext["config"], syncCursor: string | null, of: Call = plugin()) =>
  (await invoke<{ choices: { value: string; label: string }[] }>(of, "fieldChoices", { field: "chats", context: context(config, syncCursor) })).choices;

const progressOf = (config: RunContext["config"], of: Call = plugin()) =>
  invoke<{ status: string; message?: unknown; qrCode?: string }>(of, "setupProgress", { stepId: "login", context: context(config) });

const base64 = (bytes: string | Uint8Array) => Buffer.from(bytes).toString("base64");

const textOf = (record: SourceRecord | undefined) => {
  if (record?.content.kind !== "raw-message") throw new Error("not a raw message");
  return record.content.text;
};

/** A port nothing listens on yet. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** A recorded `/sync` response, with the Source's own user and an uploaded PDF put in. */
function recorded(name: string, user: string, pdf = ""): never {
  const text = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(text.replaceAll("{{user}}", user).replaceAll("{{pdf}}", pdf)) as never;
}

// A Source linked to WhatsApp, reading one class group, for the contract tests.
const contractConfig = await addSource();
homeserver.setLogin(userOf(contractConfig), "CONNECTED");
const contractRoom = homeserver.createRoom("Klasse 5b Eltern", { [homeserver.ghost("4917612345678")]: "Frau Berger (WA)" });
homeserver.addMember(contractRoom, userOf(contractConfig));
homeserver.text(contractRoom, homeserver.ghost("4917612345678"), "Elternabend am Donnerstag um 19:30 Uhr.", new Date("2026-09-14T06:00:00Z"));

describePluginContract(() => handlerOf(), {
  config: allowListing(contractConfig, homeserver.jidOf(contractRoom)),
  now,
  languages: ["de"],
});

describe("recorded /sync responses", () => {
  const club = "!nEwClubRoomFussball:family-agenda.local";
  // The groups' WhatsApp JIDs, as the bridge's `m.bridge` events give them.
  const klasseJid = "120363187638819327@g.us";
  const clubJid = "120363408179389935@g.us";
  let config: RunContext["config"];
  beforeEach(async () => {
    config = allowListing(await addSource(), klasseJid, clubJid);
    homeserver.setLogin(userOf(config), "CONNECTED");
  });

  it("turns the messages of allow-listed chats into raw messages, and nothing else", async () => {
    const pdf = homeserver.upload(new TextEncoder().encode("%PDF-1.4\n"));
    homeserver.replaySync(userOf(config), [recorded("sync-initial", userOf(config), pdf)]);

    const { sourceRecords } = await poll(config);

    expect(sourceRecords.map((record) => record.externalId)).toEqual([
      "$WnDtrip5bfriday0aTreffpunktSchultor8Uhr0001",
      "$PdFeinverstaendniserklaerungMittwoch000002",
      "$ReplyJonasPapaMitbringen0000000000000003",
    ]);
    expect(sourceRecords[0]).toEqual({
      externalId: "$WnDtrip5bfriday0aTreffpunktSchultor8Uhr0001",
      occurredAt: "2026-09-14T06:12:00.000Z",
      attributes: [klasseJid],
      sender: "Frau Berger (WA)",
      subject: "Klasse 5b Eltern",
      content: {
        kind: "raw-message",
        text: "Liebe Eltern, am Freitag, 18.09., ist Wandertag. Treffpunkt 8:00 Uhr am Schultor.",
        attachments: [],
      },
    });
    expect(sourceRecords[1]?.content).toMatchObject({
      text: "Hier die Einverständniserklärung, bitte bis Mittwoch zurück.",
      attachments: [{ filename: "einverstaendnis.pdf", contentType: "application/pdf", bytes: base64("%PDF-1.4\n") }],
    });
    expect(sourceRecords[2]?.sender).toBe("Jonas' Papa (WA)");
  });

  it("accepts only invitations of its own bridge", async () => {
    homeserver.replaySync(userOf(config), [recorded("sync-initial", userOf(config))]);

    await poll(config);

    const joins = homeserver.requests.filter((request) => request.includes("/join"));
    expect(joins).toContain(`POST /_matrix/client/v3/rooms/${encodeURIComponent(club)}/join`);
    expect(joins.some((request) => request.includes("evil.example"))).toBe(false);
  });

  it("withdraws redacted messages", async () => {
    homeserver.replaySync(userOf(config), [recorded("sync-initial", userOf(config)), recorded("sync-redaction", userOf(config))]);
    const first = await poll(config);

    const second = await poll(config, first.syncCursor);

    expect(second.sourceRecords).toEqual([]);
    expect(second.withdrawn).toEqual(["$WnDtrip5bfriday0aTreffpunktSchultor8Uhr0001", "$PrivateOmaKaffeeSonntag00000000000000006"]);
  });

  it("reads the bridge's backfill as ordinary messages, with their send times", async () => {
    homeserver.replaySync(userOf(config), [recorded("sync-initial", userOf(config)), recorded("sync-backfill", userOf(config))]);
    const first = await poll(config);

    const { sourceRecords, syncCursor } = await poll(config, first.syncCursor);

    expect(sourceRecords.map((record) => [record.occurredAt, record.subject, textOf(record)])).toEqual([
      ["2026-09-12T08:00:00.000Z", "FC Eltern U11", "Training am Dienstag fällt aus, Platz gesperrt."],
      ["2026-09-13T06:13:20.000Z", "FC Eltern U11", "Samstag Turnier in Musterstadt, Abfahrt 9 Uhr."],
    ]);
    // The chats a Source can allow-list are the group chats, named as the bridge names them.
    const choices = await choicesOf(config, syncCursor);
    expect(choices).toEqual([
      { value: clubJid, label: "FC Eltern U11" },
      { value: klasseJid, label: "Klasse 5b Eltern" },
    ]);
  });
});

describe("the bridge's login states", () => {
  let config: RunContext["config"];
  beforeEach(async () => {
    config = await addSource();
  });

  const failure = async () => {
    try {
      await poll(config);
    } catch (error) {
      if (error instanceof PluginError) return { kind: error.kind, message: error.message };
      throw error;
    }
    throw new Error("the run did not fail");
  };

  it("is a definite error before the account is linked", async () => {
    expect(await failure()).toEqual({ kind: "definite", message: "The WhatsApp account is not linked. Press Fix to scan the QR code." });
  });

  it("is a definite error once the account is logged out", async () => {
    homeserver.setLogin(userOf(config), "LOGGED_OUT", "Unlinked from the phone");

    expect(await failure()).toEqual({
      kind: "definite",
      message: "The WhatsApp account was logged out (Unlinked from the phone). Press Fix to scan the QR code again.",
    });
  });

  it("reads while the bridge reconnects", async () => {
    homeserver.setLogin(userOf(config), "TRANSIENT_DISCONNECT");

    await expect(poll(config)).resolves.toMatchObject({ sourceRecords: [] });
  });

  it("is a temporary error while the bridge does not answer", async () => {
    homeserver.bridgeRunning = false;
    try {
      expect((await failure()).kind).toBe("temporary");
    } finally {
      homeserver.bridgeRunning = true;
    }
  });

  it("is a definite error once the homeserver no longer knows the Source's user", async () => {
    homeserver.setLogin(userOf(config), "CONNECTED");

    config = { ...config, secrets: { accessToken: "syt_forgotten" } };

    expect((await failure()).kind).toBe("definite");
  });
});

describe("linking the account by QR code", () => {
  it("shows the bridge's QR codes until the phone scans one", async () => {
    const of = plugin();
    const config = await addSource(of);
    const progress = () => progressOf(config, of);

    const first = await progress();
    expect(first).toMatchObject({ status: "waiting", qrCode: expect.stringMatching(/^2@qr-code-\d+$/) as unknown });
    expect(await progress()).toEqual(first);

    await waitUntil(() => Promise.resolve(homeserver.awaitsScan(userOf(config))));
    homeserver.refreshQr(userOf(config));
    const qrCode = async () => {
      const shown = await progress();
      return shown.status === "waiting" ? shown.qrCode : null;
    };
    await waitUntil(async () => (await qrCode()) !== (first.status === "waiting" ? first.qrCode : null));
    expect(await qrCode()).toMatch(/^2@qr-code-\d+$/);

    await waitUntil(() => Promise.resolve(homeserver.awaitsScan(userOf(config))));
    homeserver.scanQr(userOf(config));
    await waitUntil(async () => (await progress()).status === "done");
    // Once linked, the Source reads.
    await expect(poll(config)).resolves.toMatchObject({ sourceRecords: [] });
  });

  it("waits while the bridge does not answer, and fails when it refuses the login", async () => {
    const config = await addSource();
    homeserver.bridgeRunning = false;
    try {
      expect(await progressOf(config)).toMatchObject({ status: "waiting" });
    } finally {
      homeserver.bridgeRunning = true;
    }

    const wrongSecret = { ...homeserver.instance(), bridges: { whatsapp: { url: homeserver.url, provisioningSecret: "wrong" } } };
    const refused = await progressOf(config, plugin({ instance: wrongSecret }));

    expect(refused).toMatchObject({ status: "failed", message: expect.stringContaining("bridge could not start the login") as unknown });
  });

  it("fails for a Source without a known Messenger", async () => {
    const config = { plain: { messenger: "icq", userId: "@x:y" }, secrets: { accessToken: "t" } };

    expect(await progressOf(config)).toMatchObject({ status: "failed" });
  });

  it("says it is done for an account already linked", async () => {
    const of = plugin();
    const config = await addSource(of);
    homeserver.setLogin(userOf(config), "CONNECTED");

    expect(await progressOf(config, of)).toMatchObject({ status: "done" });
  });
});

describe("chats", () => {
  let config: RunContext["config"];
  let room: string;
  let jid: string;
  const sender = homeserver.ghost("4917612345678");
  beforeEach(async () => {
    config = await addSource();
    homeserver.setLogin(userOf(config), "CONNECTED");
    room = homeserver.createRoom("Klasse 5b Eltern", { [sender]: "Frau Berger (WA)" });
    jid = homeserver.jidOf(room);
    homeserver.invite(room, userOf(config));
  });

  it("are read only once allow-listed, then back for two weeks", async () => {
    homeserver.text(room, sender, "Vor drei Wochen: Schulfest.", new Date(now.getTime() - 21 * days));
    homeserver.text(room, sender, "Vor einer Woche: Wandertag am Freitag.", new Date(now.getTime() - 7 * days));
    const first = await poll(config);
    expect(first.sourceRecords).toEqual([]);
    expect(homeserver.isMember(room, userOf(config))).toBe(true);

    const second = await poll(allowListing(config, jid), first.syncCursor);

    expect(second.sourceRecords.map(textOf)).toEqual(["Vor einer Woche: Wandertag am Freitag."]);
    const third = await poll(allowListing(config, jid), second.syncCursor);
    expect(third.sourceRecords).toEqual([]);
  });

  it("are read back when the timeline since the last run was cut short", async () => {
    const first = await poll(allowListing(config, jid));
    for (let message = 1; message <= 60; message++) {
      homeserver.text(room, sender, `Nachricht ${message}`, new Date(now.getTime() - 60_000 + message * 1000));
    }

    const { sourceRecords } = await poll(allowListing(config, jid), first.syncCursor);

    expect(sourceRecords.map(textOf)).toEqual(Array.from({ length: 60 }, (_, index) => `Nachricht ${index + 1}`));
  });

  it("keep an edit as a message of its own in the edited message's conversation", async () => {
    const first = await poll(allowListing(config, jid));
    const original = homeserver.text(room, sender, "Elternabend um 19 Uhr", now);
    homeserver.send(
      room,
      sender,
      {
        msgtype: "m.text",
        body: "* Elternabend um 19:30 Uhr",
        "m.new_content": { msgtype: "m.text", body: "Elternabend um 19:30 Uhr" },
        "m.relates_to": { rel_type: "m.replace", event_id: original },
      },
      now,
    );

    const { sourceRecords } = await poll(allowListing(config, jid), first.syncCursor);

    expect(sourceRecords.map(textOf)).toEqual(["Elternabend um 19 Uhr", "Elternabend um 19:30 Uhr"]);
  });

  it("keep the files of file messages, with their captions", async () => {
    const first = await poll(allowListing(config, jid));
    const bytes = new TextEncoder().encode("%PDF-1.4\n");
    const url = homeserver.upload(bytes);
    homeserver.send(room, sender, { msgtype: "m.file", body: "Bitte bis Mittwoch.", filename: "zettel.pdf", url, info: { mimetype: "application/pdf", size: bytes.length } }, now);
    homeserver.send(room, sender, { msgtype: "m.image", body: "plan.png", url: homeserver.upload(bytes) }, now);
    homeserver.send(room, sender, { msgtype: "m.file", body: "", url: homeserver.upload(bytes), info: { size: "big" } }, now);

    const { sourceRecords } = await poll(allowListing(config, jid), first.syncCursor);

    expect(sourceRecords.map((record) => record.content)).toMatchObject([
      { text: "Bitte bis Mittwoch.", attachments: [{ filename: "zettel.pdf", contentType: "application/pdf", bytes: base64(bytes) }] },
      { text: "", attachments: [{ filename: "plan.png", contentType: "application/octet-stream", bytes: base64(bytes) }] },
      { text: "", attachments: [{ filename: "attachment", contentType: "application/octet-stream", bytes: base64(bytes) }] },
    ]);
  });

  it("skip files that are too large, unknown or without an address, and messages of other kinds", async () => {
    const first = await poll(allowListing(config, jid));
    const bytes = new TextEncoder().encode("x");
    homeserver.send(room, sender, { msgtype: "m.file", body: "Video", filename: "video.mp4", url: homeserver.upload(bytes), info: { size: 26 * 1024 * 1024 } }, now);
    homeserver.send(room, sender, { msgtype: "m.file", body: "Weg", filename: "weg.pdf", url: "mxc://family-agenda.local/missing" }, now);
    homeserver.send(room, sender, { msgtype: "m.file", body: "Ohne Adresse", filename: "x.pdf" }, now);
    homeserver.send(room, sender, { msgtype: "m.location", body: "geo:52,13" }, now);

    const { sourceRecords } = await poll(allowListing(config, jid), first.syncCursor);

    expect(sourceRecords.map((record) => record.content)).toMatchObject([
      { text: "Video", attachments: [] },
      { text: "Weg", attachments: [] },
      { text: "Ohne Adresse", attachments: [] },
    ]);
  });

  it("withdraw the edits of a message deleted for everyone along with it", async () => {
    const first = await poll(allowListing(config, jid));
    const original = homeserver.text(room, sender, "Elternabend um 19 Uhr", now);
    const edit = homeserver.send(
      room,
      sender,
      { msgtype: "m.text", body: "* um 19:30", "m.new_content": { msgtype: "m.text", body: "Elternabend um 19:30 Uhr" }, "m.relates_to": { rel_type: "m.replace", event_id: original } },
      now,
    );
    const second = await poll(allowListing(config, jid), first.syncCursor);
    homeserver.redact(room, original, now);

    const third = await poll(allowListing(config, jid), second.syncCursor);

    expect(third.withdrawn).toEqual([original, edit]);
  });

  it("are read back once joined when they were allow-listed before", async () => {
    const later = homeserver.createRoom("FC Eltern U11", { [sender]: "Trainer Klaus (WA)" });
    const laterJid = homeserver.jidOf(later);
    homeserver.text(later, sender, "Turnier am Samstag.", new Date(now.getTime() - 2 * days));
    const first = await poll(allowListing(config, jid, laterJid));
    homeserver.invite(later, userOf(config));
    const second = await poll(allowListing(config, jid, laterJid), first.syncCursor);

    const third = await poll(allowListing(config, jid, laterJid), second.syncCursor);

    expect([...second.sourceRecords, ...third.sourceRecords].map(textOf)).toEqual(["Turnier am Samstag."]);
  });

  it("are offered and read only when they are groups, not direct chats", async () => {
    const direct = homeserver.createRoom("Oma (WA)", { [sender]: "Oma (WA)" }, { direct: true });
    homeserver.invite(direct, userOf(config));
    const first = await poll(config);
    homeserver.text(direct, sender, "Kommt ihr Sonntag zum Kaffee?", now);

    const { sourceRecords } = await poll(allowListing(config, jid, homeserver.jidOf(direct)), first.syncCursor);

    expect(sourceRecords).toEqual([]);
    expect(await choicesOf(config, first.syncCursor)).toEqual([{ value: jid, label: "Klasse 5b Eltern" }]);
  });

  it("are told apart as groups or direct chats when joined before they were", async () => {
    const direct = homeserver.createRoom("Oma (WA)", { [sender]: "Oma (WA)" }, { direct: true });
    homeserver.invite(direct, userOf(config));
    const first = await poll(config);
    // A sync cursor written before group chats were told apart.
    const older = JSON.parse(first.syncCursor ?? "{}") as Record<string, unknown>;
    delete older.groups;

    const second = await poll(config, JSON.stringify(older));

    expect(await choicesOf(config, second.syncCursor)).toEqual([{ value: jid, label: "Klasse 5b Eltern" }]);
  });

  it("are joined on a later run when the homeserver refused to at first", async () => {
    homeserver.limitedJoins = 1;
    const first = await poll(config);
    expect(homeserver.isMember(room, userOf(config))).toBe(false);

    const second = await poll(config, first.syncCursor);

    expect(homeserver.isMember(room, userOf(config))).toBe(true);
    expect(await choicesOf(config, second.syncCursor)).toEqual([{ value: jid, label: "Klasse 5b Eltern" }]);
  });

  it("are joined when invited before the sync cursor kept invitations", async () => {
    homeserver.limitedJoins = 1;
    const first = await poll(config);
    // A sync cursor written before invitations were kept.
    const older = JSON.parse(first.syncCursor ?? "{}") as Record<string, unknown>;
    delete older.invites;

    const second = await poll(config, JSON.stringify(older));

    expect(homeserver.isMember(room, userOf(config))).toBe(true);
    expect(await choicesOf(config, second.syncCursor)).toEqual([{ value: jid, label: "Klasse 5b Eltern" }]);
  });

  it("are never written to, marked read or shown as typing, and nobody else's invitation is accepted", async () => {
    const stranger = homeserver.createRoom("Gewinnspiel");
    homeserver.invite(stranger, userOf(config), "@spam:other.example");
    const first = await poll(allowListing(config, jid));
    homeserver.text(room, sender, "Bitte bestätigen!", now);
    await poll(allowListing(config, jid), first.syncCursor);

    expect(homeserver.isMember(stranger, userOf(config))).toBe(false);
    const writes = homeserver.requests.filter((request) => /\/(send|receipt|read_markers|typing|presence|state)\//.test(request));
    expect(writes).toEqual([]);
  });
});

describe("chats as Source Attributes", () => {
  let config: RunContext["config"];
  let room: string;
  let jid: string;
  const sender = homeserver.ghost("4917612345678");
  beforeEach(async () => {
    config = await addSource();
    homeserver.setLogin(userOf(config), "CONNECTED");
    room = homeserver.createRoom("Klasse 5b Eltern", { [sender]: "Frau Berger (WA)" });
    jid = homeserver.jidOf(room);
    homeserver.invite(room, userOf(config));
  });

  it("declares an allow-listed group by its JID, named as the bridge names it, and a message names it", async () => {
    const attributes = recordingAttributes();
    const first = await poll(allowListing(config, jid), null, plugin(), now, attributes);
    homeserver.text(room, sender, "Wandertag am Freitag.", now);

    const second = await poll(allowListing(config, jid), first.syncCursor, plugin(), now, attributes);

    expect(attributes.names()).toEqual({ [jid]: "Klasse 5b Eltern" });
    expect(jid).toMatch(/@g\.us$/);
    expect(second.sourceRecords.map((record) => record.attributes)).toEqual([[jid]]);
  });

  it("declares nothing for a group the Admin has not added", async () => {
    const attributes = recordingAttributes();
    homeserver.createRoom("FC Eltern U11");

    await poll(config, null, plugin(), now, attributes);

    expect(attributes.names()).toEqual({});
  });

  it("keeps the same Source Attribute when the group is renamed, with its new name", async () => {
    const attributes = recordingAttributes();
    const first = await poll(allowListing(config, jid), null, plugin(), now, attributes);
    homeserver.rename(room, "Klasse 5b Eltern 2026", now);

    await poll(allowListing(config, jid), first.syncCursor, plugin(), now, attributes);

    expect(attributes.names()).toEqual({ [jid]: "Klasse 5b Eltern 2026" });
  });

  it("maps a portal room the bridge created again for the same group to the same Source Attribute", async () => {
    const attributes = recordingAttributes();
    const first = await poll(allowListing(config, jid), null, plugin(), now, attributes);
    // The chat is deleted on the phone and the group joined again: the bridge deletes the room and creates a new one.
    homeserver.leave(room, userOf(config));
    const recreated = homeserver.createRoom("Klasse 5b Eltern", { [sender]: "Frau Berger (WA)" }, { jid });
    homeserver.invite(recreated, userOf(config));
    const second = await poll(allowListing(config, jid), first.syncCursor, plugin(), now, attributes);
    homeserver.text(recreated, sender, "Elternabend am Donnerstag.", now);

    const third = await poll(allowListing(config, jid), second.syncCursor, plugin(), now, attributes);

    expect(recreated).not.toBe(room);
    expect(attributes.names()).toEqual({ [jid]: "Klasse 5b Eltern" });
    expect(third.sourceRecords.map((record) => [textOf(record), record.attributes])).toEqual([["Elternabend am Donnerstag.", [jid]]]);
  });

  it("archives a group that leaves the allow-list, and revives it when it is added again", async () => {
    const attributes = recordingAttributes();
    const first = await poll(allowListing(config, jid), null, plugin(), now, attributes);

    const second = await poll(allowListing(config), first.syncCursor, plugin(), now, attributes);
    expect(attributes.names()).toEqual({});

    await poll(allowListing(config, jid), second.syncCursor, plugin(), now, attributes);
    expect(attributes.names()).toEqual({ [jid]: "Klasse 5b Eltern" });
  });

  it("keeps a group declared while its room is not there, as long as it is on the allow-list", async () => {
    const attributes = recordingAttributes();
    const first = await poll(allowListing(config, jid), null, plugin(), now, attributes);
    homeserver.leave(room, userOf(config));

    await poll(allowListing(config, jid), first.syncCursor, plugin(), now, attributes);

    expect(attributes.names()).toEqual({ [jid]: "Klasse 5b Eltern" });
  });

  it("still allow-lists a group by the room id an Admin chose before groups were told apart by their JID", async () => {
    const attributes = recordingAttributes();
    const first = await poll(allowListing(config, room), null, plugin(), now, attributes);
    homeserver.text(room, sender, "Wandertag am Freitag.", now);

    const second = await poll(allowListing(config, room), first.syncCursor, plugin(), now, attributes);

    expect(attributes.names()).toEqual({ [jid]: "Klasse 5b Eltern" });
    expect(second.sourceRecords.map((record) => record.attributes)).toEqual([[jid]]);
  });

  it("archives the one Source Attribute a Source declared for its whole account before groups were Source Attributes", async () => {
    const attributes = recordingAttributes();
    await attributes.declare([{ externalId: "account", name: "WhatsApp" }]);
    const first = await poll(allowListing(config, jid), null, plugin(), now, attributes);
    // A sync cursor written before groups were Source Attributes.
    const older = JSON.parse(first.syncCursor ?? "{}") as Record<string, unknown>;
    delete older.declared;
    delete older.jids;

    await poll(allowListing(config, jid), JSON.stringify(older), plugin(), now, attributes);

    expect(attributes.names()).toEqual({ [jid]: "Klasse 5b Eltern" });
  });

  it("offers the groups by their JID", async () => {
    const first = await poll(config);

    expect(await choicesOf(config, first.syncCursor)).toEqual([{ value: jid, label: "Klasse 5b Eltern" }]);
  });
});

describe("the catalogue of Messengers", () => {
  it("lists WhatsApp as installed where its bridge runs as a companion", async () => {
    const { entries } = await invoke<{ entries: { id: string; installed: boolean }[] }>(plugin(), "catalogueEntries");

    expect(entries.map(({ id, installed }) => ({ id, installed }))).toEqual([{ id: "whatsapp", installed: true }]);
  });

  it("lists WhatsApp as not installed without its companion", async () => {
    const without = plugin({ instance: { ...homeserver.instance(), bridges: { whatsapp: { url: "http://nonexistent.invalid:29318", provisioningSecret: "s" } } } });

    const { entries } = await invoke<{ entries: unknown[] }>(without, "catalogueEntries");

    expect(entries[0]).toMatchObject({ id: "whatsapp", installed: false, riskNotice: expect.anything() as unknown });
    await expect(poll({ plain: { messenger: "whatsapp", userId: "@x:y" }, secrets: { accessToken: "t" } }, null, without)).rejects.toThrow(
      "WhatsApp is not installed on this Instance.",
    );
  });
});

describe("a Messenger still starting", () => {
  /** Synapse and the bridge at an address where nothing listens yet. */
  const closed = (url: string): MatrixInstance => ({
    homeserver: { url, serverName: homeserver.serverName, registrationSharedSecret: homeserver.registrationSharedSecret },
    bridges: { whatsapp: { url, provisioningSecret: homeserver.provisioningSecret } },
  });

  it("is a temporary error, and its setup step waits", async () => {
    const config = { plain: { messenger: "whatsapp", userId: "@x:y" }, secrets: { accessToken: "t" } };
    const starting = plugin({ instance: closed(`http://127.0.0.1:${await freePort()}`) });

    const error = await poll(config, null, starting).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "temporary", message: "WhatsApp is starting on this Instance. This takes up to a minute the first time." });
    expect(await progressOf(config, starting)).toEqual({
      status: "waiting",
      message: expect.objectContaining({ de: "WhatsApp startet auf dieser Instanz. Beim ersten Mal dauert das bis zu einer Minute." }) as unknown,
    });
  });

  it("is waited for when a Source is added right after enabling it", async () => {
    const port = await freePort();
    const adding = addSource(plugin({ instance: closed(`http://127.0.0.1:${port}`), startTimeoutMs: 5_000 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const late = new FakeHomeserver();
    await late.start(port);
    try {
      expect((await adding).plain.userId).toMatch(/^@family-agenda-[0-9a-f]{12}:/);
    } finally {
      await late.close();
    }
  });

  it("is a temporary error without the message of the failure when Synapse does not come up in time", async () => {
    const logged: unknown[] = [];
    const starting = plugin({ instance: closed(`http://127.0.0.1:${await freePort()}`), startTimeoutMs: 0, log: (_, error) => logged.push(error) });

    await expect(addSource(starting)).rejects.toMatchObject({ kind: "temporary", message: expect.stringContaining("WhatsApp is starting") as unknown });
    expect(logged).toHaveLength(1);
  });
});

describe("a removed Source", () => {
  it("unlinks its account from the Messenger and signs its Matrix user out", async () => {
    const of = plugin();
    const config = await addSource(of);
    homeserver.setLogin(userOf(config), "CONNECTED");

    await invoke(of, "sourceRemoved", { config, syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin" });

    await expect(poll(config)).rejects.toThrow("The WhatsApp account is not linked.");
    homeserver.setLogin(userOf(config), "CONNECTED");
    await expect(poll(config)).rejects.toThrow("no longer knows the Source's Matrix user");
  });
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}
