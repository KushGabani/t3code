// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - A local stand-in for WorkLayer's OAuth authorization server.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkLayerConnection from "./WorkLayerConnection.ts";

/**
 * Just enough of an MCP OAuth authorization server for the SDK client:
 * protected resource and server metadata, dynamic registration, an
 * authorize endpoint that approves at once, and a PKCE-checked token
 * endpoint that rotates refresh tokens.
 */
const startFakeAuthServer = async () => {
  let pending: { code: string; challenge: string } | undefined;
  let refreshToken: string | undefined;
  let counter = 0;
  const http = NodeHttp.createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url ?? "/", origin);
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    let body = "";
    for await (const chunk of req) body += String(chunk);

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      return json(201, { ...JSON.parse(body), client_id: "desktop-client" });
    }
    if (url.pathname === "/authorize") {
      pending = { code: `code-${++counter}`, challenge: url.searchParams.get("code_challenge")! };
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", pending.code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const verifier = form.get("code_verifier") ?? "";
        const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
        if (form.get("code") !== pending?.code || challenge !== pending.challenge) {
          return json(400, { error: "invalid_grant" });
        }
      } else if (grant !== "refresh_token" || form.get("refresh_token") !== refreshToken) {
        return json(400, { error: "invalid_grant" });
      }
      const accessToken = `access-${++counter}`;
      refreshToken = `refresh-${counter}`;
      return json(200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as NodeNet.AddressInfo;
  return {
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
};

const fakeAuthServer = Effect.acquireRelease(Effect.promise(startFakeAuthServer), (server) =>
  Effect.promise(server.close),
);

const makeConnection = Effect.fn("makeConnection")(function* (mcpUrl: string) {
  const data = new Map<string, Uint8Array>();
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(data.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        data.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        data.delete(name);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const connection = yield* Effect.service(WorkLayerConnection.WorkLayerConnection).pipe(
    Effect.provide(
      WorkLayerConnection.layer.pipe(
        Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
        Layer.provide(EffectNodeCrypto.layer),
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { WORKLAYER_MCP_URL: mcpUrl } })),
        ),
      ),
    ),
  );
  return { connection, data };
});

const header = (connection: WorkLayerConnection.WorkLayerConnection["Service"]) =>
  connection.authorization.pipe(
    Effect.map((value) => Option.getOrUndefined(Option.map(value, Redacted.value))),
  );

const REDIRECT_URL = "http://127.0.0.1:4773/oauth/worklayer/callback";

describe("WorkLayerConnection", () => {
  it.effect("signs in with OAuth, refreshes a rejected token, and disconnects", () =>
    Effect.gen(function* () {
      const authServer = yield* fakeAuthServer;
      const { connection, data } = yield* makeConnection(authServer.mcpUrl);
      expect(yield* header(connection)).toBeUndefined();

      const authorizationUrl = yield* connection.startSignIn(REDIRECT_URL);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URL);
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");

      // The user approves in their browser; WorkLayer sends it back with a code.
      const approved = yield* Effect.promise(() => fetch(authorizationUrl, { redirect: "manual" }));
      const back = new URL(approved.headers.get("location")!);
      yield* connection.completeSignIn({
        code: back.searchParams.get("code")!,
        state: back.searchParams.get("state")!,
      });
      expect(yield* header(connection)).toBe("Bearer access-2");
      expect(data.size).toBe(1);

      yield* connection.markRejected;
      expect(yield* header(connection)).toBe("Bearer access-3");
      expect(yield* header(connection)).toBe("Bearer access-3");

      yield* connection.disconnect;
      expect(yield* header(connection)).toBeUndefined();
      expect(data.size).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a callback whose state it did not issue", () =>
    Effect.gen(function* () {
      const authServer = yield* fakeAuthServer;
      const { connection } = yield* makeConnection(authServer.mcpUrl);
      yield* connection.startSignIn(REDIRECT_URL);
      const error = yield* Effect.flip(
        connection.completeSignIn({ code: "code-1", state: "forged" }),
      );
      expect(error.reason).toBe("unknown_state");
      expect(yield* header(connection)).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
