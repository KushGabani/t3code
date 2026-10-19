// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - A local stand-in for WorkLayer MCP built on the official SDK.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpRouter } from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as WorkLayerConnection from "./WorkLayerConnection.ts";
import * as WorkLayerMcpProxy from "./WorkLayerMcpProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});

const SESSION_TOKEN = "agent-session-token";
const WORKLAYER_TOKEN = "worklayer-token";

/** A stand-in for WorkLayer MCP: one tool, one UI resource, and a bearer check. */
const startFakeWorkLayer = async () => {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const seenAuthorization: Array<string | undefined> = [];
  const makeServer = () => {
    const server = new Server(
      { name: "fake-worklayer", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "worklayer_discovery",
          description: "Find what exists in WorkLayer.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: "text", text: `found: ${String(request.params.arguments?.query)}` }],
    }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: "ui://worklayer/card", name: "card", mimeType: "text/html+mcp" }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: [{ uri: request.params.uri, mimeType: "text/html+mcp", text: "<p>card</p>" }],
    }));
    return server;
  };
  const http = NodeHttp.createServer(async (req, res) => {
    seenAuthorization.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${WORKLAYER_TOKEN}`) {
      res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="x"' }).end();
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => NodeCrypto.randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      // The SDK's own transport types disagree under exactOptionalPropertyTypes.
      await makeServer().connect(transport as Transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as NodeNet.AddressInfo;
  disposers.push(async () => {
    await Promise.all([...transports.values()].map((transport) => transport.close()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}/mcp`, seenAuthorization };
};

const proxyHandler = (worklayerUrl: string) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    WorkLayerMcpProxy.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(
          McpSessionRegistry.McpSessionRegistry,
          McpSessionRegistry.McpSessionRegistry.of({
            issue: () => Effect.die("unused"),
            resolve: (token) =>
              Effect.succeed(
                token === SESSION_TOKEN
                  ? ({} as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
            touch: () => Effect.void,
            revokeProviderSession: () => Effect.void,
            revokeThread: () => Effect.void,
            revokeAll: Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(
          WorkLayerConnection.WorkLayerConnection,
          WorkLayerConnection.WorkLayerConnection.of({
            markRejected: Effect.void,
            startSignIn: () => Effect.die("unused"),
            completeSignIn: () => Effect.die("unused"),
            disconnect: Effect.void,
            url: worklayerUrl,
            authorization: Effect.succeedSome(Redacted.make(`Bearer ${WORKLAYER_TOKEN}`)),
          }),
        ),
      ),
      Layer.provideMerge(FetchHttpClient.layer),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return handler;
};

describe("WorkLayer MCP proxy against a real MCP server", () => {
  it("lets an MCP client list and call WorkLayer tools and read its UI resources", async () => {
    const worklayer = await startFakeWorkLayer();
    const handler = proxyHandler(worklayer.url);
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://t3.test/mcp/worklayer"), {
        requestInit: { headers: { authorization: `Bearer ${SESSION_TOKEN}` } },
        fetch: (input, init) => handler(new Request(input, init)),
      }) as Transport,
    );
    disposers.unshift(() => client.close());

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["worklayer_discovery"]);

    const result = await client.callTool({
      name: "worklayer_discovery",
      arguments: { query: "pdf" },
    });
    expect(result.content).toEqual([{ type: "text", text: "found: pdf" }]);

    const resource = await client.readResource({ uri: "ui://worklayer/card" });
    expect(resource.contents[0]).toMatchObject({ text: "<p>card</p>" });

    // WorkLayer only ever sees the server's token, never the agent's.
    expect(new Set(worklayer.seenAuthorization)).toEqual(new Set([`Bearer ${WORKLAYER_TOKEN}`]));
  });
});
