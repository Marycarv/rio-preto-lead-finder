import { createHash } from "node:crypto";
import { CITIES, type City } from "./cities";

export type GeminiProspect = {
  source: string; source_id: string; name: string; category: string | null; city: string;
  address: string | null; phone: string | null; whatsapp: string | null; website: string | null;
  has_website: boolean; has_menu: boolean; lat: number | null; lon: number | null; notes: string | null;
};
export type GroundingSource = { type: "place_citation" | "url_citation"; name: string; url: string };
type JsonRecord = Record<string, unknown>;
type RawCandidate = {
  name?: unknown; category?: unknown; address?: unknown; city?: unknown; phone?: unknown;
  website?: unknown; menu_url?: unknown; latitude?: unknown; longitude?: unknown;
  google_maps_url?: unknown; source_url?: unknown; place_id?: unknown; reason?: unknown;
};

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.8-flash";
const MAX_PROSPECTS = 10;
const GEMINI_TIMEOUT_MS = 90_000;

const PROSPECT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["businesses"],
  properties: {
    businesses: {
      type: "array", maxItems: MAX_PROSPECTS,
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "category", "address", "city", "phone", "website", "menu_url", "latitude", "longitude", "google_maps_url", "source_url", "place_id", "reason"],
        properties: {
          name: { type: "string" }, category: { type: ["string", "null"] },
          address: { type: ["string", "null"] }, city: { type: ["string", "null"] },
          phone: { type: ["string", "null"] }, website: { type: ["string", "null"] },
          menu_url: { type: ["string", "null"] }, latitude: { type: ["number", "null"] },
          longitude: { type: ["number", "null"] }, google_maps_url: { type: ["string", "null"] },
          source_url: { type: ["string", "null"] }, place_id: { type: ["string", "null"] },
          reason: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const MESSAGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["score", "summary", "message"],
  properties: { score: { type: "integer", minimum: 0, maximum: 100 }, summary: { type: "string" }, message: { type: "string" } },
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cleanText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return result.length ? result : null;
}
function normalizeName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function validHttpUrl(value: unknown): string | null {
  const raw = cleanText(value, 800);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}
function parseCoordinate(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}
function stableId(parts: string[]): string {
  return createHash("sha256").update(parts.map(normalizeName).join("|")).digest("hex").slice(0, 40);
}

function readInteractionText(payload: JsonRecord): { text: string; sources: GroundingSource[] } {
  if (payload["status"] !== "completed") {
    if (payload["status"] === "incomplete") throw new Error("O Gemini encerrou a pesquisa antes de concluir. Tente uma categoria mais específica.");
    if (payload["status"] === "failed") throw new Error("A pesquisa do Gemini falhou. Confira a chave e os limites da API.");
    throw new Error("O Gemini não concluiu a pesquisa. Tente novamente.");
  }
  const steps = Array.isArray(payload["steps"]) ? payload["steps"] : [];
  const outputs: string[] = [];
  const sources = new Map<string, GroundingSource>();
  for (const step of steps) {
    if (!isRecord(step) || step["type"] !== "model_output" || !Array.isArray(step["content"])) continue;
    for (const block of step["content"]) {
      if (!isRecord(block) || block["type"] !== "text") continue;
      if (typeof block["text"] === "string") outputs.push(block["text"]);
      const annotations = Array.isArray(block["annotations"]) ? block["annotations"] : [];
      for (const annotation of annotations) {
        if (!isRecord(annotation)) continue;
        const type = annotation["type"];
        if (type !== "place_citation" && type !== "url_citation") continue;
        const url = validHttpUrl(annotation["url"]);
        if (!url) continue;
        const name = cleanText(annotation["name"] ?? annotation["title"], 180) ?? url;
        sources.set(type + "|" + url, { type, name, url });
      }
    }
  }
  const text = outputs.reverse().find((value) => value.trim().length > 0) ?? "";
  if (!text) throw new Error("O Gemini não retornou uma lista de negócios.");
  return { text, sources: [...sources.values()] };
}
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed) as unknown; } catch { /* Try an unwrapped JSON object below. */ }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as unknown; } catch { /* Report a safe error below. */ }
  }
  throw new Error("O Gemini retornou uma resposta que não é JSON válido. Tente novamente.");
}

async function runGeminiInteraction(
  apiKey: string, input: string, schema: object, useGoogleTools: boolean,
): Promise<{ value: unknown; sources: GroundingSource[] }> {
  const body: JsonRecord = { model: GEMINI_MODEL, input, store: false };
  if (useGoogleTools) {
    // Use JSON-only prompting for the grounded response; keep structured output
    // enforcement for the normal text-only message-writing call. This avoids
    // relying on an unconfirmed combination of Maps grounding + response schema.
    body["tools"] = [{ type: "google_search" }, { type: "google_maps" }];
  } else {
    body["response_format"] = { type: "text", mime_type: "application/json", schema };
  }

  let response: Response;
  try {
    response = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Não foi possível conectar ao Gemini. Verifique a conexão e tente novamente.");
  }
  if (response.status === 401 || response.status === 403) throw new Error("A chave GEMINI_API_KEY foi recusada. Confira o segredo no Lovable Cloud.");
  if (response.status === 429) throw new Error("O Gemini atingiu o limite de solicitações ou de pesquisa. Aguarde e confira o uso da API.");
  if (response.status === 402) throw new Error("A API do Gemini não aceitou a solicitação por cobrança. Confira o faturamento do Google AI.");
  if (!response.ok) throw new Error("O Gemini respondeu com erro HTTP " + String(response.status) + ". Confira a configuração da API e tente novamente.");
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("O Gemini retornou uma resposta inválida."); }
  if (!isRecord(payload)) throw new Error("O Gemini retornou uma resposta inválida.");
  const result = readInteractionText(payload);
  return { value: extractJson(result.text), sources: result.sources };
}

export type GeminiSearchResult = { leads: GeminiProspect[]; sourceCount: number; found: number };

export async function searchGeminiProspects(apiKey: string, requestedCity: City, focus: string): Promise<GeminiSearchResult> {
  const prompt = [
    "Act as one careful local-business research agent. Use Google Search and Google Maps tools to find real businesses in:",
    requestedCity + ", Sao Paulo, Brazil.",
    "Research focus provided by the user: " + focus + ". Translate this focus into English if needed before searching.",
    "Find up to " + String(MAX_PROSPECTS) + " distinct small businesses that are plausible prospects for a professional website or digital menu.",
    "Keep a business only if available Google-grounded evidence indicates it lacks an official website OR lacks a publicly identified digital menu URL.",
    "Use English for search instructions and output because Google Maps grounding currently supports English. Preserve exact business names, addresses, and phone numbers as listed.",
    "Do not invent businesses, addresses, phone numbers, websites, menu links, coordinates, Place IDs, or source URLs. Use null for unknown fields.",
    "For google_maps_url, use the exact place-citation URL from Google Maps grounding. For source_url, use an exact URL citation from Google Search. Exclude a business if you cannot provide a verifiable source URL.",
    "The requested city must be the actual city. Do not mislabel neighboring towns as " + requestedCity + ". Return only a JSON object with a top-level businesses array and no markdown.",
    "Match this exact JSON schema: " + JSON.stringify(PROSPECT_SCHEMA),
  ].join("\n");

  const interaction = await runGeminiInteraction(apiKey, prompt, PROSPECT_SCHEMA, true);
  if (!isRecord(interaction.value) || !Array.isArray(interaction.value["businesses"])) {
    throw new Error("O Gemini não retornou a estrutura esperada para os negócios.");
  }
  const mapsSources = interaction.sources.filter((source) => source.type === "place_citation");
  const allSourceUrls = new Set(interaction.sources.map((source) => source.url));
  const rawCandidates = interaction.value["businesses"] as RawCandidate[];
  const deduped = new Map<string, GeminiProspect>();

  for (const candidate of rawCandidates.slice(0, MAX_PROSPECTS)) {
    if (!isRecord(candidate)) continue;
    const name = cleanText(candidate.name, 180);
    if (!name) continue;
    const candidateMapsUrl = validHttpUrl(candidate.google_maps_url);
    const normalizedLeadName = normalizeName(name);
    const citedMapsUrl = candidateMapsUrl && mapsSources.some((source) => source.url === candidateMapsUrl)
      ? candidateMapsUrl
      : mapsSources.find((source) => {
          const normalizedSourceName = normalizeName(source.name);
          return normalizedSourceName === normalizedLeadName ||
            normalizedSourceName.startsWith(normalizedLeadName + " ") ||
            normalizedLeadName.startsWith(normalizedSourceName + " ");
        })?.url ?? null;
    const candidateSourceUrl = validHttpUrl(candidate.source_url);
    const citedWebUrl = candidateSourceUrl && allSourceUrls.has(candidateSourceUrl) ? candidateSourceUrl : null;
    const verifiedSourceUrl = citedMapsUrl ?? citedWebUrl;
    if (!verifiedSourceUrl) continue;

    const website = validHttpUrl(candidate.website);
    const menuUrl = validHttpUrl(candidate.menu_url);
    const cityFromModel = cleanText(candidate.city, 120);
    const normalizedReturnedCity = cityFromModel ? normalizeName(cityFromModel) : "";
    const normalizedRequestedCity = normalizeName(requestedCity);
    if (!normalizedReturnedCity ||
      (normalizedReturnedCity !== normalizedRequestedCity &&
        !normalizedReturnedCity.startsWith(normalizedRequestedCity + " "))) continue;
    if (website && menuUrl) continue;

    const address = cleanText(candidate.address, 400);
    const sourceId = citedMapsUrl
      ? "gemini:maps:" + stableId([citedMapsUrl])
      : "gemini:web:" + stableId([name, requestedCity, address ?? "", verifiedSourceUrl]);
    const citedWeb = citedWebUrl ?? (verifiedSourceUrl !== citedMapsUrl ? verifiedSourceUrl : null);
    const notes = JSON.stringify({
      sourceLabel: citedMapsUrl ? "Google Maps" : "Google Search",
      googleMapsUrl: citedMapsUrl, webSourceUrl: citedWeb, menuUrl,
      evidence: cleanText(candidate.reason, 600),
    });
    const prospect: GeminiProspect = {
      source: "gemini_google_research", source_id: sourceId, name,
      category: cleanText(candidate.category, 150), city: requestedCity, address,
      phone: cleanText(candidate.phone, 80), whatsapp: null, website,
      has_website: website !== null, has_menu: menuUrl !== null,
      lat: parseCoordinate(candidate.latitude, -90, 90), lon: parseCoordinate(candidate.longitude, -180, 180),
      notes,
    };
    if (!deduped.has(sourceId)) deduped.set(sourceId, prospect);
  }
  return { leads: [...deduped.values()], sourceCount: interaction.sources.length, found: deduped.size };
}

export async function generateLeadAnalysisWithGemini(
  apiKey: string,
  facts: { name: string; category: string | null; city: string | null; website: string | null; hasMenu: boolean },
): Promise<unknown> {
  const prompt = [
    "You are ADVEXON's ethical sales copywriter. Return a Brazilian Portuguese WhatsApp message offering a free, no-obligation demo of a professional website or digital menu.",
    "Use only these facts; never invent details, performance figures, reviews, or people. Do not claim guaranteed sales growth. Explain the offer politely and end by asking permission to send a demo.",
    "Return JSON with score (integer 0-100), summary (up to two short sentences, maximum 400 characters), and message (maximum 1000 characters).",
    "Business facts: " + JSON.stringify(facts),
  ].join("\n");
  const interaction = await runGeminiInteraction(apiKey, prompt, MESSAGE_SCHEMA, false);
  return interaction.value;
}
