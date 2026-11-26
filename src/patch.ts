import { buildElementXml, type ElementInput, type ElementType, type OsmClient } from "./osm.js";

export interface PatchTagsArgs {
  changeset_id: number;
  type: ElementType;
  id: number;
  /** Tags to add or overwrite. */
  set?: Record<string, string>;
  /** Tag keys to delete. Keys that are not present are reported, not an error. */
  remove?: string[];
  /** If given, fail unless the element is still at this version (guards against stale reads). */
  expected_version?: number;
}

export interface PatchTagsResult {
  type: ElementType;
  id: number;
  changed: boolean;
  version: number;
  old_tags: Record<string, string>;
  new_tags: Record<string, string>;
  ignored_remove: string[];
}

/** Fetch the current element, merge tag changes, and write it back unchanged apart from tags. */
export async function patchTags(osm: OsmClient, a: PatchTagsArgs): Promise<PatchTagsResult> {
  const set = a.set ?? {};
  const remove = a.remove ?? [];
  if (!Object.keys(set).length && !remove.length) throw new Error("Nothing to do: provide `set` and/or `remove`.");
  const clash = remove.filter((k) => k in set);
  if (clash.length) throw new Error(`Keys appear in both set and remove: ${clash.join(", ")}`);

  const cur = (await osm.getJson(`/${a.type}/${a.id}.json`, { auth: "optional" })).elements?.[0];
  if (!cur) throw new Error(`${a.type} ${a.id} not found.`);
  if (a.expected_version !== undefined && cur.version !== a.expected_version) {
    throw new Error(`Version conflict: ${a.type} ${a.id} is at version ${cur.version}, expected ${a.expected_version}. Re-read it and retry.`);
  }

  const oldTags: Record<string, string> = { ...(cur.tags ?? {}) };
  const newTags: Record<string, string> = { ...oldTags, ...set };
  const ignored: string[] = [];
  for (const k of remove) {
    if (k in newTags) delete newTags[k];
    else ignored.push(k);
  }

  const unchanged = JSON.stringify(sortKeys(oldTags)) === JSON.stringify(sortKeys(newTags));
  if (unchanged) {
    return { type: a.type, id: a.id, changed: false, version: cur.version, old_tags: oldTags, new_tags: newTags, ignored_remove: ignored };
  }

  const el: ElementInput = { type: a.type, id: a.id, version: cur.version, tags: newTags };
  if (a.type === "node") {
    el.lat = cur.lat;
    el.lon = cur.lon;
  } else if (a.type === "way") {
    el.nodes = cur.nodes ?? [];
  } else {
    el.members = (cur.members ?? []).map((m: { type: ElementType; ref: number; role?: string }) => ({ type: m.type, ref: m.ref, role: m.role }));
  }
  const out = await osm.send("PUT", `/${a.type}/${a.id}`, { body: buildElementXml(el, a.changeset_id) });
  return { type: a.type, id: a.id, changed: true, version: Number(out.trim()), old_tags: oldTags, new_tags: newTags, ignored_remove: ignored };
}

function sortKeys(o: Record<string, string>) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
