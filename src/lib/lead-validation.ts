import { z } from "zod";
import { CITIES } from "@/lib/sources/cities";

export const importInputSchema = z.object({
  city: z.enum(CITIES),
}).strict();

export const analyzeInputSchema = z.object({
  id: z.string().uuid(),
}).strict();

export const importStatusInputSchema = z.object({
  taskToken: z.string().min(20).max(2048),
}).strict();

export const leadAnalysisSchema = z.object({
  score: z.number().int().min(0).max(100),
  summary: z.string().trim().min(1).max(400),
  message: z.string().trim().min(1).max(1000),
}).strict();

export type LeadAnalysis = z.infer<typeof leadAnalysisSchema>;

export function validateLeadAnalysis(value: unknown): LeadAnalysis {
  const result = leadAnalysisSchema.safeParse(value);
  if (!result.success) {
    throw new Error("A IA retornou uma análise incompleta ou fora dos limites permitidos.");
  }
  return result.data;
}

const VALID_BRAZILIAN_DDDS = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "93", "94", "95", "96", "97", "98", "99",
]);

/**
 * Returns a wa.me-compatible international digit string only when the source
 * includes a plausible Brazilian area code and full local number.
 */
export function normalizeBrazilianPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10 && digits.length !== 11) return null;
  if (!VALID_BRAZILIAN_DDDS.has(digits.slice(0, 2))) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  return "55" + digits;
}

export function createWhatsAppUrl(phone: string | null | undefined, message: string): string | null {
  const normalizedPhone = normalizeBrazilianPhone(phone);
  const normalizedMessage = message.trim();
  if (!normalizedPhone || !normalizedMessage || normalizedMessage.length > 1000) return null;
  return `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(normalizedMessage)}`;
}

/** Reads OpenAI-compatible SSE deltas and parses the accumulated JSON response. */
export async function readOpenAiJsonStream(
  body: ReadableStream<Uint8Array>,
): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let doneSentinel = false;

  function consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      doneSentinel = true;
      return;
    }
    if (doneSentinel) return;

    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new Error("A IA retornou um bloco de streaming inválido.");
    }
    if (typeof chunk !== "object" || chunk === null) {
      throw new Error("A IA retornou um bloco de streaming inválido.");
    }

    const choices = (chunk as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const first = choices[0];
    if (typeof first !== "object" || first === null) return;
    const delta = (first as { delta?: unknown }).delta;
    if (typeof delta !== "object" || delta === null) return;
    const deltaContent = (delta as { content?: unknown }).content;
    if (deltaContent === undefined || deltaContent === null) return;
    if (typeof deltaContent !== "string") {
      throw new Error("A IA retornou conteúdo em formato inesperado.");
    }
    content += deltaContent;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
  } catch {
    throw new Error("Não foi possível ler a resposta de análise da IA.");
  } finally {
    reader.releaseLock();
  }

  if (!content.trim()) {
    throw new Error("A IA não retornou uma análise completa.");
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error("A IA não retornou um JSON válido.");
  }
}
