import type { ServerContext } from "@modelcontextprotocol/server";
import { askUser } from "./confirm.js";
import type { Config } from "./config.js";

const CODE_OF_CONDUCT = "https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct";

export interface Planned {
  /** Changesets about to be opened */
  changesets?: number;
  /** Elements about to be created, modified or deleted */
  elements?: number;
  /** One line saying what is about to happen, shown to the user */
  what: string;
}

/**
 * Per-session counter that adds friction, at the right moment, to edits that look like bulk or scripted work.
 * It cannot judge intent: a person mapping a big area by hand and an agent looping over a dataset look the same.
 * Past a limit it asks the user (MCP elicitation) to confirm, points at the automated edits code of conduct, and
 * lets them paste a proposal link. Where the client cannot ask it refuses, naming the setting that turns it off,
 * because silently continuing is the failure this exists to prevent.
 */
export class WriteGuard {
  changesets = 0;
  elements = 0;
  /** Reserved by calls that passed `check` but have not finished writing; counted so parallel calls cannot slip past the limit. */
  private pendingChangesets = 0;
  private pendingElements = 0;
  private elementLimit: number;
  private changesetLimit: number;
  private readonly baseElements: number;
  /** Last proposal link the user gave, for the session */
  proposalUrl: string | undefined;

  constructor(private readonly cfg: Pick<Config, "guardElements" | "guardChangesets" | "confirmWrites">) {
    this.elementLimit = this.baseElements = cfg.guardElements;
    this.changesetLimit = cfg.guardChangesets;
  }

  get enabled(): boolean {
    return this.cfg.confirmWrites && (this.elementLimit > 0 || this.changesetLimit > 0);
  }

  /**
   * Run one write behind the guard. The planned amount is reserved before anything is awaited, so two tool calls issued
   * in parallel are counted together; it is committed (or replaced by `actual`) when the write succeeds and released
   * when it fails or is refused. Returns a tool-result object instead of calling `write` when the user (or the client's
   * lack of elicitation) says no.
   */
  async run<T>(ctx: ServerContext, p: Planned, write: () => Promise<T>, actual?: (result: T) => { changesets?: number; elements?: number }): Promise<T | object> {
    const plan = { changesets: p.changesets ?? 0, elements: p.elements ?? 0 };
    this.pendingChangesets += plan.changesets;
    this.pendingElements += plan.elements;
    const release = () => {
      this.pendingChangesets -= plan.changesets;
      this.pendingElements -= plan.elements;
    };
    let stop: object | undefined;
    try {
      stop = await this.decide(ctx, p);
    } catch (e) {
      release();
      throw e;
    }
    if (stop) {
      release();
      return stop;
    }
    try {
      const result = await write();
      release();
      this.record(actual ? actual(result) : plan);
      return result;
    } catch (e) {
      release();
      throw e;
    }
  }

  /** Asks if this call (already reserved in the pending counters) pushes the session over a limit. */
  private async decide(ctx: ServerContext, p: Planned): Promise<object | undefined> {
    if (!this.enabled) return undefined;
    const cs = this.changesets + this.pendingChangesets;
    const el = this.elements + this.pendingElements;
    const over = (this.changesetLimit > 0 && cs > this.changesetLimit) || (this.elementLimit > 0 && el > this.elementLimit);
    if (!over) return undefined;

    const summary = `This session has opened ${this.changesets} changeset(s) and written ${this.elements} element(s). Next: ${p.what}. That would make ${cs} changeset(s) and ${el} element(s).`;
    const rule = `Scripted, repeated or dataset-based edits need a discussed community proposal first (${CODE_OF_CONDUCT}). Edits are public and permanent. If you are mapping this by hand, just continue.`;
    const r = await askUser(
      ctx,
      this.cfg,
      `${summary}\n\n${rule}`,
      {
        confirm: { type: "boolean", title: "Continue with this edit", default: false },
        proposal_url: { type: "string", title: "Link to the proposal or discussion (if this is scripted or from a dataset)" },
      },
      ["confirm"],
    );

    if (r.status === "skipped") {
      if (r.cause === "off") return undefined;
      return {
        refused: true,
        message: `${summary} ${rule} This client cannot ask you to confirm, so the write was not made. Ask the user whether a proposal has been posted and discussed; if this is ordinary hand mapping, they can raise the limits with OSM_GUARD_ELEMENTS and OSM_GUARD_CHANGESETS (0 turns the guard off) and restart the server.`,
      };
    }
    if (r.status !== "confirmed" || r.values.confirm !== true) {
      return { cancelled: true, message: "The user did not confirm, so nothing was changed. Ask them what they want instead." };
    }
    const link = typeof r.values.proposal_url === "string" ? r.values.proposal_url.trim() : "";
    if (link) {
      let ok = false;
      try {
        ok = /^https?:$/.test(new URL(link).protocol);
      } catch {
        /* not a URL */
      }
      if (!ok) return { cancelled: true, message: "The proposal link was not a valid http(s) URL, so nothing was changed. Ask the user for the link." };
      this.proposalUrl = link;
    }
    // Confirmed: allow a doubling of elements and ten more changesets before asking again.
    if (this.elementLimit > 0) this.elementLimit = Math.max(this.elementLimit, el * 2, this.baseElements);
    if (this.changesetLimit > 0) this.changesetLimit = Math.max(this.changesetLimit, cs + 10);
    return undefined;
  }

  /** Count a write that actually happened. */
  record(p: { changesets?: number; elements?: number }): void {
    this.changesets += p.changesets ?? 0;
    this.elements += p.elements ?? 0;
  }
}
