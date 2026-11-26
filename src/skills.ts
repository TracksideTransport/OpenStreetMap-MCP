import { fileURLToPath } from "node:url";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";

/** The catalog type returned by the SDK; derived so we do not depend on a deep import path. */
export type SkillsCatalog = Awaited<ReturnType<typeof loadSkills>>;

/** The `skills/` folder shipped in the package (next to `src/` and `dist/`). */
export const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/**
 * Load the bundled skills once at startup. Skills are guidance on top of the tools, so a problem here must never stop
 * the server: log it and carry on without them.
 */
export async function loadServerSkills(dir: string = SKILLS_DIR): Promise<SkillsCatalog | undefined> {
  try {
    const catalog = await loadSkills(dir);
    if (catalog.entries.length === 0) {
      console.error(`openstreetmap-mcp: no skills found in ${dir}`);
      return undefined;
    }
    return catalog;
  } catch (e) {
    console.error(`openstreetmap-mcp: could not load skills from ${dir}: ${(e as Error).message}`);
    return undefined;
  }
}
