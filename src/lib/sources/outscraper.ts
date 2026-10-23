import { CITIES, type City } from "./cities";

export type ProspectLead = {
  source: string;
  source_id: string;
  name: string;
  category: string | null;
  city: string;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  has_website: boolean;
  has_menu: boolean;
  lat: number | null;
  lon: number | null;
};

type RecordValue = Record<string, unknown>;
type OutscraperPayload = RecordValue & {
  id?: unknown;
  status?: unknown;
  data?: unknown;
  results_location?: unknown;
};

export type OutscraperTaskStart =
  | { status: "processing"; requestId: string }
  | { status: "complete"; data: unknown };

export type OutscraperTaskResult =
  | { status: "processing" }
  | { status: "complete"; data: unknown };

export type OutscraperTaskClaim = {
  requestId: string;
  userId: string;
  city: City;
  createdAt: number;
};

const SEARCH_CATEGORIES = [
  "restaurantes",
  "lanchonetes",
  "cafeterias",
  "padarias",
  "pizzarias",
  "hamburguerias",
  "docerias e confeitarias",
  "sorveterias",
  "bares e choperias",
  "açougues",
  "salões de beleza",
  "clínicas odontológicas",
  "clínicas veterinárias",
  "pet shops",
  "academias",
  "oficinas mecânicas",
  "lojas de roupas",
  "lojas de móveis",
  "imobiliárias",
  "escritórios de contabilidade",
] as const;

const OUTSCRAPER_SEARCH_URL = "https://api.outscraper.cloud/google-maps-search";
const OUTSCRAPER_RESULTS_URL = "https://api.outscraper.cloud/requests/";
const MAX_PLACES_PER_SEARCH = 300;
// Allow room for provider processing and network transfer without tying up
// the app's request worker for minutes.
const REQUEST_TIMEOUT_MS = 15_000;
const RESULTS_TIMEOUT_MS = 12_000;
const TASK_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RESPONSE_FIELDS = [
  "query", "name", "place_id", "google_id", "cid", "full_address", "street",
  "city", "state", "country_code", "site", "phone", "type", "category",
  "subtypes", "latitude", "longitude", "menu_link", "location_link", "business_status",
].join(",");

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return result.length > 0 ? result : null;
}

function firstText(values: unknown[], maxLength = 500): string | null {
  for (const value of values) {
    const result = cleanText(value, maxLength);
    if (result) return result;
  }
  return null;
}

function normalizePlaceName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();
}

function matchSupportedCity(value: string | null): City | null {
  if (!value) return null;
  const normalized = normalizePlaceName(value);
  return CITIES.find((city) => {
    const target = normalizePlaceName(city);
    return normalized === target || normalized.startsWith(target + " -") || normalized.startsWith(target + ",");
  }) ?? null;
}

function parseNumber(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function collectPlaceRecords(value: unknown, out: RecordValue[] = []): RecordValue[] {
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceRecords(item, out);
    return out;
  }
  if (!isRecord(value)) return out;

  if (typeof value["name"] === "string") {
    out.push(value);
    return out;
  }

  // The provider can return a flat array (dropDuplicates=true) or one array
  // per query. Support both shapes rather than depending on one response form.
  if ("data" in value) collectPlaceRecords(value["data"], out);
  return out;
}

function stableFallbackId(name: string, city: string, address: string | null): string {
  const input = [normalizePlaceName(name), normalizePlaceName(city), normalizePlaceName(address ?? "")].join("|");
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ code, 3266489917) >>> 0;
  }
  const a = first.toString(16).padStart(8, "0");
  const b = second.toString(16).padStart(8, "0");
  return (a + b + a + b).slice(0, 32);
}

/**
 * Converts only businesses missing a website or a discoverable menu link.
 * IDs from Google Maps are used for repeatable, idempotent imports; the
 * normalized fallback keeps unnamed provider IDs from creating duplicates.
 */
export function normalizeOutscraperResults(value: unknown, requestedCity: City): ProspectLead[] {
  const rows = collectPlaceRecords(value);
  const unique = new Map<string, ProspectLead>();

  for (const row of rows) {
    const name = cleanText(row["name"], 180);
    if (!name) continue;

    const countryCode = cleanText(row["country_code"], 8);
    if (countryCode && countryCode.toUpperCase() !== "BR") continue;

    const sourceCity = cleanText(row["city"], 140);
    const resolvedCity = matchSupportedCity(sourceCity);
    // If a result explicitly belongs to a different municipality, ignore it
    // rather than mislabeling that business as being in the selected city.
    if (sourceCity && !resolvedCity) continue;
    if (resolvedCity && resolvedCity !== requestedCity) continue;

    const website = firstText([row["site"], row["website"]], 600);
    const menu = firstText([row["menu_link"], row["menu_url"]], 600);
    const hasWebsite = website !== null;
    const hasMenu = menu !== null;

    // This is a prospecting list, not a full Google Maps mirror. Keep places
    // missing at least one of the two digital assets the product sells.
    if (hasWebsite && hasMenu) continue;

    const address = firstText([row["full_address"], row["address"], row["street"]], 500);
    const city = resolvedCity ?? requestedCity;
    const providerId = firstText([row["google_id"], row["place_id"], row["cid"]], 180);
    const sourceId = providerId ? "google:" + providerId : "google:fallback:" + stableFallbackId(name, city, address);
    const category = firstText([row["category"], row["type"], row["subtypes"]], 180);

    const lead: ProspectLead = {
      source: "outscraper_google_maps",
      source_id: sourceId,
      name,
      category,
      city,
      address,
      phone: cleanText(row["phone"], 80),
      whatsapp: null,
      website,
      has_website: hasWebsite,
      has_menu: hasMenu,
      lat: parseNumber(row["latitude"], -90, 90),
      lon: parseNumber(row["longitude"], -180, 180),
    };
    unique.set(sourceId, lead);
  }

  return [...unique.values()];
}

export async function startOutscraperSearch(apiKey: string, city: City): Promise<OutscraperTaskStart> {
  const queries = SEARCH_CATEGORIES.map((category) => category + ", " + city + ", São Paulo, Brasil");

  let response: Response;
  try {
    response = await fetch(OUTSCRAPER_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        query: queries,
        limit: 100,
        totalLimit: MAX_PLACES_PER_SEARCH,
        dropDuplicates: true,
        region: "BR",
        async: true,
        fields: RESPONSE_FIELDS,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Não foi possível iniciar a busca no Google Maps via Outscraper. Verifique a conexão e tente novamente.");
  }

  if (response.status === 204) {
    throw new Error("O Outscraper terminou a solicitação sem resultados. Tente novamente com uma busca diferente.");
  }
  const payload = await readJsonResponse(response);
  if (!response.ok) throw providerHttpError(response.status);
  return parseTaskStart(payload);
}

export async function getOutscraperSearchResults(apiKey: string, requestId: string): Promise<OutscraperTaskResult> {
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Identificador de busca inválido.");

  let response: Response;
  try {
    response = await fetch(OUTSCRAPER_RESULTS_URL + encodeURIComponent(requestId), {
      headers: {
        Accept: "application/json",
        "X-API-KEY": apiKey,
      },
      signal: AbortSignal.timeout(RESULTS_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Não foi possível consultar o andamento da busca no Google Maps. Você pode tentar novamente sem reiniciar a pesquisa.");
  }

  if (response.status === 202) return { status: "processing" };
  if (response.status === 204) {
    throw new Error("A busca do Google Maps falhou no Outscraper e não retornou resultados. Confira os créditos e tente novamente.");
  }
  const payload = await readJsonResponse(response);
  if (isRecord(payload) && payload["status"] === "Failure") {
    throw new Error("A busca do Google Maps falhou no Outscraper. Confira os créditos e tente novamente.");
  }
  if (!response.ok) throw providerHttpError(response.status);
  if (!isRecord(payload)) throw new Error("O Outscraper retornou uma resposta inválida.");

  const status = typeof payload["status"] === "string" ? payload["status"].toLowerCase() : "";
  if (["pending", "running", "in_progress", "processing"].includes(status)) {
    return { status: "processing" };
  }
  if (status === "failure" || payload["error"] === true) {
    throw new Error("O Outscraper não concluiu a busca. Confira os créditos e a chave de API.");
  }
  if (!("data" in payload)) {
    throw new Error("O Outscraper concluiu a solicitação sem retornar uma lista de empresas.");
  }
  return { status: "complete", data: payload["data"] };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createOutscraperTaskToken(
  requestId: string,
  userId: string,
  city: City,
  secret: string,
): Promise<string> {
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("O Outscraper retornou um identificador de busca inválido.");
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    requestId,
    userId,
    city,
    createdAt: Date.now(),
  })));
  const key = await importHmacKey(secret);
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return payload + "." + encodeBase64Url(new Uint8Array(signature));
}

export async function verifyOutscraperTaskToken(
  token: string,
  userId: string,
  secret: string,
): Promise<OutscraperTaskClaim | null> {
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, suppliedSignature] = parts;
  if (!payload || !suppliedSignature) return null;

  try {
    const key = await importHmacKey(secret);
    const isValid = await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(suppliedSignature),
      new TextEncoder().encode(payload),
    );
    if (!isValid) return null;

    const raw: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    if (!isRecord(raw)) return null;
    if (raw["userId"] !== userId) return null;
    if (typeof raw["requestId"] !== "string" || !REQUEST_ID_PATTERN.test(raw["requestId"])) return null;
    if (typeof raw["createdAt"] !== "number" || !Number.isFinite(raw["createdAt"])) return null;
    if (Date.now() - raw["createdAt"] > TASK_TOKEN_TTL_MS || raw["createdAt"] > Date.now() + 60_000) return null;
    if (typeof raw["city"] !== "string") return null;
    const city = CITIES.find((candidate) => candidate === raw["city"]);
    if (!city) return null;

    return {
      requestId: raw["requestId"],
      userId,
      city,
      createdAt: raw["createdAt"],
    };
  } catch {
    return null;
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("O Outscraper retornou uma resposta que não é JSON válido.");
  }
}

function parseTaskStart(payload: unknown): OutscraperTaskStart {
  if (!isRecord(payload)) throw new Error("O Outscraper retornou uma resposta inválida.");
  if (payload["error"] === true) {
    throw new Error("O Outscraper não aceitou a busca. Confira a chave de API e os créditos da conta.");
  }

  const status = typeof payload["status"] === "string" ? payload["status"].toLowerCase() : "";
  if (status === "failure") throw new Error("O Outscraper não conseguiu iniciar a busca. Tente novamente.");
  if (status === "success" && "data" in payload) {
    return { status: "complete", data: payload["data"] };
  }

  const requestId = typeof payload["id"] === "string" ? payload["id"] : null;
  if (responseIsPending(status) && requestId && REQUEST_ID_PATTERN.test(requestId)) {
    return { status: "processing", requestId };
  }

  throw new Error("O Outscraper não retornou um identificador válido para acompanhar a busca.");
}

function responseIsPending(status: string): boolean {
  return ["pending", "running", "in_progress", "processing", ""].includes(status);
}

function providerHttpError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error("A chave OUTSCRAPER_API_KEY foi recusada. Confira a chave salva nos Secrets do Lovable Cloud.");
  }
  if (status === 402) {
    return new Error("A conta Outscraper está sem créditos ou precisa regularizar o faturamento. Confira a área de cobrança antes de tentar novamente.");
  }
  if (status === 429) {
    return new Error("O Outscraper limitou as solicitações. Aguarde um pouco antes de tentar novamente.");
  }
  if (status === 422) {
    return new Error("O Outscraper rejeitou os parâmetros de busca. Confira a configuração do provedor.");
  }
  if (status >= 500) {
    return new Error("O serviço Outscraper está temporariamente indisponível. Tente novamente mais tarde.");
  }
  return new Error("O Outscraper respondeu com o código HTTP " + String(status) + ".");
}
