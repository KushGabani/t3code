import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The environment's WorkLayer MCP connection, kept live while the sidebar shows it. */
export const worklayerConnectionState = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:worklayer:connection",
    tag: WS_METHODS.worklayerSubscribe,
  },
);

/** Starts signing in; the result is WorkLayer's sign-in page to open in the browser. */
export const worklayerConnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:worklayer:connect",
  tag: WS_METHODS.worklayerConnect,
});
