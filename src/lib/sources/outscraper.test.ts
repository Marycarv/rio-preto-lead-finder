import { afterEach, describe, expect, it, vi } from "vitest";
import { CITIES } from "@/lib/sources/cities";
import {
  createOutscraperTaskToken,
  getOutscraperSearchResults,
  normalizeOutscraperResults,
  startOutscraperSearch,
  verifyOutscraperTaskToken,
} from "@/lib/sources/outscraper";

afterEach(() => {
  vi.useRealTimers();
});

describe("Outscraper Google Maps normalization", () => {
  it("keeps businesses missing either a website or a menu and removes duplicate place IDs", () => {
    const providerResult = [
      [
        {
          name: "Padaria sem site",
          place_id: "place-no-site",
          city: "Mirassol",
          country_code: "BR",
          full_address: "Rua Central, Mirassol, SP",
          phone: "(17) 3333-1212",
          site: null,
          menu_link: null,
          category: "Padaria",
          latitude: -20.82,
          longitude: -49.52,
        },
        {
          name: "Restaurante sem menu",
          google_id: "0xabc:0xdef",
          city: "Mirassol",
          country_code: "BR",
          full_address: "Av. Brasil, Mirassol, SP",
          site: "https://example.com",
          menu_link: null,
          type: "Restaurante",
          latitude: "-20.81",
          longitude: "-49.51",
        },
      ],
      [
        {
          name: "Site e menu completos",
          place_id: "complete-place",
          city: "Mirassol",
          country_code: "BR",
          site: "https://example.com",
          menu_link: "https://example.com/menu",
        },
        {
          name: "Duplicate padaria",
          place_id: "place-no-site",
          city: "Mirassol",
          country_code: "BR",
          site: null,
          menu_link: null,
        },
        {
          name: "Outro município",
          place_id: "outside-city",
          city: "São Paulo",
          country_code: "BR",
          site: null,
          menu_link: null,
        },
        {
          name: "Outro país",
          place_id: "outside-country",
          city: "Mirassol",
          country_code: "US",
          site: null,
          menu_link: null,
        },
      ],
    ];

    const leads = normalizeOutscraperResults(providerResult, "Mirassol");
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({
      source: "outscraper_google_maps",
      source_id: "google:place-no-site",
      name: "Padaria sem site",
      city: "Mirassol",
      has_website: false,
      has_menu: false,
      phone: "(17) 3333-1212",
      lat: -20.82,
      lon: -49.52,
    });
    expect(leads[1]).toMatchObject({
      source_id: "google:0xabc:0xdef",
      name: "Restaurante sem menu",
      website: "https://example.com",
      has_website: true,
      has_menu: false,
      category: "Restaurante",
      lat: -20.81,
      lon: -49.51,
    });
  });

  it("supports flat response arrays and deterministic fallback IDs", () => {
    const first = normalizeOutscraperResults([
      { name: "Mercado do Bairro", city: "Cedral", country_code: "BR", full_address: "Rua A, Cedral", site: null },
    ], "Cedral");
    const second = normalizeOutscraperResults([
      { name: "Mercado do Bairro", city: "Cedral", country_code: "BR", full_address: "Rua A, Cedral", site: null },
    ], "Cedral");

    expect(first).toHaveLength(1);
    expect(first[0]?.source_id).toMatch(/^google:fallback:[a-f0-9]{32}$/);
    expect(first[0]?.source_id).toBe(second[0]?.source_id);
  });

  it("ignores unsupported city names rather than assigning them to the requested city", () => {
    const leads = normalizeOutscraperResults([
      { name: "Empresa externa", city: "Bebedouro", country_code: "BR", site: null },
    ], "Mirassol");
    expect(leads).toEqual([]);
  });
});

describe("Outscraper API workflow", () => {
  it("starts a bounded async Google Maps search without exposing the key in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "request_12345678",
      status: "Pending",
      results_location: "https://api.outscraper.cloud/requests/request_12345678",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await startOutscraperSearch("server-only-key", "Mirassol");
    expect(result).toEqual({ status: "processing", requestId: "request_12345678" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://api.outscraper.cloud/google-maps-search");
    expect(String(input)).not.toContain("server-only-key");
    expect(new Headers(init?.headers).get("X-API-KEY")).toBe("server-only-key");

    const body = JSON.parse(String(init?.body)) as {
      query: string[];
      limit: number;
      totalLimit: number;
      dropDuplicates: boolean;
      async: boolean;
      region: string;
    };
    expect(body.query.length).toBeGreaterThan(10);
    expect(body.query.every((query) => query.includes("Mirassol, São Paulo, Brasil"))).toBe(true);
    expect(body.limit).toBe(100);
    expect(body.totalLimit).toBe(300);
    expect(body.dropDuplicates).toBe(true);
    expect(body.async).toBe(true);
    expect(body.region).toBe("BR");
  });

  it("returns processing until the async results endpoint reports success", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "Pending" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOutscraperSearchResults("server-only-key", "request_12345678")).resolves.toEqual({
      status: "processing",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.outscraper.cloud/requests/request_12345678");
  });

  it("reads completed results from the provider response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: "Success",
      data: [[{ name: "Café Centro", city: "Mirassol", country_code: "BR", place_id: "place-123", site: null }]],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getOutscraperSearchResults("server-only-key", "request_12345678");
    expect(response.status).toBe("complete");
    if (response.status === "complete") {
      expect(normalizeOutscraperResults(response.data, "Mirassol")).toMatchObject([
        { name: "Café Centro", source_id: "google:place-123", has_website: false },
      ]);
    }
  });
});

describe("Outscraper asynchronous task token", () => {
  const secret = "test-outsraper-api-key";
  const userId = "user-a";

  it("signs the task with city and user ownership", async () => {
    const token = await createOutscraperTaskToken("request_12345678", userId, CITIES[1], secret);
    expect(await verifyOutscraperTaskToken(token, userId, secret)).toMatchObject({
      requestId: "request_12345678",
      userId,
      city: "Mirassol",
    });
    expect(await verifyOutscraperTaskToken(token, "another-user", secret)).toBeNull();
    expect(await verifyOutscraperTaskToken(token, userId, "wrong-secret")).toBeNull();
  });

  it("rejects tampered and expired task tokens", async () => {
    const token = await createOutscraperTaskToken("request_12345678", userId, CITIES[0], secret);
    expect(await verifyOutscraperTaskToken(token + "x", userId, secret)).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    const expiring = await createOutscraperTaskToken("request_abcdefgh", userId, CITIES[0], secret);
    vi.setSystemTime(new Date("2026-10-23T16:00:01.000Z"));
    expect(await verifyOutscraperTaskToken(expiring, userId, secret)).toBeNull();
  });
});
