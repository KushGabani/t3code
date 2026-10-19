/**
 * Serves WorkLayer's MCP server at `/mcp/worklayer` on T3's own origin.
 *
 * Every harness T3 launches gets a `worklayer` MCP entry pointing here with
 * its T3 session credential (see `worklayerMcpEndpoint`). This route checks
 * that credential, swaps it for the server's one WorkLayer token, and
 * forwards the request unchanged. Tools, resources (MCP Apps UI) and prompts
 * all pass through, so nothing about WorkLayer's surface is mirrored here,
 * and agents never hold a WorkLayer credential.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { WORKLAYER_MCP_SERVER_NAME } from "@t3tools/provider-core/server/mcpSession";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as WorkLayerConnection from "./WorkLayerConnection.ts";

export const WORKLAYER_MCP_PATH = `/mcp/${WORKLAYER_MCP_SERVER_NAME}`;

/** Streamable HTTP headers WorkLayer needs; everything else (cookies, the T3 bearer) stays here. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

/**
 * `www-authenticate` is dropped so a harness never starts its own OAuth flow
 * against WorkLayer when the server's token is missing or expired.
 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

const jsonRpcError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message } },
    { status, headers: { "cache-control": "no-store" } },
  );

const proxy = (
  registry: McpSessionRegistry.McpSessionRegistry["Service"],
  connection: WorkLayerConnection.WorkLayerConnection["Service"],
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    if ((yield* registry.resolve(token)) === undefined) {
      return jsonRpcError(401, "A valid T3 Code MCP session credential is required.");
    }

    const upstreamAuthorization = yield* connection.authorization;
    if (Option.isNone(upstreamAuthorization)) {
      return jsonRpcError(503, "WorkLayer is not connected.");
    }

    const headers: Record<string, string> = {
      authorization: Redacted.value(upstreamAuthorization.value),
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const method = request.method;
    const upstreamRequest = HttpClientRequest.make(method)(connection.url).pipe(
      HttpClientRequest.setHeaders(headers),
      method === "POST"
        ? HttpClientRequest.bodyStream(request.stream, {
            contentType: request.headers["content-type"],
          })
        : (self) => self,
    );
    const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* httpClient.execute(upstreamRequest).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("WorkLayer MCP request failed", { error: error.message }),
      ),
      Effect.option,
    );
    if (Option.isNone(response)) {
      return jsonRpcError(502, "WorkLayer could not be reached.");
    }
    const upstream = response.value;
    if (upstream.status === 401 || upstream.status === 403) {
      yield* Effect.logWarning("WorkLayer rejected the server's credential", {
        status: upstream.status,
      });
    }
    const responseHeaders: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers[name];
      if (value !== undefined) responseHeaders[name] = value;
    }
    // SSE responses must reach the harness as they arrive, not after compression buffers them.
    responseHeaders["cache-control"] ??= "no-store";
    responseHeaders["cache-control"] += ", no-transform";
    return HttpServerResponse.stream(upstream.stream, {
      status: upstream.status,
      headers: responseHeaders,
      ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
    });
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const connection = yield* WorkLayerConnection.WorkLayerConnection;
    return HttpRouter.add("*", WORKLAYER_MCP_PATH, proxy(registry, connection));
  }),
);
