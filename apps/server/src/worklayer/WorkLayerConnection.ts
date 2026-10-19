/**
 * The server's one connection to WorkLayer MCP, shared by every harness.
 *
 * Spike: the access token comes from `WORKLAYER_ACCESS_TOKEN`. Signing in
 * with OAuth and storing the token in `ServerSecretStore` replaces that next;
 * callers only ever ask for the current `Authorization` header, so they do
 * not change.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export const DEFAULT_WORKLAYER_MCP_URL = "https://mcp.myworklayer.com";

export class WorkLayerConnection extends Context.Service<
  WorkLayerConnection,
  {
    /** WorkLayer's MCP endpoint. */
    readonly url: string;
    /** Header to send upstream, or none while WorkLayer is not connected. */
    readonly authorization: Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  }
>()("t3/worklayer/WorkLayerConnection") {}

const make = Effect.gen(function* () {
  const url = yield* Config.String("WORKLAYER_MCP_URL").pipe(
    Config.withDefault(DEFAULT_WORKLAYER_MCP_URL),
  );
  const token = yield* Config.Redacted("WORKLAYER_ACCESS_TOKEN").pipe(Config.option);
  const authorization = Option.map(token, (value) =>
    Redacted.make(`Bearer ${Redacted.value(value)}`),
  );
  return WorkLayerConnection.of({ url, authorization: Effect.succeed(authorization) });
});

export const layer = Layer.effect(WorkLayerConnection, Effect.orDie(make));
