import { describe, expect, it } from "vitest";
import { normalizeOsmElements, splitOsmBounds } from "@/lib/sources/osm";

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
