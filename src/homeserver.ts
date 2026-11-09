import { createHmac, randomBytes } from "node:crypto";

/** A Matrix event as the client-server API returns it. */
export type MatrixEvent = {
  type: string;
  event_id?: string;
  sender: string;
  origin_server_ts?: number;
  state_key?: string;
  content: Record<string, unknown>;
  /** Where a redaction names the event it redacts, before room version 11. */
  redacts?: string;
  unsigned?: { redacted_because?: unknown };
};

export type JoinedRoom = {
  state?: { events?: MatrixEvent[] };
  timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string };
};

/** Invitations by room, with the stripped state the inviter shared. */
export type Invites = Record<string, { invite_state?: { events?: MatrixEvent[] } }>;

export type SyncResponse = {
  next_batch: string;
  rooms?: {
    join?: Record<string, JoinedRoom>;
    invite?: Invites;
    leave?: Record<string, unknown>;
  };
};

/** What the homeserver or a bridge answered with when it refused a request. */
export class RefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errcode: string | null,
  ) {
    super(message);
    this.name = "RefusedError";
  }
}

/**
 * Only receives: it reads `/sync` without setting presence, never sends a receipt, a typing
 * notification or a message, and joins only rooms its caller decided to join.
 */
const syncFilter = JSON.stringify({
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
    state: { lazy_load_members: true },
    timeline: { limit: 50 },
  },
});

/** Leaves out everything an initial `/sync` would bring but the invitations. */
const invitesFilter = JSON.stringify({
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
    state: { types: [] },
    timeline: { types: [], limit: 1 },
  },
});

export type HomeserverOptions = { url: string; timeoutMs: number };

/** The parts of the Matrix client-server and Synapse admin API the plugin uses. */
export function homeserverClient(options: HomeserverOptions) {
  const { url, timeoutMs } = options;

  async function call<T>(method: string, path: string, init: { token?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(new URL(path, url), {
      method,
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw await errorOf(response);
    return (await response.json()) as T;
  }

  return {
    /**
     * Creates a user through Synapse's shared-secret registration, which works while public
     * registration is off. Its password is thrown away: the access token is all the plugin keeps.
     */
    async register(localpart: string, sharedSecret: string): Promise<{ userId: string; accessToken: string }> {
      const { nonce } = await call<{ nonce: string }>("GET", "/_synapse/admin/v1/register");
      const password = randomBytes(32).toString("base64url");
      const mac = createHmac("sha1", sharedSecret)
        .update([nonce, localpart, password, "notadmin"].join("\0"))
        .digest("hex");
      const registered = await call<{ user_id: string; access_token: string }>("POST", "/_synapse/admin/v1/register", {
        body: { nonce, username: localpart, password, admin: false, mac, inhibit_login: false },
      });
      return { userId: registered.user_id, accessToken: registered.access_token };
    },

    sync(token: string, since: string | null): Promise<SyncResponse> {
      const query = new URLSearchParams({ filter: syncFilter, timeout: "0", set_presence: "offline" });
      if (since) query.set("since", since);
      return call("GET", `/_matrix/client/v3/sync?${query.toString()}`, { token });
    },

    /** The invitations the user has not answered, through an initial `/sync` that only keeps them. */
    async invites(token: string): Promise<Invites> {
      const query = new URLSearchParams({ filter: invitesFilter, timeout: "0", set_presence: "offline" });
      const sync = await call<SyncResponse>("GET", `/_matrix/client/v3/sync?${query.toString()}`, { token });
      return sync.rooms?.invite ?? {};
    },

    /** Events of a room before `from`, newest first, down to `to` if given. */
    messages(
      token: string,
      roomId: string,
      from: string,
      to: string | null,
      limit: number,
    ): Promise<{ chunk: MatrixEvent[]; end?: string; state?: MatrixEvent[] }> {
      const query = new URLSearchParams({ from, dir: "b", limit: String(limit) });
      if (to) query.set("to", to);
      return call("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${query.toString()}`, { token });
    },

    /** The current state events of a room. */
    state(token: string, roomId: string): Promise<MatrixEvent[]> {
      return call("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, { token });
    },

    async join(token: string, roomId: string): Promise<void> {
      await call("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, { token, body: {} });
    },

    /** The file behind an `mxc://` address, through the authenticated media API. */
    async download(token: string, mxc: string, maximumBytes: number): Promise<Uint8Array | null> {
      const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
      if (!match) return null;
      const [, server = "", mediaId = ""] = match;
      const response = await fetch(
        new URL(`/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`, url),
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!response.ok) return null;
      return bodyWithin(response, maximumBytes);
    },

    async logout(token: string): Promise<void> {
      await call("POST", "/_matrix/client/v3/logout", { token, body: {} });
    },
  };
}

export type HomeserverClient = ReturnType<typeof homeserverClient>;

/**
 * A response's body, or null when it is larger than `maximumBytes`: refused by its
 * content-length up front, or cut off as soon as it streams past the limit.
 */
async function bodyWithin(response: Response, maximumBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maximumBytes || !response.body) {
    await response.body?.cancel();
    return declared > maximumBytes ? null : new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maximumBytes) {
      await response.body.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

/** The state of a login as a bridge reports it, such as `CONNECTED` or `LOGGED_OUT`. */
export type BridgeLogin = { id: string; name: string; stateEvent: string; reason: string | null };

/** A step of a bridge's login: a QR code to show while waiting, or done. */
export type LoginStep =
  | { type: "display_and_wait"; loginId: string; stepId: string; qrCode: string | null }
  | { type: "complete"; loginId: string }
  | { type: "other"; loginId: string; instructions: string };

/**
 * The provisioning API a mautrix bridge offers (bridgev2, `/_matrix/provision/v3`), which logs a
 * Matrix user in to the Messenger and tells how its logins are doing.
 */
export function bridgeClient(options: { url: string; secret: string; timeoutMs: number }) {
  const { url, secret, timeoutMs } = options;

  async function call<T>(method: string, path: string, userId: string, waitMs = timeoutMs): Promise<T> {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(new URL(`/_matrix/provision/v3${path}${separator}user_id=${encodeURIComponent(userId)}`, url), {
      method,
      headers: { authorization: `Bearer ${secret}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(waitMs),
    });
    if (!response.ok) throw await errorOf(response);
    return (await response.json()) as T;
  }

  return {
    async logins(userId: string): Promise<BridgeLogin[]> {
      const whoami = await call<{ logins?: RawLogin[] }>("GET", "/whoami", userId);
      return (whoami.logins ?? []).map((login) => ({
        id: login.id,
        name: login.name ?? "",
        stateEvent: login.state?.state_event ?? login.state_event ?? "UNKNOWN_ERROR",
        reason: login.state?.reason ?? login.state?.message ?? null,
      }));
    },

    async startLogin(userId: string, flow: string): Promise<LoginStep> {
      return stepOf(await call<RawStep>("POST", `/login/start/${encodeURIComponent(flow)}`, userId));
    },

    /** Waits until the shown code is scanned or replaced; this can take a minute. */
    async waitForStep(userId: string, step: { loginId: string; stepId: string }): Promise<LoginStep> {
      const path = `/login/step/${encodeURIComponent(step.loginId)}/${encodeURIComponent(step.stepId)}/display_and_wait`;
      return stepOf(await call<RawStep>("POST", path, userId, 5 * 60_000), step.loginId);
    },

    async logoutAll(userId: string): Promise<void> {
      await call("POST", "/logout/all", userId);
    },
  };
}

export type BridgeClient = ReturnType<typeof bridgeClient>;

type RawLogin = {
  id: string;
  name?: string;
  state_event?: string;
  state?: { state_event?: string; reason?: string; message?: string };
};

type RawStep = {
  login_id?: string;
  type: string;
  step_id: string;
  instructions?: string;
  display_and_wait?: { type: string; data?: string };
};

function stepOf(raw: RawStep, loginId = ""): LoginStep {
  const id = raw.login_id ?? loginId;
  if (raw.type === "complete") return { type: "complete", loginId: id };
  if (raw.type === "display_and_wait") {
    return { type: "display_and_wait", loginId: id, stepId: raw.step_id, qrCode: qrOf(raw.display_and_wait) };
  }
  return { type: "other", loginId: id, instructions: raw.instructions ?? raw.type };
}

function qrOf(display: RawStep["display_and_wait"]): string | null {
  return display?.type === "qr" ? (display.data ?? null) : null;
}

async function errorOf(response: Response): Promise<RefusedError> {
  let body: { errcode?: string; error?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Not every error comes with a Matrix error body.
  }
  return new RefusedError(body.error ?? `HTTP ${response.status}`, response.status, body.errcode ?? null);
}
