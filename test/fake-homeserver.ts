import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JoinedRoom, MatrixEvent, SyncResponse } from "../src/homeserver";
import type { MatrixInstance } from "../src/instance";

type StoredEvent = { position: number; roomId: string; event: MatrixEvent };

type Room = {
  name: string;
  /** Every name the room had, with the position of the event that gave it, oldest first. */
  names: { position: number; name: string }[];
  direct: boolean;
  /** The WhatsApp chat the bridge says the room is the portal of, in its `m.bridge` event. */
  jid: string;
  members: Map<string, { membership: "invite" | "join" | "leave"; inviter: string; displayname: string; since: number }>;
};

/** The rooms of a `/sync` response, each kind present. */
type SyncRooms = Required<NonNullable<SyncResponse["rooms"]>>;

type User = { token: string | null; replay: SyncResponse[] };

type Login = { id: string; name: string; stateEvent: string; reason?: string };

type PendingStep = { loginId: string; respond: (body: unknown) => void };

/**
 * A stand-in for Synapse and a mautrix bridge in one HTTP server, for the plugin's contract tests
 * and its other tests: the client-server API a Source's Matrix user reads with, Synapse's
 * shared-secret registration, and the bridge's provisioning API. Rooms, messages and logins are
 * scripted; recorded `/sync` responses can be replayed as they are.
 */
export class FakeHomeserver {
  readonly serverName = "family-agenda.local";
  readonly registrationSharedSecret = "registration-shared-secret";
  readonly provisioningSecret = "provisioning-shared-secret";
  /** Every request, as `METHOD /path`, to check that the plugin only reads. */
  readonly requests: string[] = [];
  private server: Server | null = null;
  private port = 0;
  private position = 0;
  private readonly events: StoredEvent[] = [];
  private readonly rooms = new Map<string, Room>();
  private readonly users = new Map<string, User>();
  private readonly logins = new Map<string, Login[]>();
  private readonly media = new Map<string, Uint8Array>();
  private readonly pendingSteps = new Map<string, PendingStep>();
  private qrCodes = 0;
  /** Whether the WhatsApp bridge runs; when it does not, its address does not answer. */
  bridgeRunning = true;
  /** How many more joins the homeserver refuses as rate limited, as Synapse does past its burst. */
  limitedJoins = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The Instance's Matrix setup, as `main.ts` keeps it, with the bridge on the same server. */
  instance(): MatrixInstance {
    return {
      homeserver: { url: this.url, serverName: this.serverName, registrationSharedSecret: this.registrationSharedSecret },
      bridges: { whatsapp: { url: this.url, provisioningSecret: this.provisioningSecret } },
    };
  }

  /** Listens on `port`, or on a free one. */
  async start(port = 0): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        respond(response, 500, { errcode: "M_UNKNOWN", error: String(error) });
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const pending of this.pendingSteps.values()) pending.respond({ errcode: "M_UNKNOWN", error: "shutting down" });
    this.pendingSteps.clear();
    this.server?.closeAllConnections();
    const { server } = this;
    if (server) await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  }

  /** The Matrix users the plugin registered, oldest first. */
  registeredUsers(): string[] {
    return [...this.users.keys()];
  }

  /** A ghost of the bridge, the Matrix user that stands for a WhatsApp user. */
  ghost(phone: string): string {
    return `@whatsapp_${phone}:${this.serverName}`;
  }

  get bot(): string {
    return `@whatsappbot:${this.serverName}`;
  }

  /**
   * A portal room of the bridge, with its ghosts as members; a group chat unless `direct`. The
   * bridge names the chat by its WhatsApp JID, which is the `jid` given, or a new one. A room the
   * bridge creates again for a chat has a new id and the same JID.
   */
  createRoom(name: string, ghosts: Record<string, string> = {}, options: { direct?: boolean; jid?: string } = {}): string {
    const roomId = `!${randomBytes(6).toString("hex")}:${this.serverName}`;
    const direct = options.direct ?? false;
    const jid = options.jid ?? `${randomBytes(9).toString("hex")}@${direct ? "lid" : "g.us"}`;
    const room: Room = { name, names: [{ position: 0, name }], direct, jid, members: new Map() };
    for (const [userId, displayname] of Object.entries(ghosts)) room.members.set(userId, { membership: "join", inviter: this.bot, displayname, since: 0 });
    this.rooms.set(roomId, room);
    return roomId;
  }

  /** The WhatsApp JID the bridge gives a room in its `m.bridge` event. */
  jidOf(roomId: string): string {
    return this.roomOf(roomId).jid;
  }

  /** A chat is renamed on the phone; the bridge changes the name of its room. */
  rename(roomId: string, name: string, at: Date): void {
    const room = this.roomOf(roomId);
    room.name = name;
    this.append(roomId, { type: "m.room.name", sender: this.bot, state_key: "", content: { name }, origin_server_ts: at.getTime() });
    room.names.push({ position: this.position, name });
  }

  /** The bridge removes a user from a room, as it does when it deletes the portal room of a chat. */
  leave(roomId: string, userId: string): void {
    this.position += 1;
    const member = this.roomOf(roomId).members.get(userId);
    if (member) Object.assign(member, { membership: "leave", since: this.position });
  }

  /** The bridge, or anyone else, invites a user to a room. */
  invite(roomId: string, userId: string, inviter = this.bot): void {
    this.position += 1;
    this.roomOf(roomId).members.set(userId, { membership: "invite", inviter, displayname: userId, since: this.position });
  }

  /** Puts a user in a room, as if it had accepted an invitation before. */
  addMember(roomId: string, userId: string): void {
    this.roomOf(roomId).members.set(userId, { membership: "join", inviter: this.bot, displayname: userId, since: 0 });
  }

  isMember(roomId: string, userId: string): boolean {
    return this.roomOf(roomId).members.get(userId)?.membership === "join";
  }

  /** A message in a room; returns its event id. */
  send(roomId: string, sender: string, content: Record<string, unknown>, at: Date): string {
    return this.append(roomId, { type: "m.room.message", sender, content, origin_server_ts: at.getTime() });
  }

  text(roomId: string, sender: string, body: string, at: Date): string {
    return this.send(roomId, sender, { msgtype: "m.text", body }, at);
  }

  /** Keeps a file, as the bridge does with a WhatsApp attachment; returns its `mxc://` address. */
  upload(bytes: Uint8Array): string {
    const id = randomBytes(8).toString("hex");
    this.media.set(id, bytes);
    return `mxc://${this.serverName}/${id}`;
  }

  /** Deletes a message, as WhatsApp's "delete for everyone" arrives through the bridge. */
  redact(roomId: string, eventId: string, at: Date): string {
    const original = this.events.find((stored) => stored.event.event_id === eventId);
    if (original) original.event = { ...original.event, content: {}, unsigned: { redacted_because: { type: "m.room.redaction" } } };
    return this.append(roomId, { type: "m.room.redaction", sender: this.bot, content: { redacts: eventId }, redacts: eventId, origin_server_ts: at.getTime() });
  }

  /** Makes the next `/sync` requests of a user answer with these responses, as recorded from Synapse. */
  replaySync(userId: string, responses: SyncResponse[]): void {
    this.userOf(userId).replay.push(...responses);
  }

  /** Sets how the bridge reports the user's login, such as `CONNECTED` or `LOGGED_OUT`; null for none. */
  setLogin(userId: string, stateEvent: string | null, reason?: string): void {
    if (stateEvent === null) this.logins.delete(userId);
    else this.logins.set(userId, [{ id: "4915112345678", name: "+49 151 12345678", stateEvent, ...(reason ? { reason } : {}) }]);
  }

  /** Whether the bridge shows the user a QR code and waits for it to be scanned. */
  awaitsScan(userId: string): boolean {
    return this.pendingSteps.has(userId);
  }

  /** The phone scans the QR code the bridge shows to the user, which completes the login. */
  scanQr(userId: string): void {
    this.setLogin(userId, "CONNECTED");
    const pending = this.pendingSteps.get(userId);
    this.pendingSteps.delete(userId);
    pending?.respond({ login_id: pending.loginId, type: "complete", step_id: "fi.mau.whatsapp.complete", complete: { user_login_id: "4915112345678" } });
  }

  /** The QR code expires, and the bridge shows the next one. */
  refreshQr(userId: string): void {
    const pending = this.pendingSteps.get(userId);
    this.pendingSteps.delete(userId);
    pending?.respond(this.qrStep(pending.loginId));
  }

  private append(roomId: string, event: Omit<MatrixEvent, "event_id">): string {
    this.roomOf(roomId);
    this.position += 1;
    const eventId = `$${this.position}-${randomBytes(4).toString("hex")}`;
    this.events.push({ position: this.position, roomId, event: { ...event, event_id: eventId } });
    return eventId;
  }

  private roomOf(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`no room ${roomId}`);
    return room;
  }

  private userOf(userId: string): User {
    let user = this.users.get(userId);
    if (!user) {
      user = { token: null, replay: [] };
      this.users.set(userId, user);
    }
    return user;
  }

  private qrStep(loginId: string) {
    this.qrCodes += 1;
    return {
      login_id: loginId,
      type: "display_and_wait",
      step_id: "fi.mau.whatsapp.qr",
      instructions: "Scan the QR code on the WhatsApp mobile app to log in",
      display_and_wait: { type: "qr", data: `2@qr-code-${this.qrCodes}` },
    };
  }

  private messagesChunk(roomId: string, from: number, to: number, limit: number) {
    return this.events
      .filter((stored) => stored.roomId === roomId && stored.position <= from && stored.position > to)
      .reverse()
      .slice(0, limit);
  }

  /** The room's name, the bridge's description of it and its members, as state events, with the name it had at that position. */
  private stateOf(roomId: string, position = this.position): MatrixEvent[] {
    const room = this.roomOf(roomId);
    const name = room.names.findLast((named) => named.position <= position)?.name ?? room.name;
    return [
      { type: "m.room.name", sender: this.bot, state_key: "", content: { name } },
      {
        type: "m.bridge",
        sender: this.bot,
        state_key: `${this.serverName}/whatsapp`,
        content: { bridgebot: this.bot, channel: { id: room.jid }, ...(room.direct ? { "com.beeper.room_type": "dm" } : {}) },
      },
      ...[...room.members].filter(([, member]) => member.membership !== "leave").map(([userId, member]) => ({
        type: "m.room.member",
        sender: member.membership === "invite" ? member.inviter : userId,
        state_key: userId,
        content: { membership: member.membership, displayname: member.displayname },
      })),
    ];
  }

  private sync(userId: string, since: string | null, limit: number): SyncResponse {
    const after = since ? Number(since.slice(1)) : 0;
    const rooms: SyncRooms = { join: {}, invite: {}, leave: {} };
    for (const roomId of this.rooms.keys()) this.syncRoomFor(rooms, roomId, userId, { since, after, limit });
    return { next_batch: `s${this.position}`, rooms };
  }

  /** What `/sync` says about one room to a user: an invitation, the room joined, or that the user left it. */
  private syncRoomFor(rooms: SyncRooms, roomId: string, userId: string, window: { since: string | null; after: number; limit: number }): void {
    const member = this.roomOf(roomId).members.get(userId);
    if (!member) return;
    if (member.membership === "join") rooms.join[roomId] = this.roomSync(roomId, window.since, window.after, window.limit);
    else if (member.since > window.after) rooms[member.membership][roomId] = this.membershipChange(roomId, userId, member.membership);
  }

  /** The part of a `/sync` response for a room the user was invited to or left. */
  private membershipChange(roomId: string, userId: string, membership: "invite" | "leave"): object {
    if (membership === "leave") return {};
    return { invite_state: { events: this.stateOf(roomId).filter((event) => event.type === "m.room.name" || event.state_key === userId) } };
  }

  /** Like Synapse, an incremental `/sync` names an invitation only once, in the first one after it. */
  private roomSync(roomId: string, since: string | null, after: number, limit: number): JoinedRoom {
    const fresh = this.events.filter((stored) => stored.roomId === roomId && (since === null || stored.position > after));
    const shown = fresh.slice(-limit);
    const first = shown[0]?.position ?? this.position + 1;
    // Like Synapse, `state` is the room before the timeline, so a rename comes only in the timeline.
    return {
      state: { events: this.stateOf(roomId, first - 1) },
      timeline: { events: shown.map((stored) => stored.event), limited: fresh.length > shown.length, prev_batch: `s${first - 1}` },
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { url, path, method } = this.routeOf(request);
    this.requests.push(`${method} ${path}`);
    const body = method === "POST" ? await jsonOf(request) : {};
    if (this.handleBridge(path, request, response, url, method)) return;
    if (this.handleRegisterCheck(path, response, method, body)) return;
    const userId = this.authenticate(request);
    if (!userId) {
      respond(response, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Unknown access token" });
      return;
    }
    if (this.handleClientRoute(method, path, userId, response, url)) return;
    respond(response, 404, { errcode: "M_UNRECOGNIZED", error: `Unrecognized request ${method} ${path}` });
  }

  private routeOf(request: IncomingMessage): { url: URL; path: string; method: string } {
    const url = new URL(request.url ?? "/", this.url);
    return { url, path: url.pathname, method: request.method ?? "GET" };
  }

  private handleBridge(path: string, request: IncomingMessage, response: ServerResponse, url: URL, method: string): boolean {
    if (!path.startsWith("/_matrix/mau/") && !path.startsWith("/_matrix/provision/")) return false;
    if (!this.bridgeRunning) {
      request.socket.destroy();
      return true;
    }
    if (path === "/_matrix/mau/live") {
      respond(response, 200, {});
      return true;
    }
    this.provision(request, response, url, method);
    return true;
  }

  private handleRegisterCheck(path: string, response: ServerResponse, method: string, body: unknown): boolean {
    if (path !== "/_synapse/admin/v1/register") return false;
    this.handleRegister(response, method, body);
    return true;
  }

  private handleClientRoute(method: string, path: string, userId: string, response: ServerResponse, url: URL): boolean {
    if (method === "GET" && path === "/_matrix/client/v3/sync") {
      this.handleSync(response, userId, url);
      return true;
    }
    if (this.handleRoomRoute(method, path, userId, response, url)) return true;
    if (method === "POST" && path === "/_matrix/client/v3/logout") {
      this.userOf(userId).token = null;
      respond(response, 200, {});
      return true;
    }
    return false;
  }

  private handleRoomRoute(method: string, path: string, userId: string, response: ServerResponse, url: URL): boolean {
    if (this.handleJoinRoute(method, path, userId, response)) return true;
    if (this.handleMessagesRoute(method, path, userId, response, url)) return true;
    if (this.handleStateRoute(method, path, userId, response)) return true;
    if (this.handleDownloadRoute(method, path, response)) return true;
    return false;
  }

  private handleJoinRoute(method: string, path: string, userId: string, response: ServerResponse): boolean {
    if (method !== "POST") return false;
    const join = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/join$/.exec(path);
    if (!join) return false;
    this.handleJoin(response, userId, decodeURIComponent(join[1] ?? ""));
    return true;
  }

  private handleMessagesRoute(method: string, path: string, userId: string, response: ServerResponse, url: URL): boolean {
    if (method !== "GET") return false;
    const messages = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/.exec(path);
    if (!messages) return false;
    this.handleMessages(response, userId, decodeURIComponent(messages[1] ?? ""), url);
    return true;
  }

  private handleStateRoute(method: string, path: string, userId: string, response: ServerResponse): boolean {
    if (method !== "GET") return false;
    const state = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state$/.exec(path);
    if (!state) return false;
    this.handleState(response, userId, decodeURIComponent(state[1] ?? ""));
    return true;
  }

  private handleDownloadRoute(method: string, path: string, response: ServerResponse): boolean {
    if (method !== "GET") return false;
    const download = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/.exec(path);
    if (!download) return false;
    this.handleDownload(response, decodeURIComponent(download[2] ?? ""));
    return true;
  }

  private handleRegister(response: ServerResponse, method: string, body: unknown): void {
    if (method === "GET") {
      respond(response, 200, { nonce: randomBytes(8).toString("hex") });
      return;
    }
    const { nonce, username, password, mac } = body as Record<string, string>;
    const expected = createHmac("sha1", this.registrationSharedSecret)
      .update([nonce, username, password, "notadmin"].join("\0"))
      .digest("hex");
    if (mac !== expected) {
      respond(response, 403, { errcode: "M_FORBIDDEN", error: "HMAC incorrect" });
      return;
    }
    const userId = `@${username}:${this.serverName}`;
    const token = `syt_${randomBytes(12).toString("hex")}`;
    this.userOf(userId).token = token;
    respond(response, 200, { user_id: userId, access_token: token, home_server: this.serverName, device_id: "DEVICE" });
  }

  private handleSync(response: ServerResponse, userId: string, url: URL): void {
    const replayed = this.userOf(userId).replay.shift();
    if (replayed) {
      respond(response, 200, replayed);
      return;
    }
    const filter = JSON.parse(url.searchParams.get("filter") ?? "{}") as { room?: { timeline?: { limit?: number } } };
    respond(response, 200, this.sync(userId, url.searchParams.get("since"), filter.room?.timeline?.limit ?? 10));
  }

  private handleJoin(response: ServerResponse, userId: string, roomId: string): void {
    const member = this.rooms.get(roomId)?.members.get(userId);
    if (this.limitedJoins > 0) {
      this.limitedJoins -= 1;
      respond(response, 429, { errcode: "M_LIMIT_EXCEEDED", error: "Too Many Requests", retry_after_ms: 10_000 });
      return;
    }
    if (!member) {
      respond(response, 403, { errcode: "M_FORBIDDEN", error: "You are not invited to this room." });
      return;
    }
    member.membership = "join";
    respond(response, 200, { room_id: roomId });
  }

  private messagesParams(url: URL): { from: number; to: number; limit: number } {
    return {
      from: Number((url.searchParams.get("from") ?? "s0").slice(1)),
      to: Number((url.searchParams.get("to") ?? "s0").slice(1)),
      limit: Number(url.searchParams.get("limit") ?? 10),
    };
  }

  private handleMessages(response: ServerResponse, userId: string, roomId: string, url: URL): void {
    // A room only replayed `/sync` responses has no history here.
    if (!this.rooms.has(roomId)) {
      respond(response, 200, { chunk: [], start: url.searchParams.get("from") });
      return;
    }
    if (!this.isMember(roomId, userId)) {
      respond(response, 403, { errcode: "M_FORBIDDEN", error: "Not in the room." });
      return;
    }
    const { from, to, limit } = this.messagesParams(url);
    const chunk = this.messagesChunk(roomId, from, to, limit);
    const last = chunk.at(-1);
    respond(response, 200, {
      chunk: chunk.map((stored) => stored.event),
      start: `s${from}`,
      ...(last && chunk.length === limit ? { end: `s${last.position - 1}` } : {}),
      state: this.stateOf(roomId).filter((event) => event.type === "m.room.member"),
    });
  }

  private handleState(response: ServerResponse, userId: string, roomId: string): void {
    if (!this.rooms.has(roomId) || !this.isMember(roomId, userId)) {
      respond(response, 403, { errcode: "M_FORBIDDEN", error: "Not in the room." });
      return;
    }
    respond(response, 200, this.stateOf(roomId));
  }

  private handleDownload(response: ServerResponse, mediaId: string): void {
    const bytes = this.media.get(mediaId);
    if (!bytes) {
      respond(response, 404, { errcode: "M_NOT_FOUND", error: "Not found" });
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.from(bytes));
  }
  private provision(request: IncomingMessage, response: ServerResponse, url: URL, method: string): void {
    if (request.headers.authorization !== `Bearer ${this.provisioningSecret}`) {
      respond(response, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid auth token" });
      return;
    }
    const userId = url.searchParams.get("user_id") ?? "";
    const path = url.pathname.slice("/_matrix/provision/v3".length);
    if (this.provisionWhoami(method, path, userId, response)) return;
    if (this.provisionLogin(method, path, userId, response)) return;
    if (this.provisionLogout(method, path, userId, response)) return;
    respond(response, 404, { errcode: "M_UNRECOGNIZED", error: "Unrecognized provisioning request" });
  }

  private provisionWhoami(method: string, path: string, userId: string, response: ServerResponse): boolean {
    if (method !== "GET" || path !== "/whoami") return false;
    const logins = (this.logins.get(userId) ?? []).map((login) => ({
      id: login.id,
      name: login.name,
      state_event: login.stateEvent,
      state: { state_event: login.stateEvent, timestamp: 1, ...(login.reason ? { reason: login.reason } : {}) },
      profile: {},
    }));
    respond(response, 200, { network: { displayname: "WhatsApp" }, bridge_bot: this.bot, homeserver: this.serverName, logins });
    return true;
  }

  private provisionLogin(method: string, path: string, userId: string, response: ServerResponse): boolean {
    if (method !== "POST") return false;
    if (path === "/login/start/qr") {
      respond(response, 200, this.qrStep(`login-${randomBytes(4).toString("hex")}`));
      return true;
    }
    const step = /^\/login\/step\/([^/]+)\/([^/]+)\/display_and_wait$/.exec(path);
    if (step) {
      this.pendingSteps.set(userId, {
        loginId: decodeURIComponent(step[1] ?? ""),
        respond: (answer) => {
          respond(response, 200, answer);
        },
      });
      return true;
    }
    return false;
  }

  private provisionLogout(method: string, path: string, userId: string, response: ServerResponse): boolean {
    if (method !== "POST" || path !== "/logout/all") return false;
    this.logins.delete(userId);
    respond(response, 200, {});
    return true;
  }

  private authenticate(request: IncomingMessage): string | null {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    for (const [userId, user] of this.users) if (token && user.token === token) return userId;
    return null;
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function jsonOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as unknown);
}
