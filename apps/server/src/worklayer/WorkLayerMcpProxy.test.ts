import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as WorkLayerConnection from "./WorkLayerConnection.ts";
import * as WorkLayerMcpProxy from "./WorkLayerMcpProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const SESSION_TOKEN = "agent-session-token";

const fixture = (options: { readonly connected: boolean }) => {
  const upstream: Array<Request> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const web = new Request(request.url, {
        method: request.method,
        headers: request.headers,
      });
      upstream.push(web);
      return HttpClientResponse.fromWeb(
        request,
        new Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', {
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "worklayer-session",
            "www-authenticate": 'Bearer resource_metadata="https://worklayer.test/.well-known"',
            "set-cookie": "worklayer=1",
          },
        }),
      );
    }),
  );
  const registry = McpSessionRegistry.McpSessionRegistry.of({
    issue: () => Effect.die("unused"),
    resolve: (token) =>
      Effect.succeed(
        token === SESSION_TOKEN ? ({} as McpInvocationContext.McpThreadInvocationScope) : undefined,
      ),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    WorkLayerMcpProxy.layer.pipe(
      Layer.provideMerge(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
      Layer.provideMerge(
        Layer.succeed(
          WorkLayerConnection.WorkLayerConnection,
          WorkLayerConnection.WorkLayerConnection.of({
            markRejected: Effect.void,
            startSignIn: () => Effect.die("unused"),
            completeSignIn: () => Effect.die("unused"),
            disconnect: Effect.void,
            url: "https://worklayer.test/mcp",
            authorization: Effect.succeed(
              options.connected
                ? Option.some(Redacted.make("Bearer worklayer-token"))
                : Option.none(),
            ),
          }),
        ),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, upstream };
};

const mcpRequest = (authorization: string | undefined) =>
  new Request("http://t3.test/mcp/worklayer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "worklayer-session",
      cookie: "t3_session=secret",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });

describe("WorkLayer MCP proxy", () => {
  it("forwards with the server's WorkLayer token in place of the agent's credential", async () => {
    const { handler, upstream } = fixture({ connected: true });
    const response = await handler(mcpRequest(`Bearer ${SESSION_TOKEN}`));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"tools":[]');
    expect(response.headers.get("mcp-session-id")).toBe("worklayer-session");
    // A harness must never be pointed at WorkLayer's own sign-in.
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();

    expect(upstream).toHaveLength(1);
    const forwarded = upstream[0]!;
    expect(forwarded.url).toBe("https://worklayer.test/mcp");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("authorization")).toBe("Bearer worklayer-token");
    expect(forwarded.headers.get("mcp-session-id")).toBe("worklayer-session");
    expect(forwarded.headers.get("cookie")).toBeNull();
  });

  it("rejects a request without a live T3 session credential before reaching WorkLayer", async () => {
    const { handler, upstream } = fixture({ connected: true });

    expect((await handler(mcpRequest(undefined))).status).toBe(401);
    expect((await handler(mcpRequest("Bearer someone-else"))).status).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  it("answers 503 while WorkLayer is not connected", async () => {
    const { handler, upstream } = fixture({ connected: false });

    expect((await handler(mcpRequest(`Bearer ${SESSION_TOKEN}`))).status).toBe(503);
    expect(upstream).toHaveLength(0);
  });
});
