// OpenStreetMap (Overpass) lead source. Server-only usage.
export type RawLead = {
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

export const CITIES = [
  "São José do Rio Preto",
  "Mirassol",
  "Bady Bassitt",
  "Cedral",
  "Guapiaçu",
  "Ipiguá",
] as const;

export type City = (typeof CITIES)[number];

type RecordValue = Record<string, unknown>;
type NominatimResult = {
  osm_type?: unknown;
  osm_id?: unknown;
  name?: unknown;
  display_name?: unknown;
  class?: unknown;
  type?: unknown;
  address?: Record<string, unknown>;
  extratags?: Record<string, unknown>;
};
type OsmElement = {
  type?: unknown;
  id?: unknown;
  tags?: unknown;
  lat?: unknown;
  lon?: unknown;
  center?: unknown;
};
type OverpassPayload = { elements: unknown[] };

const MAX_RESULTS_PER_GROUP = 2500;
const AREA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const OVERPASS_TIMEOUT_MS = 12_000;
const NOMINATIM_TIMEOUT_MS = 8_000;
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
] as const;

const CITY_AREA_CACHE = new Map<string, { areaId: number; expiresAt: number }>();
let lastNominatimRequestAt = 0;
let lastOverpassRequestAt = 0;
let nominatimQueue: Promise<void> = Promise.resolve();
let overpassQueue: Promise<void> = Promise.resolve();
let nextOverpassEndpoint = 0;

const QUERY_GROUPS = [
  { selector: '["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court|food_sharing)$"]' },
  { selector: '["shop"]' },
  { selector: '["craft"]' },
  { selector: '["office"]' },
] as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePlaceName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTag(value: unknown, maxLength = 240): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

function finiteCoordinate(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

// Serialize calls per runtime so concurrent authenticated requests do not burst
// public services beyond their conservative per-process spacing.
async function waitForNominatimSlot(): Promise<void> {
  const previous = nominatimQueue;
  let release!: () => void;
  nominatimQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await delay(1100 - (Date.now() - lastNominatimRequestAt));
    lastNominatimRequestAt = Date.now();
  } finally {
    release();
  }
}

async function waitForOverpassSlot(): Promise<void> {
  const previous = overpassQueue;
  let release!: () => void;
  overpassQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await delay(1000 - (Date.now() - lastOverpassRequestAt));
    lastOverpassRequestAt = Date.now();
  } finally {
    release();
  }
}

async function resolveCityArea(city: City): Promise<number> {
  const cacheKey = normalizePlaceName(city);
  const cached = CITY_AREA_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.areaId;

  await waitForNominatimSlot();

  const params = new URLSearchParams({
    q: city + ", São Paulo, Brasil",
    format: "jsonv2",
    addressdetails: "1",
    extratags: "1",
    countrycodes: "br",
    limit: "8",
  });

  let response: Response;
  try {
    response = await fetch("https://nominatim.openstreetmap.org/search?" + params.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "advexon-prospect/1.0 (OpenStreetMap public-data lookup)",
      },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Não foi possível verificar os limites da cidade no OpenStreetMap. Tente novamente mais tarde.");
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("O serviço público de geocodificação está limitando consultas. Aguarde e tente novamente.");
    }
    throw new Error("O serviço público de geocodificação está indisponível no momento.");
  }

  let rawResults: unknown;
  try {
    rawResults = await response.json();
  } catch {
    throw new Error("O serviço de geocodificação retornou uma resposta inválida.");
  }

  if (!Array.isArray(rawResults)) {
    throw new Error("Não foi possível validar os limites administrativos dessa cidade.");
  }

  const targetName = normalizePlaceName(city);
  let areaId: number | null = null;

  for (const entry of rawResults) {
    if (!isRecord(entry)) continue;
    const candidate = entry as NominatimResult;
    if (candidate.osm_type !== "relation" || candidate.class !== "boundary" || candidate.type !== "administrative") {
      continue;
    }
    if (typeof candidate.osm_id !== "number" && typeof candidate.osm_id !== "string") continue;
    const relationId = Number(candidate.osm_id);
    if (!Number.isSafeInteger(relationId) || relationId <= 0) continue;

    const address = candidate.address;
    if (!address) continue;
    const country = normalizePlaceName(typeof address.country === "string" ? address.country : "");
    const state = normalizePlaceName(typeof address.state === "string" ? address.state : "");
    const adminLevel = String(candidate.extratags?.admin_level ?? "");
    const names = [
      candidate.name,
      address.city,
      address.town,
      address.village,
      address.municipality,
      address.hamlet,
    ].filter((value): value is string => typeof value === "string");

    if (country !== "brasil" && country !== "brazil") continue;
    if (state !== "sao paulo") continue;
    if (adminLevel && adminLevel !== "7" && adminLevel !== "8") continue;
    if (!names.some((name) => normalizePlaceName(name) === targetName)) continue;

    // Overpass derives the area ID from a validated OSM administrative relation.
    areaId = 3_600_000_000 + relationId;
    break;
  }

  if (areaId === null) {
    throw new Error("Não foi possível validar os limites municipais de " + city + " no OpenStreetMap. Nenhuma coordenada foi presumida e nada foi importado.");
  }

  CITY_AREA_CACHE.set(cacheKey, { areaId, expiresAt: Date.now() + AREA_CACHE_TTL_MS });
  return areaId;
}

function isOverpassPayload(value: unknown): value is OverpassPayload {
  return isRecord(value) && Array.isArray(value.elements);
}

async function fetchOverpass(query: string): Promise<OverpassPayload> {
  let lastFailure: "network" | "rate" | "server" | "invalid" = "network";
  const attempts = Math.min(2, OVERPASS_ENDPOINTS.length);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const endpointIndex = (nextOverpassEndpoint + attempt) % OVERPASS_ENDPOINTS.length;
    const endpoint = OVERPASS_ENDPOINTS[endpointIndex];
    await waitForOverpassSlot();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "advexon-prospect/1.0 (OpenStreetMap public-data lookup)",
        },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });

      if (response.status === 429) {
        lastFailure = "rate";
        continue;
      }
      if ([500, 502, 503, 504].includes(response.status)) {
        lastFailure = "server";
        continue;
      }
      if (!response.ok) {
        throw new Error("O serviço Overpass recusou a consulta.");
      }
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
        lastFailure = "invalid";
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        lastFailure = "invalid";
        continue;
      }
      if (!isOverpassPayload(payload)) {
        lastFailure = "invalid";
        continue;
      }

      nextOverpassEndpoint = (endpointIndex + 1) % OVERPASS_ENDPOINTS.length;
      return payload;
    } catch (error) {
      if (error instanceof Error && error.message === "O serviço Overpass recusou a consulta.") throw error;
      lastFailure = "network";
    }
  }

  const messages = {
    network: "Os servidores públicos do OpenStreetMap não responderam dentro do prazo.",
    rate: "Os servidores públicos do OpenStreetMap estão limitando consultas.",
    server: "Os servidores públicos do OpenStreetMap estão temporariamente indisponíveis.",
    invalid: "Os servidores públicos do OpenStreetMap retornaram uma resposta inválida.",
  };
  throw new Error(messages[lastFailure] + " Tente novamente mais tarde.");
}

export function normalizeOsmElements(elements: unknown[], city: City): RawLead[] {
  const normalized = new Map<string, RawLead>();

  for (const entry of elements) {
    if (!isRecord(entry)) continue;
    const element = entry as OsmElement;
    if (element.type !== "node" && element.type !== "way" && element.type !== "relation") continue;
    if (typeof element.id !== "number" || !Number.isSafeInteger(element.id) || element.id <= 0) continue;
    if (!isRecord(element.tags)) continue;

    const tags = element.tags;
    const name = cleanTag(tags.name, 180);
    if (!name) continue;

    const sourceId = String(element.type) + "/" + String(element.id);
    const website = cleanTag(tags.website ?? tags["contact:website"] ?? tags.url, 500);
    const menu = cleanTag(tags["website:menu"] ?? tags.menu_url, 500);
    const street = cleanTag(tags["addr:street"], 120);
    const houseNumber = cleanTag(tags["addr:housenumber"], 40);
    const suburb = cleanTag(tags["addr:suburb"], 100);
    const address = [street, houseNumber, suburb].filter((value): value is string => value !== null).join(", ");
    const center = isRecord(element.center) ? element.center : {};
    const lat = finiteCoordinate(element.lat, -90, 90) ?? finiteCoordinate(center.lat, -90, 90);
    const lon = finiteCoordinate(element.lon, -180, 180) ?? finiteCoordinate(center.lon, -180, 180);
    const category =
      cleanTag(tags.amenity, 100) ??
      cleanTag(tags.shop, 100) ??
      cleanTag(tags.craft, 100) ??
      cleanTag(tags.office, 100);

    normalized.set(sourceId, {
      source: "openstreetmap",
      source_id: sourceId,
      name,
      category,
      city,
      address: address || null,
      phone: cleanTag(tags.phone ?? tags["contact:phone"], 80),
      whatsapp: cleanTag(tags["contact:whatsapp"], 80),
      website,
      has_website: website !== null,
      has_menu: menu !== null,
      lat,
      lon,
    });
  }

  return [...normalized.values()];
}

export async function fetchOsmLeads(inputCity: string): Promise<RawLead[]> {
  const city = CITIES.find((candidate) => normalizePlaceName(candidate) === normalizePlaceName(inputCity));
  if (!city) throw new Error("Cidade inválida.");

  const areaId = await resolveCityArea(city);
  const allElements: unknown[] = [];

  for (const group of QUERY_GROUPS) {
    const query =
      "[out:json][timeout:20][maxsize:67108864];\n" +
      "area(" + String(areaId) + ")->.city;\n" +
      "(nwr(area.city)[\"name\"]" + group.selector + ";);\n" +
      "out center tags " + String(MAX_RESULTS_PER_GROUP) + ";";

    const payload = await fetchOverpass(query);
    if (payload.elements.length >= MAX_RESULTS_PER_GROUP) {
      throw new Error(
        "A busca atingiu o limite de " + String(MAX_RESULTS_PER_GROUP) +
        " resultados em uma categoria. Nenhum resultado parcial foi salvo; tente novamente mais tarde.",
      );
    }
    allElements.push(...payload.elements);
  }

  return normalizeOsmElements(allElements, city);
}
