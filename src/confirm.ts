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

/**
 * Public text posted under the user's account (changeset comments, notes). The user sees the exact words in an editable
 * field and decides what is sent, so what reaches OSM is theirs, not a model's composition (the OSM moderators remove
 * chatbot-composed posts). Returns the text to send (possibly edited), or undefined if they did not confirm. When the
 * client cannot ask, the model's text is returned unchanged, as before elicitation existed.
 */
export async function reviewPublicText(
  ctx: ServerContext,
  cfg: Pick<Config, "confirmWrites" | "env">,
  what: string,
  text: string | undefined,
  opts: { required: boolean },
): Promise<string | undefined | null> {
  const where = cfg.env === "dev" ? "the OSM sandbox" : "the real OpenStreetMap";
  const r = await askUser(
    ctx,
    cfg,
    `${what} on ${where}. It is public and posted under your account. Review the text and change it into your own words if you like: text composed by a chatbot can be removed by OSM moderators.`,
    {
      text: { type: "string", title: opts.required ? "Text to post" : "Text to post (optional)", default: text ?? "" },
      confirm: { type: "boolean", title: "Post it", default: false },
    },
    ["confirm"],
  );
  if (r.status === "skipped") return text;
  if (r.status !== "confirmed" || r.values.confirm !== true) return null;
  const edited = typeof r.values.text === "string" ? r.values.text.trim() : (text ?? "");
  if (opts.required && !edited) return null;
  return edited || undefined;
}
