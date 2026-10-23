export const CITIES = [
  "São José do Rio Preto",
  "Mirassol",
  "Bady Bassitt",
  "Cedral",
  "Guapiaçu",
  "Ipiguá",
] as const;

export type City = (typeof CITIES)[number];
