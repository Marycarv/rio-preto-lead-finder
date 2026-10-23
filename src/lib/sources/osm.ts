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

// Region bbox (south,west,north,east) to disambiguate homonym cities.
const BBOX = "-21.05,-49.65,-20.55,-49.05";

export async function fetchOsmLeads(city: string): Promise<RawLead[]> {
  const q = `[out:json][timeout:50];
area["name"="${city}"]["boundary"="administrative"]["admin_level"="8"]->.c;
(
  nwr(area.c)["name"]["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court)$"](${BBOX});
  nwr(area.c)["name"]["shop"](${BBOX});
  nwr(area.c)["name"]["craft"](${BBOX});
  nwr(area.c)["name"]["office"](${BBOX});
);
out center tags 600;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "advexon-prospect/1.0" },
    body: "data=" + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`OpenStreetMap indisponível (${res.status}). Tente novamente em alguns minutos.`);
  const json = (await res.json()) as { elements: Array<any> };
  return json.elements
    .filter((e) => e.tags?.name)
    .map((e) => {
      const t = e.tags as Record<string, string>;
      const website = t.website || t["contact:website"] || t.url || null;
      const menu = t["website:menu"] || t.menu_url || null;
      const addr = [t["addr:street"], t["addr:housenumber"], t["addr:suburb"]].filter(Boolean).join(", ");
      return {
        source: "openstreetmap",
        source_id: `${e.type}/${e.id}`,
        name: t.name,
        category: t.amenity || t.shop || t.craft || t.office || null,
        city,
        address: addr || null,
        phone: t.phone || t["contact:phone"] || null,
        whatsapp: t["contact:whatsapp"] || null,
        website,
        has_website: !!website,
        has_menu: !!menu,
        lat: e.lat ?? e.center?.lat ?? null,
        lon: e.lon ?? e.center?.lon ?? null,
      };
    });
}
