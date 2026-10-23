import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CITIES } from "./sources/cities";
import { generateLeadAnalysisWithGemini, searchGeminiProspects, type GeminiProspect } from "./sources/gemini";
import { analyzeInputSchema, geminiSearchInputSchema, validateLeadAnalysis } from "./lead-validation";

type ImportSummary = {
  status: "complete";
  found: number;
  inserted: number;
  withoutSite: number;
  withoutMenu: number;
  citations: number;
};

function getGeminiKey(): string {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) throw new Error("A chave GEMINI_API_KEY não está configurada nos Secrets do Lovable Cloud.");
  return key;
}

async function saveGeminiProspects(
  leads: GeminiProspect[],
  userId: string,
  supabase: SupabaseClient<Database>,
  citations: number,
): Promise<ImportSummary> {
  const now = new Date().toISOString();
  const rows = leads.map((lead) => ({ ...lead, user_id: userId, fetched_at: now }));
  let inserted = 0;

  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    const { data: result, error } = await supabase
      .from("leads")
      .upsert(chunk, { onConflict: "user_id,source,source_id", ignoreDuplicates: true })
      .select("id");

    if (error) {
      console.error("[leads.geminiSearch] Database write failed", { code: error.code ?? "unknown" });
      throw new Error("Não foi possível salvar os resultados da pesquisa Gemini. A busca pode ser repetida com segurança.");
    }
    inserted += result?.length ?? 0;
  }

  return {
    status: "complete",
    found: leads.length,
    inserted,
    withoutSite: leads.filter((lead) => !lead.has_website).length,
    withoutMenu: leads.filter((lead) => !lead.has_menu).length,
    citations,
  };
}

export const importLeads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const parsed = geminiSearchInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Revise a cidade e o tema da pesquisa.");
    return parsed.data;
  })
  .handler(async ({ data, context }) => {
    const search = await searchGeminiProspects(getGeminiKey(), data.city, data.query);
    if (search.leads.length === 0) {
      throw new Error("O Gemini não encontrou negócios com fontes verificáveis para esta pesquisa. Tente outra categoria ou cidade.");
    }
    return saveGeminiProspects(search.leads, context.userId, context.supabase, search.sourceCount);
  });

export const analyzeLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const parsed = analyzeInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Identificador de lead inválido.");
    return parsed.data;
  })
  .handler(async ({ data, context }) => {
    const { data: lead, error: readError } = await context.supabase
      .from("leads")
      .select("id,name,category,city,website,has_website,has_menu,source,fetched_at")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();

    if (readError || !lead) throw new Error("Lead não encontrado.");

    const key = process.env["GEMINI_API_KEY"];
    if (!key) throw new Error("A chave GEMINI_API_KEY não está configurada nos Secrets do Lovable Cloud.");

    // Only the business details needed to personalize the analysis are sent.
    const facts = {
      name: lead.name,
      category: lead.category,
      city: lead.city,
      website: lead.has_website ? lead.website : null,
      hasMenu: lead.has_menu,
    };

    const untrustedResult = await generateLeadAnalysisWithGemini(key, facts);
    const result = validateLeadAnalysis(untrustedResult);

    const { data: updatedLead, error: writeError } = await context.supabase
      .from("leads")
      .update({
        ai_score: result.score,
        ai_summary: result.summary,
        ai_message: result.message,
        approved: false,
        status: "analisado",
      })
      .eq("id", lead.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();

    if (writeError || !updatedLead) {
      console.error("[leads.analyze] Database write failed", { code: writeError?.code ?? "not_found" });
      throw new Error("A análise não foi salva. Nenhuma análise foi marcada como concluída; tente novamente.");
    }

    return result;
  });

export { CITIES };
