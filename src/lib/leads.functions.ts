import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CITIES, fetchOsmLeads } from "./sources/osm";

export const importLeads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { city: string }) => {
    if (!CITIES.includes(input.city as (typeof CITIES)[number])) throw new Error("Cidade inválida");
    return input;
  })
  .handler(async ({ data, context }) => {
    const raw = await fetchOsmLeads(data.city);
    const now = new Date().toISOString();
    const rows = raw.map((r) => ({ ...r, user_id: context.userId, fetched_at: now }));
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { data: res, error } = await context.supabase
        .from("leads")
        .upsert(chunk, { onConflict: "user_id,source,source_id", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(error.message);
      inserted += res?.length ?? 0;
    }
    return { found: raw.length, inserted, withoutSite: raw.filter((r) => !r.has_website).length };
  });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "summary", "message"],
  properties: {
    score: { type: "integer", description: "0-100 potencial de conversão" },
    summary: { type: "string" },
    message: { type: "string" },
  },
};

export const analyzeLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: lead, error } = await context.supabase.from("leads").select("*").eq("id", data.id).single();
    if (error || !lead) throw new Error("Lead não encontrado");
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("IA não configurada");

    const facts = {
      nome: lead.name,
      categoria: lead.category,
      cidade: lead.city,
      endereco: lead.address,
      telefone: lead.phone,
      site_identificado: lead.has_website ? lead.website : "nenhum identificado na fonte",
      cardapio_online: lead.has_menu ? "sim" : "não identificado",
      fonte: `${lead.source} (consultado em ${new Date(lead.fetched_at).toLocaleDateString("pt-BR")})`,
    };

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model: "google/gemini-3.8-flash",
        stream: true,
        response_format: { type: "json_schema", json_schema: { name: "lead", strict: true, schema: SCHEMA } },
        messages: [
          {
            role: "system",
            content:
              "Você é um consultor comercial da ADVEXON, que cria sites e cardápios digitais para negócios locais. Use SOMENTE os fatos fornecidos; nunca invente dados, números, avaliações ou nomes de pessoas. Gere: score (0-100) de potencial, summary (1-2 frases explicando a classificação) e message: mensagem curta de WhatsApp em português do Brasil, cordial e sem exageros, oferecendo uma demonstração gratuita e sem compromisso de um site/cardápio digital, explicando de forma realista que pode ajudar a atrair mais clientes e vendas. Não prometa resultados garantidos. Termine perguntando se pode enviar a demonstração.",
          },
          { role: "user", content: JSON.stringify(facts) },
        ],
      }),
    });
    if (!res.ok || !res.body) {
      const t = await res.text();
      if (res.status === 429) throw new Error("Muitas solicitações à IA. Aguarde um pouco.");
      if (res.status === 402) throw new Error("Créditos de IA esgotados no workspace.");
      throw new Error(`Erro da IA (${res.status}): ${t.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        const s = l.trim();
        if (!s.startsWith("data:")) continue;
        const p = s.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          out += JSON.parse(p).choices?.[0]?.delta?.content ?? "";
        } catch {}
      }
    }
    let parsed: { score: number; summary: string; message: string };
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error("A IA não retornou uma resposta válida.");
    }
    const { error: upErr } = await context.supabase
      .from("leads")
      .update({ ai_score: parsed.score, ai_summary: parsed.summary, ai_message: parsed.message, status: "analisado" })
      .eq("id", lead.id);
    if (upErr) throw new Error(upErr.message);
    return parsed;
  });
