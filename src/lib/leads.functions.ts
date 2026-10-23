import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CITIES, fetchOsmLeads } from "./sources/osm";
import {
  analyzeInputSchema,
  importInputSchema,
  readOpenAiJsonStream,
  validateLeadAnalysis,
} from "./lead-validation";

export const importLeads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const parsed = importInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Cidade inválida.");
    return parsed.data;
  })
  .handler(async ({ data, context }) => {
    const raw = await fetchOsmLeads(data.city);
    const now = new Date().toISOString();
    const rows = raw.map((lead) => ({ ...lead, user_id: context.userId, fetched_at: now }));
    let inserted = 0;

    for (let index = 0; index < rows.length; index += 200) {
      const chunk = rows.slice(index, index + 200);
      const { data: result, error } = await context.supabase
        .from("leads")
        .upsert(chunk, { onConflict: "user_id,source,source_id", ignoreDuplicates: true })
        .select("id");

      if (error) {
        console.error("[leads.import] Database write failed", { code: error.code ?? "unknown" });
        throw new Error("Não foi possível salvar os leads desta busca. Tente novamente; a importação pode ser repetida com segurança.");
      }
      inserted += result?.length ?? 0;
    }

    return {
      found: raw.length,
      inserted,
      withoutSite: raw.filter((lead) => !lead.has_website).length,
    };
  });

const AI_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "summary", "message"],
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100, description: "Potencial de conversão de 0 a 100" },
    summary: { type: "string", minLength: 1, maxLength: 400 },
    message: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const;

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

    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("A análise por IA não está configurada.");

    // Only the business details needed to personalize the analysis are sent.
    const facts = {
      nome: lead.name,
      categoria: lead.category,
      cidade: lead.city,
      site_identificado: lead.has_website ? lead.website : "nenhum site identificado na fonte",
      cardapio_online: lead.has_menu ? "identificado na fonte" : "não identificado na fonte",
    };

    let response: Response;
    try {
      response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "X-Lovable-AIG-SDK": "fetch",
        },
        body: JSON.stringify({
          model: "google/gemini-3.8-flash",
          stream: true,
          response_format: {
            type: "json_schema",
            json_schema: { name: "lead", strict: true, schema: AI_RESPONSE_SCHEMA },
          },
          messages: [
            {
              role: "system",
              content:
                "Você é um consultor comercial da ADVEXON, que cria sites e cardápios digitais para negócios locais. Use SOMENTE os fatos fornecidos; nunca invente dados, números, avaliações ou nomes de pessoas. Gere score (0-100) de potencial, summary (1-2 frases explicando a classificação) e message: mensagem curta de WhatsApp em português do Brasil, cordial e sem exageros, oferecendo uma demonstração gratuita e sem compromisso de um site/cardápio digital. Explique de forma realista que a solução pode ajudar a apresentar o negócio e seus produtos, sem prometer aumento garantido de clientes ou vendas. Termine perguntando se pode enviar a demonstração.",
            },
            { role: "user", content: JSON.stringify(facts) },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new Error("Não foi possível conectar ao serviço de IA. Tente novamente mais tarde.");
    }

    if (!response.ok) {
      if (response.status === 429) throw new Error("Muitas solicitações à IA. Aguarde um pouco.");
      if (response.status === 402) throw new Error("Os créditos de IA estão esgotados no workspace.");
      if (response.status === 401 || response.status === 403) {
        throw new Error("O serviço de IA recusou a solicitação. Verifique a configuração no servidor.");
      }
      throw new Error("O serviço de IA está indisponível ou retornou um erro. Tente novamente mais tarde.");
    }
    if (!response.body) throw new Error("O serviço de IA retornou uma resposta vazia.");

    const untrustedResult = await readOpenAiJsonStream(response.body);
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
