import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { worklayerConnect, worklayerConnectionState } from "../../state/worklayer";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const STATUS_LABEL = {
  connected: "WorkLayer connected",
  connecting: "Finish signing in to WorkLayer",
  disconnected: "Connect WorkLayer",
} as const;

/**
 * WorkLayer's MCP connection for the primary environment. Connecting opens
 * WorkLayer's sign-in page in the browser; the server finishes the sign-in
 * and the status updates here on its own.
 */
export function SidebarWorkLayerConnection() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : worklayerConnectionState({ environmentId, input: {} }),
  );
  const connect = useAtomCommand(worklayerConnect, { reportFailure: false, reportDefect: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = query.data?.status;
  if (environmentId === null || status === undefined) return null;

  async function handleConnect() {
    if (environmentId === null || pending) return;
    setPending(true);
    setError(null);
    // Browsers block tabs opened after an await, so the web build reserves one first.
    const tab = window.desktopBridge ? null : window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const result = await connect({ environmentId, input: {} });
      if (result._tag === "Success") {
        if (tab) tab.location.href = result.value.authorizationUrl;
        else await ensureLocalApi().shell.openExternal(result.value.authorizationUrl);
      } else {
        tab?.close();
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Could not reach WorkLayer.");
        }
      }
    } catch {
      tab?.close();
      setError("Could not open WorkLayer's sign-in page.");
    }
    setPending(false);
  }

  const connected = status === "connected";
  const label = error ?? STATUS_LABEL[status];
  const button = (
    <SidebarMenuButton
      aria-label={label}
      disabled={pending}
      onClick={connected ? undefined : () => void handleConnect()}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          connected
            ? "bg-success"
            : status === "connecting"
              ? "bg-warning"
              : "bg-muted-foreground/40",
          error !== null && "bg-destructive",
        )}
      />
      <span className="truncate">
        {connected ? "WorkLayer" : pending ? "Opening WorkLayer…" : label}
      </span>
    </SidebarMenuButton>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {connected || error !== null ? (
          <Tooltip>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
