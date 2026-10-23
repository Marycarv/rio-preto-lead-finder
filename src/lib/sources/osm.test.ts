import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOsmLeads, normalizeOsmElements, splitOsmBounds } from "@/lib/sources/osm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenStreetMap lead normalization", () => {
  it("uses stable source IDs and removes duplicate elements", () => {
    const input = [
      { type: "node", id: 101, lat: -20.81, lon: -49.38, tags: { name: "Café Central", amenity: "cafe", phone: "(17) 3333-1212" } },
      { type: "node", id: 101, lat: -20.81, lon: -49.38, tags: { name: "Café Central", amenity: "cafe", phone: "(17) 3333-1212" } },
      { type: "way", id: 202, center: { lat: -20.82, lon: -49.39 }, tags: { name: "Loja Exemplo", shop: "clothes", website: "https://example.com", "website:menu": "https://example.com/menu" } },
    ];

    const leads = normalizeOsmElements(input, "São José do Rio Preto");
    expect(leads).toHaveLength(2);
    expect(leads.map((lead) => lead.source_id)).toEqual(["node/101", "way/202"]);
    expect(leads[0]).toMatchObject({
      source: "openstreetmap",
      name: "Café Central",
      city: "São José do Rio Preto",
      phone: "(17) 3333-1212",
      has_website: false,
      has_menu: false,
      lat: -20.81,
      lon: -49.38,
    });
    expect(leads[1]).toMatchObject({
      source_id: "way/202",
      has_website: true,
      has_menu: true,
      lat: -20.82,
      lon: -49.39,
    });
  });

  it("ignores missing names, unsafe identifiers and invalid coordinates", () => {
    const leads = normalizeOsmElements([
      { type: "node", id: 11, tags: { amenity: "cafe" } },
      { type: "unknown", id: 12, tags: { name: "Not a supported OSM element" } },
      { type: "node", id: -2, tags: { name: "Invalid ID" } },
      { type: "node", id: 13, lat: 999, lon: 1000, tags: { name: "Coordinates omitted" } },
    ], "Mirassol");

    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      source_id: "node/13",
      lat: null,
      lon: null,
      city: "Mirassol",
    });
  });
});


describe("verified municipal query subdivision", () => {
  it("splits a verified extent into four tiles without inventing coordinates", () => {
    const bounds = { south: -21, west: -50, north: -20, east: -49 };
    expect(splitOsmBounds(bounds)).toEqual([
      { south: -21, west: -50, north: -20.5, east: -49.5 },
      { south: -21, west: -49.5, north: -20.5, east: -49 },
      { south: -20.5, west: -50, north: -20, east: -49.5 },
      { south: -20.5, west: -49.5, north: -20, east: -49 },
    ]);
  });
});


describe("OpenStreetMap service failures", () => {
  it("stops safely when Nominatim returns HTTP 429", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOsmLeads("Cedral")).rejects.toThrow("limitando consultas");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a bounded Overpass fallback and surfaces rate limits without partial results", async () => {
    const cityBoundary = [{
      osm_type: "relation",
      osm_id: 123456,
      name: "Cedral",
      category: "boundary",
      type: "administrative",
      address: { city: "Cedral", state: "São Paulo", country: "Brasil" },
      extratags: { admin_level: "8" },
      boundingbox: ["-20.95", "-20.75", "-49.35", "-49.10"],
    }];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://nominatim.openstreetmap.org/")) {
        return new Response(JSON.stringify(cityBoundary), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("rate limited", { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOsmLeads("Cedral")).rejects.toThrow("limitando consultas");
    // One validated boundary lookup plus at most two Overpass attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("subdivides a verified city boundary after an Overpass query timeout", async () => {
    const cityBoundary = [{
      osm_type: "relation",
      osm_id: 123457,
      name: "Cedral",
      category: "boundary",
      type: "administrative",
      address: { city: "Cedral", state: "São Paulo", country: "Brasil" },
      extratags: { admin_level: "8" },
      boundingbox: ["-20.95", "-20.75", "-49.35", "-49.10"],
    }];

    const requestedQueries: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://nominatim.openstreetmap.org/")) {
        return new Response(JSON.stringify(cityBoundary), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const body = String(init?.body ?? "");
      requestedQueries.push(decodeURIComponent(body));
      if (requestedQueries.length === 1) {
        return new Response("gateway timeout", { status: 504 });
      }
      return new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOsmLeads("Cedral")).resolves.toEqual([]);
    // The first whole-city query timed out; the remaining queries should use
    // smaller bounds derived from the validated municipal response.
    expect(requestedQueries.length).toBe(8);
    expect(requestedQueries.slice(1, 5).every((query) => query.includes("area(3600123457)"))).toBe(true);
    expect(requestedQueries.slice(1, 5).every((query) => /\(-20\.\d+,-49\.\d+,-20\.\d+,-49\.\d+\)/.test(query))).toBe(true);
  }, 15_000);

  it("rejects unlisted cities without making public-service requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOsmLeads("Cidade não configurada")).rejects.toThrow("Cidade inválida");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
