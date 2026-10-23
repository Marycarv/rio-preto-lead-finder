import { describe, expect, it } from "vitest";
import {
  analyzeInputSchema,
  createWhatsAppUrl,
  importInputSchema,
  normalizeBrazilianPhone,
  readOpenAiJsonStream,
  validateLeadAnalysis,
} from "@/lib/lead-validation";

describe("lead input and AI output validation", () => {
  it("accepts an allowed city and rejects arbitrary city names", () => {
    expect(importInputSchema.safeParse({ city: "Mirassol" }).success).toBe(true);
    expect(importInputSchema.safeParse({ city: "São Paulo" }).success).toBe(false);
    expect(importInputSchema.safeParse({ city: "Mirassol", extra: true }).success).toBe(false);
  });

  it("requires a valid UUID before analyzing a lead", () => {
    expect(analyzeInputSchema.safeParse({ id: "d9428888-122b-11e1-b85c-61cd3cbb3210" }).success).toBe(true);
    expect(analyzeInputSchema.safeParse({ id: "123" }).success).toBe(false);
    expect(analyzeInputSchema.safeParse({ id: null }).success).toBe(false);
  });

  it("accepts only complete analysis data within score and length limits", () => {
    expect(validateLeadAnalysis({ score: 100, summary: "Bom potencial.", message: "Olá!" }).score).toBe(100);
    expect(() => validateLeadAnalysis({ score: 101, summary: "Resumo", message: "Olá" })).toThrow();
    expect(() => validateLeadAnalysis({ score: -1, summary: "Resumo", message: "Olá" })).toThrow();
    expect(() => validateLeadAnalysis({ score: 50, summary: "", message: "Olá" })).toThrow();
    expect(() => validateLeadAnalysis({ score: 50, summary: "Resumo", message: "x".repeat(1001) })).toThrow();
    expect(() => validateLeadAnalysis({ score: "50", summary: "Resumo", message: "Olá" })).toThrow();
  });
});

describe("Brazilian WhatsApp numbers", () => {
  it("normalizes complete Brazilian numbers without inventing a DDD", () => {
    expect(normalizeBrazilianPhone("(17) 99999-8888")).toBe("5517999998888");
    expect(normalizeBrazilianPhone("+55 17 3333-2222")).toBe("551733332222");
    expect(normalizeBrazilianPhone("99999-8888")).toBeNull();
    expect(normalizeBrazilianPhone("00 99999-8888")).toBeNull();
    expect(normalizeBrazilianPhone("1111111111")).toBeNull();
    expect(normalizeBrazilianPhone(null)).toBeNull();
  });

  it("encodes message text and refuses invalid phones or empty messages", () => {
    expect(createWhatsAppUrl("17 99999-8888", "Olá, tudo bem?")).toBe(
      "https://wa.me/5517999998888?text=Ol%C3%A1%2C%20tudo%20bem%3F",
    );
    expect(createWhatsAppUrl("9999-8888", "Olá")).toBeNull();
    expect(createWhatsAppUrl("17 99999-8888", "   ")).toBeNull();
    expect(createWhatsAppUrl("17 99999-8888", "x".repeat(1001))).toBeNull();
  });
});

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function sseDelta(content: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\r\n";
}

describe("OpenAI-compatible SSE response parser", () => {
  it("handles arbitrary chunk boundaries and the final buffer without a newline", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(sseDelta('{"score":')),
      encoder.encode(sseDelta('87,"summary":"Boa oportunidade",')),
      encoder.encode(sseDelta('"message":"Olá!"}') + "data: [DONE]"),
    ];
    await expect(readOpenAiJsonStream(streamFromChunks(chunks))).resolves.toEqual({
      score: 87,
      summary: "Boa oportunidade",
      message: "Olá!",
    });
  });

  it("rejects malformed final JSON instead of returning a partial analysis", async () => {
    const encoder = new TextEncoder();
    const body = streamFromChunks([
      encoder.encode(sseDelta('{"score":50,"summary":"incompleto"') + "data: [DONE]"),
    ]);
    await expect(readOpenAiJsonStream(body)).rejects.toThrow("JSON válido");
  });
});
