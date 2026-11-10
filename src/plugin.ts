import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { EndpointResponse, IngestResult, RunContext, SourceRecord } from "@family-agenda/plugin-contract";
import { PluginError, type PluginImplementation } from "@family-agenda/plugin-kit";
import packageJson from "../package.json" with { type: "json" };
import {
  bridgeClient,
  RefusedError,
  homeserverClient,
  type BridgeClient,
  type HomeserverClient,
  type Invites,
  type JoinedRoom,
  type MatrixEvent,
  type SyncResponse,
} from "./homeserver";
import type { MatrixInstance } from "./instance";
import { messengerOf, messengers, type Messenger } from "./messengers";
import { englishOf, type PluginText } from "./texts";

export type MatrixPluginOptions = {
  /** How the plugin reaches Synapse and the bridges, its companions. */
  instance: MatrixInstance;
  /** How long a request to the homeserver or a bridge may take before the call fails. */
  timeoutMs?: number;
  /**
   * How long adding a Source waits for the homeserver, which takes a while to start the first
   * time; below the core's call timeout of 10 seconds.
   */
  startTimeoutMs?: number;
  /**
   * Where the details of a failure go, which the core never gets, as they may hold a token or a
   * server's reply; to stderr by default.
   */
  log?: (message: string, error: unknown) => void;
  /**
   * How long a companion may fail to answer before that is a definite error, which needs an
   * Admin: it is misconfigured, or keeps crashing.
   */
  failingAfterMs?: number;
};

/** The plugin's own version: that of package.json, raised with each release. */
export const version: string = packageJson.version;

type Config = RunContext["config"];
type SetupProgress = EndpointResponse<"setupProgress">;
type Attachment = { filename: string; contentType: string; bytes: string };
type Choice = { value: string; label: string };
type Attributes = NonNullable<IngestResult["attributes"]>;

/**
 * The sync cursor: where `/sync` resumes, the names of the joined rooms and of the senders seen,
 * whether each joined room is a group chat, the WhatsApp JID the bridge gives each room, the
 * bridge's invitations not accepted yet, which `/sync` names only once, the allow-listed rooms
 * read so far, so that a room allow-listed later is read back first, the groups declared as
 * Source Attributes by their JID, and the edits of each message read, which go with it when it is
 * redacted.
 */
type State = {
  since: string;
  rooms: Record<string, string>;
  groups: Record<string, boolean>;
  jids: Record<string, string>;
  declared: string[];
  invites: Record<string, string>;
  names: Record<string, string>;
  read: string[];
  edits: Record<string, string[]>;
};

/** How far back a newly allow-listed chat is read, so that a busy group does not bring years of messages. */
const backfillDays = 14;

/** How many events of one room a run reads back at most, through `/messages`. */
const maximumBackfillEvents = 500;

/** The largest attachment kept, such as a PDF; larger ones are left out. */
const maximumAttachmentBytes = 25 * 1024 * 1024;

/** Room types the bridge marks rooms with that are not group chats. */
const nonGroupRoomTypes = new Set(["dm", "space"]);

/** Message types whose `body` is the text of the message. */
const textTypes = new Set(["m.text", "m.notice", "m.emote"]);

/** Message types whose file is kept as an attachment. */
const fileTypes = new Set(["m.file", "m.image"]);

/** Login states of a bridge in which the account still works, if perhaps not at the moment. */
const workingStates = new Set(["CONNECTED", "BACKFILLING", "CONNECTING", "TRANSIENT_DISCONNECT", "RUNNING", "STARTING"]);

/** Login states that need an Admin to link the account again. */
const loggedOutStates = new Set(["LOGGED_OUT", "BAD_CREDENTIALS"]);

/** A QR code login going on for a Matrix user, kept while the Admin area polls it. */
type LoginSession = { qrCode: string | null; outcome: "waiting" | "done" | { failed: PluginText } };

/** Whether a bridge's companion answers, does not exist on the Instance, or does not answer yet. */
type Reachability = "up" | "missing" | "down";

/**
 * Reads Messengers such as WhatsApp through bridges on the Instance's own homeserver (ADR-0011),
 * Synapse and one bridge per Messenger, which run as the plugin's companions. Each Source is one
 * linked Messenger account, read by a Matrix user the plugin creates for it. It only receives: its
 * users never post, never mark a room read, and join only rooms their own bridge invites them to.
 * A singleton: the QR code logins in progress live in its memory.
 */
export function createMatrixPlugin(options: MatrixPluginOptions): PluginImplementation {
  const { instance } = options;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const startTimeoutMs = options.startTimeoutMs ?? 8_000;
  const log = options.log ?? ((message: string, error: unknown) => console.error(message, error));
  const homeserver = homeserverClient({ url: instance.homeserver.url, timeoutMs });
  const sessions = new Map<string, LoginSession>();
  const failingAfterMs = options.failingAfterMs ?? 10 * 60_000;
  /** Since when each companion, by Messenger id or `homeserver`, has not answered. */
  const failingSince = new Map<string, number>();

  /** Notes that a companion did not answer; whether it has not for longer than `failingAfterMs`. */
  function failingTooLong(companion: string): boolean {
    const now = Date.now();
    const since = failingSince.get(companion) ?? now;
    failingSince.set(companion, since);
    return now - since >= failingAfterMs;
  }

  /** That a companion has not answered for too long: a definite error, so that an Admin looks. */
  function keepsFailing(name: string): PluginError {
    const minutes = Math.round(failingAfterMs / 60_000);
    return new PluginError(
      "definite",
      `${name} has not answered for ${minutes} minutes. It is misconfigured or keeps failing; the logs of the Matrix plugin and its companions say why.`,
    );
  }

  /** Whether the bridge of a Messenger answers: a companion not in plugins.yml has no address at all. */
  async function reachability(messenger: Messenger): Promise<Reachability> {
    const bridge = instance.bridges[messenger.id];
    if (!bridge) return "missing";
    try {
      const response = await fetch(new URL("/_matrix/mau/live", bridge.url), { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) failingSince.delete(messenger.id);
      return response.ok ? "up" : "down";
    } catch (error) {
      return causeCodeOf(error) === "ENOTFOUND" ? "missing" : "down";
    }
  }

  /** Why a Messenger cannot be reached now: not installed, still starting, or failing for too long. */
  async function unavailable(messenger: Messenger): Promise<PluginError> {
    const reachable = await reachability(messenger);
    if (reachable === "missing") return new PluginError("definite", `${messenger.attributeValue} is not installed on this Instance.`);
    if (reachable === "down" && failingTooLong(messenger.id)) return keepsFailing(`The ${messenger.attributeValue} bridge`);
    return new PluginError("temporary", englishOf(starting(messenger)));
  }

  /** The bridge of a Source's Messenger, or why it cannot be read. */
  function connectionOf(plain: Config["plain"]): { messenger: Messenger; bridge: BridgeClient | null } {
    const messenger = messengerOf(plain.messenger);
    if (!messenger) throw new PluginError("definite", "The Source names no Messenger the Matrix plugin knows.");
    const bridge = instance.bridges[messenger.id];
    return { messenger, bridge: bridge ? bridgeClient({ url: bridge.url, secret: bridge.provisioningSecret, timeoutMs }) : null };
  }

  /** The bridge of a Source's Messenger, failing when it is not installed. */
  async function bridgeOf(plain: Config["plain"]): Promise<{ messenger: Messenger; bridge: BridgeClient }> {
    const { messenger, bridge } = connectionOf(plain);
    if (!bridge) throw await unavailable(messenger);
    return { messenger, bridge };
  }

  /** Fails the run unless the bridge has a working login for the Source's account. */
  async function checkLogin(bridge: BridgeClient, messenger: Messenger, userId: string): Promise<void> {
    let logins;
    try {
      logins = await bridge.logins(userId);
    } catch (error) {
      if (!(error instanceof RefusedError)) throw await unavailable(messenger);
      log(`The ${messenger.attributeValue} bridge refused to list the logins:`, error);
      throw new PluginError("temporary", `The ${messenger.attributeValue} bridge could not be reached.`);
    }
    loginStateProblem(logins, messenger.attributeValue, log);
  }

  async function poll(context: RunContext): Promise<IngestResult> {
    const { messenger, bridge } = await bridgeOf(context.config.plain);
    const { userId, token } = accountOf(context.config);
    await checkLogin(bridge, messenger, userId);
    const previous = parseState(context.syncCursor);
    const backfillStart = new Date(context.now).getTime() - backfillDays * 24 * 60 * 60 * 1000;
    const serverName = instance.homeserver.serverName;

    try {
      const sync = await homeserver.sync(token, previous?.since ?? null);
      const state: State = { since: sync.next_batch, ...previousFields(previous), declared: [], read: [] };
      const left = pruneLeft(state, sync);
      await syncInvitations(state, homeserver, token, { userId, messenger, serverName }, sync, left, previous);
      syncJoined(state, sync);
      await classify(state, homeserver, token);
      const { allowListed, attributes } = declareAllowed(state, previous, chatsOf(context.config.plain.chats));

      const { withdrawn, events } = await collectEvents(state, homeserver, token, sync, previous, allowListed, backfillStart);

      // Chats allow-listed but not joined yet are read back once they are.
      state.read = [...allowListed].filter((roomId) => roomId in state.rooms);
      pruneEdits(state, events, withdrawn);

      const sourceRecords = await recordsOf(events, withdrawn, { state, userId, token, messenger, homeserver, serverName });
      return { sourceRecords, syncCursor: JSON.stringify(state), ...(withdrawn.size > 0 ? { withdrawn: [...withdrawn] } : {}), attributes };
    } catch (error) {
      throw homeserverError(error, log);
    }
  }

  async function progress(context: RunContext): Promise<SetupProgress> {
    let connection;
    try {
      connection = await bridgeOf(context.config.plain);
    } catch (error) {
      return notYet(error, messengerOf(context.config.plain.messenger));
    }
    const { messenger, bridge } = connection;
    const { userId } = accountOf(context.config);
    const session = sessions.get(userId);
    if (session) return sessionProgress(userId, session, messenger);
    return startLoginOrExplain(bridge, userId, messenger);
  }

  /** The first step of a login; why it could not start when the bridge does not answer or refuses. */
  async function startLoginOrExplain(bridge: BridgeClient, userId: string, messenger: Messenger): Promise<SetupProgress> {
    try {
      return await startLogin(bridge, userId, messenger);
    } catch (error) {
      if (!(error instanceof RefusedError)) return notYet(await unavailable(messenger), messenger);
      log(`The ${messenger.attributeValue} bridge refused to start a login:`, error);
      return { status: "failed", message: `The ${messenger.attributeValue} bridge could not start the login.` };
    }
  }

  /** How the login in progress stands; one that ended is reported once and forgotten. */
  function sessionProgress(userId: string, session: LoginSession, messenger: Messenger): SetupProgress {
    if (session.outcome === "waiting") return waiting(messenger, session.qrCode);
    sessions.delete(userId);
    if (session.outcome === "done") return { status: "done", message: linked(messenger) };
    return { status: "failed", message: session.outcome.failed };
  }

  async function startLogin(bridge: BridgeClient, userId: string, messenger: Messenger): Promise<SetupProgress> {
    if ((await bridge.logins(userId)).some((login) => workingStates.has(login.stateEvent))) {
      return { status: "done", message: linked(messenger) };
    }
    const step = await bridge.startLogin(userId, messenger.qrLoginFlow);
    if (step.type === "complete") return { status: "done", message: linked(messenger) };
    if (step.type !== "display_and_wait") return { status: "failed", message: unexpectedStep(step, messenger, log) };
    const started: LoginSession = { qrCode: step.qrCode, outcome: "waiting" };
    sessions.set(userId, started);
    void awaitScan(bridge, userId, step, started, messenger, log);
    return waiting(messenger, started.qrCode);
  }

  async function catalogueEntries(): Promise<EndpointResponse<"catalogueEntries">> {
    const entries = [];
    for (const messenger of messengers) {
      entries.push({
        id: messenger.id,
        displayName: messenger.displayName,
        description: messenger.description,
        installed: (await reachability(messenger)) !== "missing",
        ...(messenger.riskNotice ? { riskNotice: messenger.riskNotice } : {}),
      });
    }
    return { entries };
  }

  async function sourceAdded(context: Omit<RunContext, "syncCursor">): Promise<Config> {
    const { messenger } = connectionOf(context.config.plain);
    if (!instance.bridges[messenger.id]) throw await unavailable(messenger);
    // An Admin may add a Source right after enabling a Messenger, while Synapse still starts.
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      try {
        const account = await homeserver.register(`family-agenda-${randomBytes(6).toString("hex")}`, instance.homeserver.registrationSharedSecret);
        failingSince.delete("homeserver");
        return { plain: { userId: account.userId }, secrets: { accessToken: account.accessToken } };
      } catch (error) {
        if (error instanceof RefusedError || Date.now() >= deadline) {
          log("The homeserver could not create a Matrix user:", error);
          throw registrationProblem(error, messenger);
        }
        await sleep(500);
      }
    }
  }

  /** Why the homeserver created no Matrix user: it refused, or has not answered (for too long). */
  function registrationProblem(error: unknown, messenger: Messenger): PluginError {
    if (error instanceof RefusedError) {
      failingSince.delete("homeserver");
      // A wrong shared secret: Synapse's configuration does not come from this plugin's secrets.
      if (error.status === 401 || error.status === 403) {
        return new PluginError("definite", "The homeserver refused to create a Matrix user: its configuration does not match the plugin's. The logs of the Matrix plugin and of Synapse say why.");
      }
      return new PluginError("temporary", "The homeserver could not create a Matrix user.");
    }
    if (failingTooLong("homeserver")) return keepsFailing("The homeserver");
    return new PluginError("temporary", englishOf(starting(messenger)));
  }

  async function sourceRemoved(context: RunContext): Promise<undefined> {
    const { bridge } = connectionOf(context.config.plain);
    const { userId, token } = accountOf(context.config);
    sessions.delete(userId);
    // Unlinks the device from the Messenger account, then signs the Matrix user out.
    await bridge?.logoutAll(userId).catch((error: unknown) => log("The bridge could not unlink the account:", error));
    await homeserver.logout(token);
    return undefined;
  }

  const guarded = <A extends unknown[], R>(what: string, run: (...args: A) => Promise<R>) => guard(what, run, log);

  return {
    description: {
      sourceTypeId: "matrix",
      kind: "singleton",
      displayName: { en: "Matrix", de: "Matrix" },
      version,
      description: {
        en: "Reads the group chats you choose of a Messenger account such as WhatsApp, through a bridge on the Instance's own Matrix homeserver. It only receives: it never sends messages, read receipts or typing notifications.",
        de: "Liest die Gruppenchats eines Messenger-Kontos wie WhatsApp, die du auswählst, über eine Bridge auf dem eigenen Matrix-Homeserver der Instanz. Es empfängt nur: Es sendet nie Nachrichten, Lesebestätigungen oder Tippbenachrichtigungen.",
      },
      needsLlm: true,
      configuration: {
        version: 1,
        fields: [
          {
            key: "messenger",
            label: { en: "Messenger", de: "Messenger" },
            secret: false,
            required: true,
            hasChoices: false,
            description: {
              en: "The Messenger whose account this Source links. It cannot be changed later.",
              de: "Der Messenger, dessen Konto diese Quelle verknüpft. Er lässt sich später nicht ändern.",
            },
          },
          {
            key: "chats",
            label: { en: "Chats to read", de: "Zu lesende Chats" },
            secret: false,
            required: false,
            hasChoices: true,
            description: {
              en: "Only messages in the ticked chats are read, and sent to the LLM endpoint; all others are ignored. A chat ticked later is read back for two weeks.",
              de: "Nur Nachrichten in den angehakten Chats werden gelesen und an den LLM-Endpunkt geschickt; alle anderen werden ignoriert. Ein später angehakter Chat wird zwei Wochen zurück gelesen.",
            },
          },
          { key: "userId", label: { en: "Matrix user", de: "Matrix-Benutzer" }, secret: false, required: true, hasChoices: false, setByPlugin: true },
          { key: "accessToken", label: { en: "Access token", de: "Zugriffstoken" }, secret: true, required: true, hasChoices: false, setByPlugin: true },
        ],
      },
      setupSteps: [
        {
          id: "login",
          title: { en: "Link the account", de: "Konto verknüpfen" },
          description: {
            en: "Scan the QR code with the Messenger's app on the phone whose account the Family reads, as a linked device.",
            de: "Scanne den QR-Code mit der App des Messengers auf dem Handy, dessen Konto die Familie liest, als verknüpftes Gerät.",
          },
          live: true,
        },
      ],
      ingestion: { mode: "polling", suggestedIntervalSeconds: 5 * 60 },
      // Class and club groups pause for weeks in the holidays.
      silentApplies: false,
      catalogue: { title: { en: "Messengers", de: "Messenger" }, configKey: "messenger" },
    },
    poll: guarded("poll", poll),
    // The groups as the last run left them: no call to the homeserver.
    sourceAttributes: guarded("sourceAttributes", async (context) => attributesOf(context)),
    setupProgress: guarded("setupProgress", async ({ stepId, context }) => {
      if (stepId !== "login") throw new PluginError("definite", "The Matrix plugin has no such setup step.");
      return progress(context);
    }),
    fieldChoices: guarded("fieldChoices", async ({ field, context }) => {
      if (field !== "chats") throw new PluginError("definite", "This field offers no choices.");
      return { choices: chatChoices(context) };
    }),
    catalogueEntries: guarded("catalogueEntries", catalogueEntries),
    sourceAdded: guarded("sourceAdded", sourceAdded),
    sourceRemoved: guarded("sourceRemoved", sourceRemoved),
  };
}

/**
 * Runs a handler, turning every failure but a PluginError into a temporary one with a generic
 * message: the core never gets an error's own message, which may hold a token or a server's reply.
 */
function guard<A extends unknown[], R>(what: string, run: (...args: A) => Promise<R>, log: (message: string, error: unknown) => void) {
  return async (...args: A): Promise<R> => {
    try {
      return await run(...args);
    } catch (error) {
      if (error instanceof PluginError) throw error;
      log(`${what} failed:`, error);
      throw new PluginError("temporary", "The Matrix plugin failed unexpectedly; its log says why.");
    }
  };
}

/** The `code` of a failed `fetch`'s cause, such as `ENOTFOUND` for a host that does not exist. */
function causeCodeOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

function accountOf(config: Config): { userId: string; token: string } {
  const userId = config.plain.userId;
  const token = config.secrets.accessToken;
  if (typeof userId !== "string" || !token) throw new PluginError("definite", "The Source has no Matrix account. Remove it and add it again.");
  return { userId, token };
}

/** Fails unless a login works; the bridge's own reason goes to the log only, as it is the bridge's text. */
function loginStateProblem(logins: { stateEvent: string; reason: string | null }[], name: string, log: (message: string, error: unknown) => void): void {
  if (logins.some((login) => workingStates.has(login.stateEvent))) return;
  if (logins.length === 0) throw new PluginError("definite", `The ${name} account is not linked. Press Fix to scan the QR code.`);
  const loggedOut = logins.find((login) => loggedOutStates.has(login.stateEvent));
  if (!loggedOut) throw new PluginError("temporary", `The ${name} bridge reports a problem with the account.`);
  const reason = logins.map((login) => login.reason).find((found) => found !== null);
  if (reason) log(`The ${name} bridge logged the account out:`, reason);
  throw new PluginError("definite", `The ${name} account was logged out. Press Fix to scan the QR code again.`);
}

/** While the Messenger starts, the step waits; otherwise it failed. */
function notYet(error: unknown, messenger: Messenger | undefined): SetupProgress {
  if (messenger && error instanceof PluginError && error.kind === "temporary") return { status: "waiting", message: starting(messenger) };
  if (error instanceof PluginError) return { status: "failed", message: error.message };
  throw error;
}

/** That a Messenger's bridge or the homeserver is still starting. */
function starting(messenger: Messenger): PluginText {
  const name = messenger.attributeValue;
  return {
    en: `${name} is starting on this Instance. This takes up to a minute the first time.`,
    de: `${name} startet auf dieser Instanz. Beim ersten Mal dauert das bis zu einer Minute.`,
  };
}

/** Waits for the QR code to be scanned in the background, showing each new code the bridge sends. */
async function awaitScan(
  bridge: BridgeClient,
  userId: string,
  first: { loginId: string; stepId: string },
  session: LoginSession,
  messenger: Messenger,
  log: (message: string, error: unknown) => void,
): Promise<void> {
  let step = first;
  try {
    for (;;) {
      const next = await bridge.waitForStep(userId, step);
      if (next.type === "complete") {
        session.outcome = "done";
        return;
      }
      if (next.type !== "display_and_wait") {
        session.outcome = { failed: unexpectedStep(next, messenger, log) };
        return;
      }
      session.qrCode = next.qrCode;
      step = next;
    }
  } catch (error) {
    log("The login did not finish:", error);
    session.outcome = { failed: { en: "The login did not finish. Try again.", de: "Die Verknüpfung wurde nicht abgeschlossen. Versuche es noch einmal." } };
  }
}

/** A login step the plugin cannot show, such as one asking for a phone number: its instructions go to the log only. */
function unexpectedStep(step: { instructions: string }, messenger: Messenger, log: (message: string, error: unknown) => void): PluginText {
  log(`The ${messenger.attributeValue} bridge asked for a login step the plugin cannot show:`, step.instructions);
  const name = messenger.attributeValue;
  return {
    en: `The ${name} bridge could not link the account by QR code. Try again; the plugin's log says why.`,
    de: `Die ${name}-Bridge konnte das Konto nicht per QR-Code verknüpfen. Versuche es noch einmal; das Log des Plugins sagt, warum.`,
  };
}

function waiting(messenger: Messenger, qrCode: string | null): SetupProgress {
  return { status: "waiting", ...(qrCode ? { qrCode } : {}), message: messenger.scanHint };
}

function linked(messenger: Messenger): PluginText {
  return { en: `The ${messenger.attributeValue} account is linked.`, de: `Das ${messenger.attributeValue}-Konto ist verknüpft.` };
}

/** The fields of the sync cursor carried over, each spread so the run mutates its own copy. */
function previousFields(previous: Previous | null) {
  return {
    rooms: { ...previous?.rooms },
    groups: { ...previous?.groups },
    jids: { ...previous?.jids },
    invites: { ...previous?.invites },
    names: { ...previous?.names },
    edits: { ...previous?.edits },
  };
}

/** Removes rooms and groups the user left, returning the set of left room ids. */
function pruneLeft(state: State, sync: SyncResponse): Set<string> {
  const left = new Set(Object.keys(sync.rooms?.leave ?? {}));
  state.rooms = Object.fromEntries(Object.entries(state.rooms).filter(([roomId]) => !left.has(roomId)));
  state.groups = Object.fromEntries(Object.entries(state.groups).filter(([roomId]) => !left.has(roomId)));
  state.jids = Object.fromEntries(Object.entries(state.jids).filter(([roomId]) => !left.has(roomId)));
  return left;
}

type BridgeIdentity = { userId: string; messenger: Messenger; serverName: string };

/** Merges new invitations into state and accepts those not in a left room. */
async function syncInvitations(
  state: State,
  homeserver: HomeserverClient,
  token: string,
  bridge: BridgeIdentity,
  sync: SyncResponse,
  left: Set<string>,
  previous: Previous | null,
): Promise<void> {
  // A sync cursor from before invitations were kept does not know those /sync named back then.
  const fetched = previous && previous.invites === null ? await homeserver.invites(token) : {};
  Object.assign(state.invites, invitationsOf(fetched, bridge), invitationsOf(sync.rooms?.invite ?? {}, bridge));
  const pending = Object.entries(state.invites).filter(([roomId]) => !left.has(roomId));
  state.invites = {};
  // A chat joined now can be allow-listed at once, though its messages come with the next run.
  await acceptInvitations(state, homeserver, token, pending);
}

/** Learns names, group status and JIDs from the state events and the timeline of each room joined since the last run. */
function syncJoined(state: State, sync: SyncResponse): void {
  for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) learnRoom(state, roomId, room);
}

function learnRoom(state: State, roomId: string, room: JoinedRoom): void {
  // A rename arrives in the timeline, after the state the room had before it.
  for (const event of [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])]) learn(state, roomId, event);
  state.rooms[roomId] ??= roomId;
}

/**
 * The rooms the Messenger's bridge invites the user to, with their names; every other invitation
 * stays unanswered.
 */
function invitationsOf(invites: Invites, bridge: BridgeIdentity): Record<string, string> {
  const invited: Record<string, string> = {};
  for (const [roomId, room] of Object.entries(invites)) {
    const name = invitationNameOf(roomId, room, bridge);
    if (name !== null) invited[roomId] = name;
  }
  return invited;
}

function invitationNameOf(roomId: string, room: Invites[string], bridge: BridgeIdentity): string | null {
  const events = room.invite_state?.events ?? [];
  const invitation = events.find(
    (event) => event.type === "m.room.member" && event.state_key === bridge.userId && event.content.membership === "invite" && isOfBridge(event.sender, bridge.messenger, bridge.serverName),
  );
  if (!invitation) return null;
  const name = events.find((event) => event.type === "m.room.name")?.content.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : roomId;
}

/** Whether a Matrix user is the Messenger's bridge bot or one of its ghosts on this homeserver. */
function isOfBridge(userId: string, messenger: Messenger, serverName: string): boolean {
  const match = /^@([^:]+):(.+)$/.exec(userId);
  if (!match || match[2] !== serverName) return false;
  const localpart = match[1] ?? "";
  return localpart === messenger.botLocalpart || localpart.startsWith(messenger.ghostPrefix);
}

/**
 * Whether a room is a group chat, from the bridge's `m.bridge` state event: a direct chat is
 * marked as one, and a room without it, such as the one with the bridge bot, is no chat at all.
 */
function isGroup(events: MatrixEvent[]): boolean {
  return events.some((event) => event.type === "m.bridge" && !nonGroupRoomTypes.has(String(event.content["com.beeper.room_type"])));
}

/**
 * The WhatsApp JID of the chat a room is the portal of, from the bridge's `m.bridge` state event.
 * The bridge deletes the room when the chat is deleted on the phone and creates a new one for the
 * same group, so the room id does not identify the group; the JID does.
 */
function jidOf(events: MatrixEvent[]): string | undefined {
  for (const event of events) {
    const channel = event.type === "m.bridge" ? event.content.channel : undefined;
    const id = isObject(channel) ? channel.id : undefined;
    if (typeof id === "string" && id !== "") return id;
  }
  return undefined;
}

/** Remembers from the bridge's state events whether a room is a group chat and which chat it is the portal of. */
function learnBridge(state: State, roomId: string, events: MatrixEvent[]): void {
  state.groups[roomId] = isGroup(events);
  const jid = jidOf(events);
  if (jid !== undefined) state.jids[roomId] = jid;
}

/**
 * The JIDs of the chats an Admin allow-listed: the entries of `chats`, and the chats of the rooms
 * an Admin chose by their id before groups were told apart by their JID.
 */
function allowedJidsOf(chats: string[], state: State): Set<string> {
  const allowed = new Set(chats);
  for (const chat of chats) {
    const jid = state.jids[chat];
    if (jid !== undefined) allowed.add(jid);
  }
  return allowed;
}

/** The Source Attribute the whole account was one before its groups became Source Attributes. */
const legacyAttribute = "account";

/**
 * The allow-listed groups to declare as Source Attributes by their JID, named as the bridge names
 * their rooms, and those to archive, which left the allow-list. A group stays declared while its
 * room is missing, such as between the bridge deleting it and creating it again.
 */
function declareChats(state: State, previous: Previous | null, allowedJids: Set<string>, allowListed: Set<string>): Attributes {
  const names = namesByJid(state, allowListed);
  // A Source from before groups were Source Attributes declared one for the whole account.
  const before = previous?.declared ?? [legacyAttribute];
  state.declared = [...new Set([...before.filter((jid) => allowedJids.has(jid)), ...names.keys()])].sort();
  return {
    declared: [...names].map(([externalId, name]) => ({ externalId, name })),
    archived: before.filter((jid) => !state.declared.includes(jid)),
  };
}

/** The allow-listed group rooms, and the Source Attributes they come to. */
function declareAllowed(state: State, previous: Previous | null, chats: string[]): { allowListed: Set<string>; attributes: Attributes } {
  // Only group chats are read: a direct chat is never one to read, even when allow-listed before.
  const allowedJids = allowedJidsOf(chats, state);
  const allowListed = new Set(Object.keys(state.rooms).filter((roomId) => state.groups[roomId] === true && allowedJids.has(state.jids[roomId] ?? "")));
  return { allowListed, attributes: declareChats(state, previous, allowedJids, allowListed) };
}

/** The Source Attributes of the rooms the sync cursor knows and the allow-list as it is now; none before a first run. */
function attributesOf(context: RunContext): Attributes {
  const previous = parseState(context.syncCursor);
  if (!previous) return { declared: [], archived: [] };
  const state: State = { since: previous.since, ...previousFields(previous), declared: [], read: [] };
  return declareAllowed(state, previous, chatsOf(context.config.plain.chats)).attributes;
}

/** The names of the rooms by the JID of their group; a group with several rooms has the name of the last. */
function namesByJid(state: Pick<State, "rooms" | "jids">, rooms: Set<string>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [roomId, name] of Object.entries(state.rooms)) {
    const jid = state.jids[roomId];
    if (rooms.has(roomId) && jid !== undefined) names.set(jid, name);
  }
  return names;
}

/** Finds out whether the joined rooms not known yet are group chats, and the JID of each group not known yet; a room that cannot be read now is tried again on the next run. */
async function classify(state: State, homeserver: HomeserverClient, token: string): Promise<void> {
  for (const roomId of Object.keys(state.rooms)) {
    if (roomId in state.groups && (state.groups[roomId] !== true || roomId in state.jids)) continue;
    try {
      learnBridge(state, roomId, await homeserver.state(token, roomId));
    } catch {
      continue;
    }
  }
}

/** Remembers room names, whether rooms are group chats and their JIDs, and the display names of senders from state events. */
function learn(state: State, roomId: string, event: MatrixEvent): void {
  if (event.type === "m.bridge") learnBridge(state, roomId, [event]);
  if (event.type === "m.room.name" && typeof event.content.name === "string" && event.content.name.trim() !== "") {
    state.rooms[roomId] = event.content.name.trim();
  }
  if (event.type === "m.room.member" && event.state_key && typeof event.content.displayname === "string") {
    state.names[event.state_key] = event.content.displayname;
  }
}

/**
 * Reads a room back through `/messages`, newest first, from `from` down to `to` or to `since`,
 * and returns its events oldest first.
 */
async function readBack(homeserver: HomeserverClient, token: string, roomId: string, from: string, to: string | null, since: number | null): Promise<MatrixEvent[]> {
  const events: MatrixEvent[] = [];
  let next: string | undefined = from;
  while (next && events.length < maximumBackfillEvents) {
    const page = await homeserver.messages(token, roomId, next, to, 100);
    if (page.chunk.length === 0) break;
    for (const event of page.state ?? []) events.push(event);
    if (readChunk(page.chunk, since, events) || page.end === next) break;
    next = page.end;
  }
  return events.reverse();
}

function readChunk(chunk: MatrixEvent[], since: number | null, events: MatrixEvent[]): boolean {
  for (const event of chunk) {
    if (since !== null && (event.origin_server_ts ?? 0) < since) return true;
    events.push(event);
  }
  return false;
}

/** Accepts the pending invitations, keeping those that fail for a later run. */
async function acceptInvitations(state: State, homeserver: HomeserverClient, token: string, pending: [string, string][]): Promise<void> {
  for (const [roomId, name] of pending) {
    try {
      await homeserver.join(token, roomId);
      state.rooms[roomId] = name;
    } catch {
      // An invitation that cannot be accepted now, such as past the homeserver's rate limit, is accepted on a later run.
      state.invites[roomId] = name;
    }
  }
}

type Events = Map<string, { roomId: string; event: MatrixEvent }>;

/** The events of the allow-listed rooms a run reads, and the redactions that withdraw them. */
async function collectEvents(
  state: State,
  homeserver: HomeserverClient,
  token: string,
  sync: SyncResponse,
  previous: Previous | null,
  allowListed: Set<string>,
  backfillStart: number,
): Promise<{ withdrawn: Set<string>; events: Events }> {
  const withdrawn = new Set<string>();
  const events: Events = new Map();
  // Learns each event, withdraws the redacted, and keeps those of allow-listed rooms.
  const take = (roomId: string, list: MatrixEvent[]) => {
    for (const event of list) {
      learn(state, roomId, event);
      if (event.type === "m.room.redaction") {
        const redacts = event.redacts ?? event.content.redacts;
        if (typeof redacts === "string") withdrawn.add(redacts);
      } else if (allowListed.has(roomId) && event.event_id) {
        events.set(event.event_id, { roomId, event });
      }
    }
  };

  for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
    take(roomId, room.timeline?.events ?? []);
    const isNew = previous !== null && !previous.read.includes(roomId);
    // A timeline cut short since the last run is read back to where that run stopped.
    if (allowListed.has(roomId) && !isNew && room.timeline?.limited && room.timeline.prev_batch) {
      take(roomId, await readBack(homeserver, token, roomId, room.timeline.prev_batch, previous?.since ?? null, backfillStart));
    }
  }
  // A chat allow-listed since the last run is read back for some days.
  for (const roomId of allowListed) {
    if (!previous || previous.read.includes(roomId) || !(roomId in state.rooms)) continue;
    take(roomId, await readBack(homeserver, token, roomId, sync.next_batch, null, backfillStart));
  }
  return { withdrawn, events };
}

/** The edits that stay, dropping those whose message is redacted. */
function pruneEdits(state: State, events: Events, withdrawn: Set<string>): void {
  // An edit is a message of its own, which goes when the message it edits is redacted.
  for (const { event } of events.values()) {
    const edited = editedBy(event);
    if (edited && event.event_id) state.edits[edited] = [...new Set([...(state.edits[edited] ?? []), event.event_id])];
  }
  for (const redacted of [...withdrawn]) for (const edit of state.edits[redacted] ?? []) withdrawn.add(edit);
  state.edits = Object.fromEntries(Object.entries(state.edits).filter(([edited]) => !withdrawn.has(edited)));
}

type RecordContext = { state: State; userId: string; token: string; messenger: Messenger; homeserver: HomeserverClient; serverName: string };

/** A Source Record of a message, which always has the time its homeserver got it. */
type MessageRecord = SourceRecord & { occurredAt: string };

/** The Source Records of the events read, in the order they occurred. */
async function recordsOf(events: Events, withdrawn: Set<string>, context: RecordContext): Promise<SourceRecord[]> {
  const records: MessageRecord[] = [];
  for (const { roomId, event } of events.values()) {
    if (withdrawn.has(event.event_id ?? "")) continue;
    const record = await recordOf(event, roomId, context);
    if (record) records.push(record);
  }
  records.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return records;
}

/** A message of an allow-listed room as a Source Record; null for anything that is not one to read. */
async function recordOf(event: MatrixEvent, roomId: string, context: RecordContext): Promise<MessageRecord | null> {
  const eventId = event.event_id;
  if (!eventId || !isReadable(event, context)) return null;
  const { content, body } = contentOf(event);
  const { text, attachments } = await messageContent(content, body, context);
  if (text === "" && attachments.length === 0) return null;
  const jid = context.state.jids[roomId];
  return {
    externalId: eventId,
    occurredAt: new Date(event.origin_server_ts ?? Date.now()).toISOString(),
    // The Source Attribute a message names: the group its room is the portal of.
    attributes: jid === undefined ? [] : [jid],
    // Who sent it, and in which chat, as the Admin area shows it with the message.
    sender: context.state.names[event.sender] ?? event.sender,
    subject: context.state.rooms[roomId] ?? roomId,
    content: { kind: "raw-message", text, attachments },
  };
}

function isReadable(event: MatrixEvent, context: { userId: string; messenger: Messenger; serverName: string }): boolean {
  if (event.type !== "m.room.message" || !event.event_id || event.unsigned?.redacted_because !== undefined) return false;
  return event.sender !== context.userId && event.sender !== `@${context.messenger.botLocalpart}:${context.serverName}`;
}

function contentOf(event: MatrixEvent): { content: Record<string, unknown>; body: string } {
  const relation = event.content["m.relates_to"] as { rel_type?: string } | undefined;
  // An edit stands for the message it changes, with its new text.
  const content = relation?.rel_type === "m.replace" && isObject(event.content["m.new_content"]) ? event.content["m.new_content"] : event.content;
  const body = typeof content.body === "string" ? content.body.trim() : "";
  return { content, body };
}

/** The text and attachments of a Matrix message, by its msgtype. */
async function messageContent(content: Record<string, unknown>, body: string, context: { token: string; homeserver: HomeserverClient }): Promise<{ text: string; attachments: Attachment[] }> {
  const msgtype = content.msgtype;
  if (typeof msgtype === "string" && textTypes.has(msgtype)) return { text: body, attachments: [] };
  if (typeof msgtype === "string" && fileTypes.has(msgtype)) return attachmentsOf(content, body, context);
  return { text: "", attachments: [] };
}

/** The caption and the attachments of a file message; the caption is its body when that differs from the name. */
async function attachmentsOf(content: Record<string, unknown>, body: string, context: { token: string; homeserver: HomeserverClient }): Promise<{ text: string; attachments: Attachment[] }> {
  const filename = stringOr(content.filename, body || "attachment");
  const text = body !== filename ? body : "";
  const info = isObject(content.info) ? content.info : {};
  const size = typeof info.size === "number" ? info.size : 0;
  const contentType = stringOr(info.mimetype, "application/octet-stream");
  if (typeof content.url !== "string" || size > maximumAttachmentBytes) return { text, attachments: [] };
  const bytes = await context.homeserver.download(context.token, content.url, maximumAttachmentBytes);
  return { text, attachments: bytes ? [{ filename, contentType, bytes: Buffer.from(bytes).toString("base64") }] : [] };
}

const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" && value !== "" ? value : fallback);

/** The message an edit changes; none for any other event. */
function editedBy(event: MatrixEvent): string | null {
  const relation = event.content["m.relates_to"];
  if (!isObject(relation) || relation.rel_type !== "m.replace") return null;
  return typeof relation.event_id === "string" ? relation.event_id : null;
}

/** The joined group chats a Source can allow-list, by name; a group is chosen by its JID, so it is offered once however many rooms it has had. */
function chatChoices(context: RunContext): Choice[] {
  const state = parseState(context.syncCursor);
  if (!state) return [];
  const groups = new Set(Object.keys(state.groups).filter((roomId) => state.groups[roomId] === true));
  return [...namesByJid(state, groups)].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function chatsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((chat): chat is string => typeof chat === "string") : [];
}

/** The record a stored value is, or an empty one. */
function recordOrEmpty<T>(value: Record<string, T> | undefined): Record<string, T> {
  return isObject(value) ? (value as Record<string, T>) : {};
}

/** A sync cursor as read; `invites` is null in one written before invitations were kept, `declared` in one written before groups were Source Attributes. */
type Previous = Omit<State, "invites" | "declared"> & { invites: Record<string, string> | null; declared: string[] | null };

function parseState(state: string | null): Previous | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as Partial<State>;
    if (typeof parsed.since !== "string") return null;
    return {
      since: parsed.since,
      rooms: recordOrEmpty(parsed.rooms),
      groups: recordOrEmpty(parsed.groups),
      jids: recordOrEmpty(parsed.jids),
      declared: Array.isArray(parsed.declared) ? chatsOf(parsed.declared) : null,
      invites: isObject(parsed.invites) ? (parsed.invites as Record<string, string>) : null,
      names: recordOrEmpty(parsed.names),
      read: chatsOf(parsed.read),
      edits: recordOrEmpty(parsed.edits),
    };
  } catch {
    return null;
  }
}

/** A user that no longer exists, or a token it lost, needs an Admin; anything else may pass. */
function homeserverError(error: unknown, log: (message: string, error: unknown) => void): PluginError {
  if (error instanceof PluginError) return error;
  if (error instanceof RefusedError && error.errcode === "M_UNKNOWN_TOKEN") {
    return new PluginError("definite", "The homeserver no longer knows the Source's Matrix user. Remove the Source and add it again.");
  }
  log("The homeserver could not be read:", error);
  return new PluginError("temporary", "The homeserver could not be read.");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
