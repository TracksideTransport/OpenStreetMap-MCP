import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ATTRIBUTION, Nominatim } from "../nominatim.js";
import { READ_ONLY, safe, type Ctx } from "./util.js";

const POLICY = "Uses the Nominatim public service under its usage policy (https://operations.osmfoundation.org/policies/nominatim/): one request per second, results cached. Only for interactive lookups the user asked for. Never use for autocomplete, bulk or grid queries, or scraping.";

const bbox = z.object({ min_lon: z.number().min(-180).max(180), min_lat: z.number().min(-90).max(90), max_lon: z.number().min(-180).max(180), max_lat: z.number().min(-90).max(90) });

export function registerGeocodeTools(server: McpServer, { cfg }: Ctx, client = new Nominatim(cfg.nominatimBase, cfg.userAgent)) {
  server.registerTool(
    "osm_geocode",
    {
      description: `Turn a place name or address into coordinates, an OSM element id, and a bounding box usable with osm_get_bbox (keep that box small; the API rejects large areas). ${POLICY}`,
      inputSchema: z.object({
        query: z.string().min(2).max(300).describe("Place name or address, e.g. 'Fenway Park, Boston'"),
        limit: z.number().int().min(1).max(10).default(5),
        country_codes: z.array(z.string().length(2)).max(10).optional().describe("ISO 3166-1 alpha-2 codes to restrict results"),
        viewbox: bbox.optional().describe("Prefer results inside this box"),
        bounded: z.boolean().default(false).describe("With viewbox: return only results inside it"),
        language: z.string().max(35).optional().describe("Preferred result language, e.g. 'en'"),
      }),
      annotations: READ_ONLY,
    },
    safe(async (a) => ({ results: await client.search(a), attribution: ATTRIBUTION })),
  );

  server.registerTool(
    "osm_reverse_geocode",
    {
      description: `Find the address or place at one coordinate. ${POLICY}`,
      inputSchema: z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        zoom: z.number().int().min(3).max(18).default(18).describe("Detail level: 3 country, 10 city/suburb, 18 building"),
        language: z.string().max(35).optional(),
      }),
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const place = await client.reverse(a);
      return place ? { result: place, attribution: ATTRIBUTION } : { result: null, note: "Nothing found at this location.", attribution: ATTRIBUTION };
    }),
  );
}
