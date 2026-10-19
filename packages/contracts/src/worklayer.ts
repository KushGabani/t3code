import * as Schema from "effect/Schema";

/**
 * The environment's one WorkLayer MCP connection. `connecting` means a
 * sign-in was started and is waiting for the user to finish in their browser.
 */
export const WorkLayerConnectionState = Schema.Struct({
  status: Schema.Literals(["disconnected", "connecting", "connected"]),
});
export type WorkLayerConnectionState = typeof WorkLayerConnectionState.Type;

export const WorkLayerConnectResult = Schema.Struct({
  /** WorkLayer's sign-in page, to open in the user's browser. */
  authorizationUrl: Schema.String,
});
export type WorkLayerConnectResult = typeof WorkLayerConnectResult.Type;

export class WorkLayerConnectError extends Schema.TaggedError<WorkLayerConnectError>()(
  "WorkLayerConnectError",
  {
    message: Schema.String,
  },
) {}
