import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateLeadAnalysisWithGemini,
  searchGeminiProspects,
} from "@/lib/sources/gemini";

afterEach(() => vi.unstubAllGlobals());

function responseWithGroundedBusinesses(
  businesses: unknown[],
  annotations: Array<{ type: string; name?: string; title?: string; url: string }>,
) {
  return new Response(JSON.stringify({
    id: "interaction_test",
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{
        type: "text",
        text: JSON.stringify({ businesses }),
        annotations,
      }],
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Gemini Google Search research", () => {
  it("uses one Gemini interaction with Google Search and imports only cited prospects", async () => {
    const sourceUrl = "https://search.example.com/padaria-sao-bento";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responseWithGroundedBusinesses([
        {
          name: "Padaria São Bento",
          category: "bakery",
          address: "Rua Central, 100",
          city: "Mirassol",
          phone: "(17) 3333-1111",
          website: null,
          menu_url: null,
          latitude: -20.82,
          longitude: -49.52,
          google_maps_url: null,
          source_url: sourceUrl,
          place_id: "place-123",
          reason: "No official website or menu URL was identified in the grounded sources.",
        },
        {
          name: "Business without citation",
          category: "shop",
          address: "Rua Unknown",
          city: "Mirassol",
          phone: null,
          website: null,
          menu_url: null,
          latitude: null,
          longitude: null,
          google_maps_url: null,
          source_url: "https://search.example.com/fake-business",
          place_id: "fake-place",
          reason: "No verified citation.",
        },
        {
          name: "Fully online business",
          category: "shop",
          address: "Rua A",
          city: "Mirassol",
          phone: null,
          website: "https://example.com",
          menu_url: "https://example.com/menu",
          latitude: null,
          longitude: null,
          google_maps_url: null,
          source_url: sourceUrl,
          place_id: "full-place",
          reason: null,
        },
      ], [
        { type: "url_citation", title: "Padaria São Bento - directory", url: sourceUrl },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchGeminiProspects(
      "secret-gemini-key",
      "Mirassol",
      "padarias sem site ou cardápio",
    );

    expect(result.found).toBe(1);
    expect(result.sourceCount).toBe(1);
    expect(result.leads[0]).toMatchObject({
      source: "gemini_google_research",
      name: "Padaria São Bento",
      city: "Mirassol",
      has_website: false,
      has_menu: false,
      lat: -20.82,
      lon: -49.52,
    });
    expect(result.leads[0]?.source_id).toMatch(/^gemini:web:/);
    expect(result.leads[0]?.notes).toContain("Google Search");
    expect(result.leads[0]?.notes).toContain(sourceUrl);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(String(url)).not.toContain("secret-gemini-key");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret-gemini-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("gemini-2.5-flash");
    expect(body["store"]).toBe(false);
    expect(body["tools"]).toEqual([{ type: "google_search" }]);
    expect(body["response_format"]).toBeUndefined();
  });

  it("rejects grounded candidates with a different city or no Google citation", async () => {
    const fetchMock = vi.fn(async () => responseWithGroundedBusinesses([
      { name: "Wrong city", city: "Bebedouro", google_maps_url: "https://maps.google.com/?cid=1", source_url: null },
      { name: "No citation", city: "Mirassol", google_maps_url: null, source_url: "https://fake.example.com" },
    ], []));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchGeminiProspects("secret-key", "Mirassol", "local businesses");
    expect(result.leads).toEqual([]);
  });

  it("uses the same Gemini model for structured message writing without search tools", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      status: "completed",
      steps: [{
        type: "model_output",
        content: [{
          type: "text",
          text: JSON.stringify({ score: 75, summary: "Good fit.", message: "Olá! Posso enviar uma demonstração gratuita?" }),
        }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const output = await generateLeadAnalysisWithGemini("server-key", {
      name: "Padaria São Bento",
      category: "bakery",
      city: "Mirassol",
      website: null,
      hasMenu: false,
    });
    expect(output).toEqual({
      score: 75,
      summary: "Good fit.",
      message: "Olá! Posso enviar uma demonstração gratuita?",
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("gemini-2.5-flash");
    expect(body["tools"]).toBeUndefined();
    expect(body["response_format"]).toMatchObject({ type: "text", mime_type: "application/json" });
  });

  it("explains when the Google Search daily quota is exhausted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Quota exceeded for requests per day.",
      },
    }), { status: 429, headers: { "content-type": "application/json" } })));
    await expect(searchGeminiProspects("server-key", "Mirassol", "cafes")).rejects.toThrow("cota diária de pesquisa");
  });

  it("returns an actionable quota message when a 429 response body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limit", { status: 429 })));
    await expect(searchGeminiProspects("server-key", "Mirassol", "cafes")).rejects.toThrow("cota ou limite de uso");
  });
});
