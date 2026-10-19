/**
 * Browser routes that sign the server in to WorkLayer.
 *
 * Opening `/oauth/worklayer/connect` in a signed-in T3 browser session sends
 * the user to WorkLayer, which comes back to `/oauth/worklayer/callback` on
 * the same origin. They live under `/oauth` so the dev proxy forwards them
 * with the browser's own Host, keeping the redirect URL on the page's origin.
 */
import { AuthProvidersManageScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as WorkLayerConnection from "./WorkLayerConnection.ts";

export const WORKLAYER_CONNECT_PATH = "/oauth/worklayer/connect";
export const WORKLAYER_CALLBACK_PATH = "/oauth/worklayer/callback";

const page = (status: number, text: string) =>
  HttpServerResponse.text(
    `<!doctype html><meta charset="utf-8"><title>WorkLayer</title><p style="font:16px system-ui;margin:3rem">${text}</p>`,
    { status, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" } },
  );

const connect = (connection: WorkLayerConnection.WorkLayerConnection["Service"]) =>
  Effect.gen(function* () {
    yield* authenticateMediaRequest(AuthProvidersManageScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return page(400, "Bad request.");
    return yield* connection.startSignIn(`${url.value.origin}${WORKLAYER_CALLBACK_PATH}`).pipe(
      Effect.map((authorizationUrl) =>
        HttpServerResponse.redirect(authorizationUrl, { status: 302 }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("WorkLayer sign-in could not start", { cause: error.cause }).pipe(
          Effect.as(page(502, error.message)),
        ),
      ),
    );
  });

const callback = (connection: WorkLayerConnection.WorkLayerConnection["Service"]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const params = Option.map(url, (value) => value.searchParams);
    const code = Option.flatMapNullishOr(params, (search) => search.get("code"));
    const state = Option.flatMapNullishOr(params, (search) => search.get("state"));
    if (Option.isNone(code) || Option.isNone(state)) {
      const error = Option.flatMapNullishOr(params, (search) => search.get("error"));
      return page(
        400,
        `WorkLayer did not sign you in${Option.isSome(error) ? ` (${error.value})` : ""}.`,
      );
    }
    return yield* connection.completeSignIn({ code: code.value, state: state.value }).pipe(
      Effect.as(page(200, "WorkLayer is connected. You can close this tab.")),
      Effect.catch((error) =>
        Effect.logWarning("WorkLayer sign-in could not finish", { cause: error.cause }).pipe(
          Effect.as(page(error.reason === "unknown_state" ? 400 : 502, error.message)),
        ),
      ),
    );
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const connection = yield* WorkLayerConnection.WorkLayerConnection;
    return Layer.mergeAll(
      HttpRouter.add("GET", WORKLAYER_CONNECT_PATH, connect(connection)),
      HttpRouter.add("GET", WORKLAYER_CALLBACK_PATH, callback(connection)),
    );
  }),
);
