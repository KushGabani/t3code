import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

/**
 * MCP server entry name for WorkLayer's tools, so harnesses show them as
 * `mcp__worklayer__*` rather than under `t3-code`.
 */
export const WORKLAYER_MCP_SERVER_NAME = "worklayer";

/**
 * WorkLayer's tools are served by T3's own server next to `/mcp`, with the
 * same session credential. The server holds the one WorkLayer connection and
 * its token; agents never see it.
 */
export function worklayerMcpEndpoint(config: Pick<McpProviderSessionConfig, "endpoint">): string {
  return `${config.endpoint}/${WORKLAYER_MCP_SERVER_NAME}`;
}
