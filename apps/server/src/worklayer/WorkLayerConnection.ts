/**
 * The server's one connection to WorkLayer MCP, shared by every harness.
 *
 * The server signs in as an MCP OAuth client (discovery, dynamic client
 * registration, PKCE) through `@modelcontextprotocol/sdk`, keeps the tokens
 * in `ServerSecretStore`, and refreshes them itself. Harnesses only reach
 * WorkLayer through `/mcp/worklayer`, which asks this service for the current
 * `Authorization` header, so no agent ever holds a WorkLayer credential.
 */
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const DEFAULT_WORKLAYER_MCP_URL = "https://mcp.myworklayer.com";

const SECRET_NAME = "worklayer-oauth";
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

export class WorkLayerAuthError extends Schema.TaggedError<WorkLayerAuthError>()(
  "WorkLayerAuthError",
  {
    reason: Schema.Literals(["sign_in_failed", "unknown_state", "storage_failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "sign_in_failed":
        return "Signing in to WorkLayer failed.";
      case "unknown_state":
        return "This WorkLayer sign-in is unknown or has expired. Start it again.";
      case "storage_failed":
        return "The WorkLayer credentials could not be saved.";
    }
  }
}

/** What the server keeps between restarts. SDK objects are stored as the SDK produced them. */
const StoredConnection = Schema.Struct({
  redirectUrl: Schema.String,
  clientInformation: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(Schema.Unknown),
  tokensObtainedAt: Schema.optional(Schema.Number),
  /** Set when WorkLayer rejected the access token, so the next use refreshes it. */
  stale: Schema.optional(Schema.Boolean),
  discoveryState: Schema.optional(Schema.Unknown),
});
type StoredConnection = typeof StoredConnection.Type;
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredConnection));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredConnection));

interface Draft {
  redirectUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokensObtainedAt?: number;
  stale?: boolean;
  discoveryState?: unknown;
}

export class WorkLayerConnection extends Context.Service<
  WorkLayerConnection,
  {
    /** WorkLayer's MCP endpoint. */
    readonly url: string;
    /** Header to send upstream, refreshed when due; none while WorkLayer is not connected. */
    readonly authorization: Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
    /** WorkLayer rejected the current access token; refresh it before the next request. */
    readonly markRejected: Effect.Effect<void>;
    /**
     * Starts signing in. Returns the WorkLayer URL to open in the user's
     * browser, which comes back to `redirectUrl` with a code and state.
     */
    readonly startSignIn: (redirectUrl: string) => Effect.Effect<URL, WorkLayerAuthError>;
    readonly completeSignIn: (input: {
      readonly code: string;
      readonly state: string;
    }) => Effect.Effect<void, WorkLayerAuthError>;
    readonly disconnect: Effect.Effect<void, WorkLayerAuthError>;
  }
>()("t3/worklayer/WorkLayerConnection") {}

/** The SDK drives OAuth through this object; it reads and writes `draft` in place. */
const makeProvider = (
  draft: Draft,
  flow: { readonly state: string; verifier?: string; authorizationUrl?: URL },
  now: number,
): OAuthClientProvider => ({
  get redirectUrl() {
    return draft.redirectUrl;
  },
  get clientMetadata() {
    return {
      client_name: "WorkLayer Desktop",
      redirect_uris: [draft.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  },
  state: () => flow.state,
  clientInformation: () => draft.clientInformation,
  saveClientInformation: (information) => {
    draft.clientInformation = information;
  },
  tokens: () => draft.tokens,
  saveTokens: (tokens) => {
    draft.tokens = tokens;
    draft.tokensObtainedAt = now;
    draft.stale = false;
  },
  redirectToAuthorization: (url) => {
    flow.authorizationUrl = url;
  },
  saveCodeVerifier: (verifier) => {
    flow.verifier = verifier;
  },
  codeVerifier: () => {
    if (flow.verifier === undefined) throw new Error("No WorkLayer sign-in is in progress.");
    return flow.verifier;
  },
  invalidateCredentials: (scope) => {
    if (scope === "all" || scope === "client") delete draft.clientInformation;
    if (scope === "all" || scope === "tokens") delete draft.tokens;
    if (scope === "all" || scope === "discovery") delete draft.discoveryState;
  },
  saveDiscoveryState: (state) => {
    draft.discoveryState = state;
  },
  discoveryState: () =>
    draft.discoveryState as Awaited<ReturnType<NonNullable<OAuthClientProvider["discoveryState"]>>>,
});

const needsRefresh = (draft: Draft, now: number) => {
  if (draft.stale === true) return true;
  const expiresIn = draft.tokens?.expires_in;
  if (expiresIn === undefined || draft.tokensObtainedAt === undefined) return false;
  return draft.tokensObtainedAt + expiresIn * 1000 - REFRESH_MARGIN_MS <= now;
};

const make = Effect.gen(function* () {
  const url = yield* Config.String("WORKLAYER_MCP_URL").pipe(
    Config.withDefault(DEFAULT_WORKLAYER_MCP_URL),
  );
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  // Loaded on first use; every change is written through to the secret store.
  const cache = yield* Ref.make<Option.Option<Option.Option<Draft>>>(Option.none());
  // One sign-in at a time; starting another replaces it.
  const pendingFlow = yield* Ref.make<
    Option.Option<{ readonly state: string; readonly verifier?: string }>
  >(Option.none());

  const storageFailed = (cause: unknown) =>
    new WorkLayerAuthError({ reason: "storage_failed", cause });

  const load = Effect.gen(function* () {
    const cached = yield* Ref.get(cache);
    if (Option.isSome(cached)) return cached.value;
    const bytes = yield* secrets.get(SECRET_NAME);
    const draft = Option.isNone(bytes)
      ? Option.none<Draft>()
      : yield* decodeStored(new TextDecoder().decode(bytes.value)).pipe(
          Effect.map((stored) => Option.some(stored as Draft)),
          // A file this build cannot read is treated as not connected.
          Effect.catchTags({ SchemaError: () => Effect.succeedNone }),
        );
    yield* Ref.set(cache, Option.some(draft));
    return draft;
  }).pipe(Effect.mapError(storageFailed));

  const save = (draft: Draft) =>
    encodeStored(draft as StoredConnection).pipe(
      Effect.flatMap((text) => secrets.set(SECRET_NAME, new TextEncoder().encode(text))),
      Effect.andThen(Ref.set(cache, Option.some(Option.some({ ...draft })))),
      Effect.mapError(storageFailed),
    );

  const runAuth = (provider: OAuthClientProvider, authorizationCode?: string) =>
    Effect.tryPromise({
      try: () =>
        auth(provider, {
          serverUrl: url,
          ...(authorizationCode === undefined ? {} : { authorizationCode }),
        }),
      catch: (cause) => new WorkLayerAuthError({ reason: "sign_in_failed", cause }),
    });

  const refresh = Effect.fn("WorkLayerConnection.refresh")(function* (draft: Draft) {
    const now = yield* Clock.currentTimeMillis;
    const next: Draft = { ...draft };
    // A throwaway flow: a failed refresh falls back to a new authorization,
    // which must not clobber a sign-in the user has open.
    const result = yield* runAuth(makeProvider(next, { state: "refresh" }, now)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("WorkLayer token refresh failed", { error: error.message }).pipe(
          Effect.as("REDIRECT" as const),
        ),
      ),
    );
    if (result !== "AUTHORIZED") delete next.tokens;
    yield* save(next);
    return next;
  });

  const authorization: WorkLayerConnection["Service"]["authorization"] = Effect.gen(function* () {
    const loaded = yield* load;
    if (Option.isNone(loaded) || loaded.value.tokens === undefined) return Option.none();
    let draft = loaded.value;
    const now = yield* Clock.currentTimeMillis;
    if (needsRefresh(draft, now)) {
      if (draft.tokens?.refresh_token === undefined) return Option.none();
      draft = yield* refresh(draft);
    }
    return Option.map(Option.fromNullishOr(draft.tokens), (tokens) =>
      Redacted.make(`Bearer ${tokens.access_token}`),
    );
  }).pipe(
    lock.withPermit,
    Effect.catch((error) =>
      Effect.logWarning("WorkLayer credentials unavailable", { error: error.message }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );

  const markRejected: WorkLayerConnection["Service"]["markRejected"] = Effect.gen(function* () {
    const loaded = yield* load;
    if (Option.isNone(loaded) || loaded.value.stale === true) return;
    yield* save({ ...loaded.value, stale: true });
  }).pipe(lock.withPermit, Effect.ignore);

  const startSignIn: WorkLayerConnection["Service"]["startSignIn"] = Effect.fn(
    "WorkLayerConnection.startSignIn",
  )(function* (redirectUrl) {
    const loaded = yield* load;
    const now = yield* Clock.currentTimeMillis;
    const state = yield* crypto.randomBytes(24).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.orDie,
    );
    const previous = Option.getOrUndefined(loaded);
    // A client registered for another redirect URL (another port or origin) cannot finish here.
    const draft: Draft = {
      redirectUrl,
      ...(previous?.redirectUrl === redirectUrl && previous.clientInformation !== undefined
        ? { clientInformation: previous.clientInformation }
        : {}),
      ...(previous?.discoveryState === undefined
        ? {}
        : { discoveryState: previous.discoveryState }),
    };
    const flow: { state: string; verifier?: string; authorizationUrl?: URL } = { state };
    yield* runAuth(makeProvider(draft, flow, now));
    if (flow.authorizationUrl === undefined || flow.verifier === undefined) {
      return yield* new WorkLayerAuthError({ reason: "sign_in_failed" });
    }
    // Keep the old tokens working until the new sign-in completes.
    yield* save({
      ...draft,
      ...(previous?.tokens === undefined ? {} : { tokens: previous.tokens }),
      ...(previous?.tokensObtainedAt === undefined
        ? {}
        : { tokensObtainedAt: previous.tokensObtainedAt }),
    });
    yield* Ref.set(pendingFlow, Option.some({ state, verifier: flow.verifier }));
    return flow.authorizationUrl;
  }, lock.withPermit);

  const completeSignIn: WorkLayerConnection["Service"]["completeSignIn"] = Effect.fn(
    "WorkLayerConnection.completeSignIn",
  )(function* ({ code, state }) {
    const pending = yield* Ref.get(pendingFlow);
    const loaded = yield* load;
    if (Option.isNone(pending) || pending.value.state !== state || Option.isNone(loaded)) {
      return yield* new WorkLayerAuthError({ reason: "unknown_state" });
    }
    const now = yield* Clock.currentTimeMillis;
    const draft: Draft = { ...loaded.value };
    delete draft.tokens;
    yield* runAuth(makeProvider(draft, { ...pending.value }, now), code);
    yield* Ref.set(pendingFlow, Option.none());
    yield* save(draft);
  }, lock.withPermit);

  const disconnect: WorkLayerConnection["Service"]["disconnect"] = Effect.gen(function* () {
    yield* secrets.remove(SECRET_NAME).pipe(Effect.mapError(storageFailed));
    yield* Ref.set(cache, Option.some(Option.none()));
    yield* Ref.set(pendingFlow, Option.none());
  }).pipe(lock.withPermit);

  return WorkLayerConnection.of({
    url,
    authorization,
    markRejected,
    startSignIn,
    completeSignIn,
    disconnect,
  });
});

export const layer = Layer.effect(WorkLayerConnection, Effect.orDie(make));
