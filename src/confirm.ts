import { SdkError, SdkErrorCode, type ServerContext } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";

/**
 * Outcome of asking the user through MCP elicitation.
 * - `confirmed`: the user accepted (and `values` holds the form fields)
 * - `declined` / `cancelled`: the user said no or dismissed the prompt; do not write
 * - `skipped`: we could not ask (disabled by OSM_CONFIRM_WRITES=off, or the client has no elicitation), so the caller
 *   proceeds exactly as it did before elicitation existed and relies on the model having asked in chat
 */
export type AskResult =
  | { status: "confirmed"; values: Record<string, unknown> }
  | { status: "declined" | "cancelled" }
  | { status: "skipped"; cause: "off" | "unsupported"; reason: string };

type Field =
  | { type: "boolean"; title: string; description?: string; default?: boolean }
  | { type: "string"; title: string; description?: string; enum?: string[]; default?: string };

const SKIP_CODES = new Set<string>([SdkErrorCode.CapabilityNotSupported, SdkErrorCode.MethodNotSupportedByProtocolVersion]);

/**
 * Pause a tool call and ask the user. Never throws for "cannot ask": it returns `skipped` so tools keep working on
 * clients without elicitation, in unattended runs and over the 2026-era stateless HTTP path (which has no
 * server-to-client requests). Real transport or client errors still propagate, so a write is never made after a
 * failed prompt.
 */
export async function askUser(
  ctx: ServerContext,
  cfg: Pick<Config, "confirmWrites">,
  message: string,
  fields: Record<string, Field>,
  required: string[] = Object.keys(fields),
): Promise<AskResult> {
  if (!cfg.confirmWrites) return { status: "skipped", cause: "off", reason: "confirmations are turned off (OSM_CONFIRM_WRITES)" };
  try {
    const r = await ctx.mcpReq.elicitInput({
      mode: "form",
      message,
      requestedSchema: { type: "object", properties: fields, required },
    });
    if (r.action === "accept") return { status: "confirmed", values: (r.content ?? {}) as Record<string, unknown> };
    return { status: r.action === "decline" ? "declined" : "cancelled" };
  } catch (e) {
    if (e instanceof SdkError && SKIP_CODES.has(e.code)) return { status: "skipped", cause: "unsupported", reason: "the client does not support elicitation" };
    throw e;
  }
}

/** Yes/no confirmation for an irreversible or public write. `true` means go ahead. */
export async function confirmWrite(ctx: ServerContext, cfg: Pick<Config, "confirmWrites">, message: string): Promise<boolean> {
  const r = await askUser(ctx, cfg, message, { confirm: { type: "boolean", title: "Yes, go ahead", default: false } });
  if (r.status === "skipped") return true;
  return r.status === "confirmed" && r.values.confirm === true;
}

export const NOT_CONFIRMED = { cancelled: true, message: "The user did not confirm, so nothing was changed. Ask them what they want instead." } as const;
