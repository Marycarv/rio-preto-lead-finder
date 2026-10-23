import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { importLeads, analyzeLead } from "@/lib/leads.functions";
import { CITIES } from "@/lib/sources/osm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { createWhatsAppUrl } from "@/lib/lead-validation";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Painel de leads — ADVEXON Prospect" },
      { name: "description", content: "Gerencie leads locais, análises de IA e aprovações de contato." },
      { property: "og:title", content: "Painel de leads — ADVEXON Prospect" },
      { property: "og:description", content: "Gerencie leads locais, análises de IA e aprovações de contato." },
    ],
  }),
  component: Dashboard,
});

type Lead = {
  id: string; name: string; category: string | null; city: string | null; address: string | null;
  phone: string | null; whatsapp: string | null; website: string | null; has_website: boolean; has_menu: boolean;
  source: string; fetched_at: string; ai_score: number | null; ai_summary: string | null; ai_message: string | null;
  status: string; approved: boolean;
};

function Dashboard() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const runImport = useServerFn(importLeads);
  const runAnalyze = useServerFn(analyzeLead);
  const [city, setCity] = useState<string>(CITIES[0]);
  const [importing, setImporting] = useState(false);
  const [onlyNoSite, setOnlyNoSite] = useState(true);
  const [onlyPhone, setOnlyPhone] = useState(false);
  const [filterCity, setFilterCity] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Lead | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const leadsQuery = useQuery({
    queryKey: ["leads", page, pageSize, onlyNoSite, onlyPhone, filterCity, filterStatus, q],
    queryFn: async () => {
      let query = supabase
        .from("leads")
        .select("id,name,category,city,address,phone,whatsapp,website,has_website,has_menu,source,fetched_at,ai_score,ai_summary,ai_message,status,approved", { count: "exact" })
        .order("created_at", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      if (onlyNoSite) query = query.eq("has_website", false);
      if (filterCity) query = query.eq("city", filterCity);
      if (filterStatus) query = query.eq("status", filterStatus);

      // Strip PostgREST filter syntax before embedding user-provided search text.
      const safeQuery = q.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      if (onlyPhone && safeQuery) {
        query = query.or(
          `and(phone.not.is.null,name.ilike.%${safeQuery}%),and(phone.not.is.null,category.ilike.%${safeQuery}%),and(whatsapp.not.is.null,name.ilike.%${safeQuery}%),and(whatsapp.not.is.null,category.ilike.%${safeQuery}%)`,
        );
      } else if (onlyPhone) {
        query = query.or("phone.not.is.null,whatsapp.not.is.null");
      } else if (safeQuery) {
        query = query.or(`name.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%`);
      }

      const { data, count, error } = await query;
      if (error) throw error;
      return { rows: (data ?? []) as Lead[], count: count ?? 0 };
    },
  });

  const statsQuery = useQuery({
    queryKey: ["lead-stats"],
    queryFn: async () => {
      const [all, noSite, analyzed, approved] = await Promise.all([
        supabase.from("leads").select("id", { count: "exact", head: true }),
        supabase.from("leads").select("id", { count: "exact", head: true }).eq("has_website", false),
        supabase.from("leads").select("id", { count: "exact", head: true }).not("ai_message", "is", null),
        supabase.from("leads").select("id", { count: "exact", head: true }).eq("approved", true),
      ]);
      if (all.error || noSite.error || analyzed.error || approved.error) {
        throw new Error("Não foi possível consultar as contagens do painel.");
      }
      return {
        total: all.count ?? 0,
        noSite: noSite.count ?? 0,
        analyzed: analyzed.count ?? 0,
        approved: approved.count ?? 0,
      };
    },
  });

  const leads = leadsQuery.data?.rows ?? [];
  const filteredCount = leadsQuery.data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));
  const stats = statsQuery.data;

  async function doImport() {
    setImporting(true);
    try {
      const r = await runImport({ data: { city } });
      toast.success(`${r.found} encontrados em ${city} (${r.withoutSite} sem site). ${r.inserted} novos salvos.`);
      await qc.invalidateQueries({ queryKey: ["leads"] });
      await qc.invalidateQueries({ queryKey: ["lead-stats"] });
    } catch (e) { toast.error((e as Error).message); }
    finally { setImporting(false); }
  }

  async function doAnalyze(l: Lead) {
    setBusyId(l.id);
    try {
      const r = await runAnalyze({ data: { id: l.id } });
      const updated = { ...l, ai_score: r.score, ai_summary: r.summary, ai_message: r.message, status: "analisado" };
      setSel(updated); setDraft(r.message);
      await qc.invalidateQueries({ queryKey: ["leads"] });
      await qc.invalidateQueries({ queryKey: ["lead-stats"] });
    } catch { toast.error("Não foi possível analisar este lead. Tente novamente."); }
    finally { setBusyId(null); }
  }

  async function approve(l: Lead) {
    const approvedMessage = draft.trim();
    if (!approvedMessage || approvedMessage.length > 1000) {
      toast.error("Revise a mensagem: ela não pode estar vazia nem ultrapassar 1.000 caracteres.");
      return;
    }
    const { data: updated, error } = await supabase
      .from("leads")
      .update({ ai_message: approvedMessage, approved: true, status: "aprovado" })
      .eq("id", l.id)
      .select("id")
      .maybeSingle();
    if (error || !updated) { toast.error("Não foi possível salvar a aprovação. Tente novamente."); return; }
    setSel({ ...l, ai_message: approvedMessage, approved: true, status: "aprovado" });
    await qc.invalidateQueries({ queryKey: ["leads"] });
    await qc.invalidateQueries({ queryKey: ["lead-stats"] });
    toast.success("Mensagem aprovada.");
  }

  async function markSent(l: Lead) {
    if (!l.approved) {
      toast.error("Aprove a mensagem antes de registrar o contato.");
      return;
    }
    const { data: updated, error } = await supabase
      .from("leads")
      .update({ status: "contatado" })
      .eq("id", l.id)
      .eq("approved", true)
      .select("id")
      .maybeSingle();
    if (error || !updated) { toast.error("Não foi possível registrar o contato. Confirme a aprovação e tente novamente."); return; }
    setSel({ ...l, status: "contatado" });
    await qc.invalidateQueries({ queryKey: ["leads"] });
    await qc.invalidateQueries({ queryKey: ["lead-stats"] });
    toast.success("Contato registrado manualmente.");
  }

  async function signOut() {
    await qc.cancelQueries(); qc.clear();
    await supabase.auth.signOut();
    nav({ to: "/auth", replace: true });
  }

  return (
    <div className="mx-auto max-w-7xl px-5 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand font-display text-lg font-black text-primary-foreground">A</div>
          <div>
            <h1 className="text-xl font-bold">ADVEXON Prospect</h1>
            <p className="text-sm text-muted-foreground">Rio Preto e região · fonte: OpenStreetMap</p>
          </div>
        </div>
        <Button variant="outline" onClick={signOut}>Sair</Button>
      </header>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[["Leads", stats?.total ?? "—"], ["Sem site", stats?.noSite ?? "—"], ["Analisados pela IA", stats?.analyzed ?? "—"], ["Aprovados", stats?.approved ?? "—"]].map(([k, v]) => (
          <div key={k} className="rounded-2xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className="mt-1 font-display text-3xl font-extrabold">{v}</div>
          </div>
        ))}
      </div>

      <section className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border bg-card p-4">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Buscar novos estabelecimentos em</div>
          <select value={city} onChange={(e) => setCity(e.target.value)} className="h-9 rounded-md border bg-input/30 px-3 text-sm">
            {CITIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <Button onClick={doImport} disabled={importing}>{importing ? "Buscando (até 1 min)..." : "Buscar leads"}</Button>
        <p className="text-xs text-muted-foreground">"Sem site" significa que nenhum site foi identificado na fonte — confirme antes de abordar.</p>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
        <section className="rounded-2xl border bg-card p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            <Input placeholder="Buscar nome ou categoria" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
            <select value={filterCity} onChange={(e) => { setFilterCity(e.target.value); setPage(1); }} className="h-9 rounded-md border bg-input/30 px-3 text-sm">
              <option value="">Todas as cidades</option>
              {CITIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }} className="h-9 rounded-md border bg-input/30 px-3 text-sm" aria-label="Filtrar por status">
              <option value="">Todos os status</option>
              <option value="novo">Novo</option>
              <option value="analisado">Analisado</option>
              <option value="aprovado">Aprovado</option>
              <option value="contatado">Contatado</option>
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyNoSite} onChange={(e) => { setOnlyNoSite(e.target.checked); setPage(1); }} /> Só sem site</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyPhone} onChange={(e) => { setOnlyPhone(e.target.checked); setPage(1); }} /> Com telefone</label>
          </div>
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="p-2">Negócio</th><th className="p-2">Cidade</th><th className="p-2">Contato</th><th className="p-2">Status</th></tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} onClick={() => { setSel(l); setDraft(l.ai_message ?? ""); }}
                    className={`cursor-pointer border-t hover:bg-muted ${sel?.id === l.id ? "bg-muted" : ""}`}>
                    <td className="p-2"><div className="font-semibold">{l.name}</div><div className="text-xs text-muted-foreground">{l.category}</div></td>
                    <td className="p-2">{l.city}</td>
                    <td className="p-2">{l.phone || l.whatsapp || <span className="text-muted-foreground">—</span>}</td>
                    <td className="p-2"><Badge variant={l.approved ? "default" : "secondary"}>{l.status}{l.ai_score != null ? ` · ${l.ai_score}` : ""}</Badge></td>
                  </tr>
                ))}
                {leadsQuery.isLoading && <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">Carregando leads…</td></tr>}
                {leadsQuery.isError && <tr><td colSpan={4} className="p-8 text-center text-destructive">Não foi possível carregar os leads. Verifique sua conexão e tente novamente. <button type="button" className="underline" onClick={() => void leadsQuery.refetch()}>Tentar novamente</button></td></tr>}
                {!leadsQuery.isLoading && !leadsQuery.isError && leads.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">Nenhum lead encontrado para estes filtros.</td></tr>}
              </tbody>
            </table>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
              <span className="text-muted-foreground">
                {leadsQuery.isError ? "Contagem indisponível" : `${filteredCount} lead(s) · Página ${page} de ${totalPages}`}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1 || leadsQuery.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}>Anterior</Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages || leadsQuery.isFetching} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Próxima</Button>
              </div>
            </div>
            {statsQuery.isError && <p className="mt-2 text-xs text-destructive">Não foi possível atualizar as contagens totais; tente recarregar o painel.</p>}
          </div>
        </section>

        <aside className="h-max rounded-2xl border bg-card p-5 lg:sticky lg:top-4">
          {!sel ? <p className="text-sm text-muted-foreground">Selecione um lead para ver detalhes e gerar a abordagem.</p> : (
            <div className="space-y-3">
              <h2 className="text-lg font-bold">{sel.name}</h2>
              <dl className="space-y-1 text-sm">
                <div><span className="text-muted-foreground">Categoria:</span> {sel.category ?? "—"}</div>
                <div><span className="text-muted-foreground">Endereço:</span> {sel.address ?? "não informado na fonte"}, {sel.city}</div>
                <div><span className="text-muted-foreground">Telefone:</span> {sel.phone ?? sel.whatsapp ?? "não informado na fonte"}</div>
                <div><span className="text-muted-foreground">Site:</span> {sel.website ?? "nenhum identificado"}</div>
                <div className="text-xs text-muted-foreground">Fonte: {sel.source} · consultado em {new Date(sel.fetched_at).toLocaleString("pt-BR")}</div>
              </dl>
              <Button variant="secondary" className="w-full" disabled={busyId === sel.id} onClick={() => doAnalyze(sel)}>
                {busyId === sel.id ? "IA analisando..." : sel.ai_message ? "Gerar nova mensagem" : "Analisar e escrever mensagem com IA"}
              </Button>
              {sel.ai_summary && <p className="rounded-lg bg-muted p-3 text-sm"><b>Potencial {sel.ai_score}/100.</b> {sel.ai_summary}</p>}
              {(sel.ai_message || draft) && (
                <>
                  <Textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <Button className="w-full" onClick={() => approve(sel)}>{sel.approved ? "Salvar edição" : "Aprovar mensagem"}</Button>
                  {sel.approved && (() => {
                    const link = createWhatsAppUrl(sel.whatsapp, draft) ?? createWhatsAppUrl(sel.phone, draft);
                    return (
                      <>
                        {link
                          ? <Button asChild variant="outline" className="w-full"><a href={link} target="_blank" rel="noreferrer">Abrir no WhatsApp</a></Button>
                          : <p className="text-xs text-muted-foreground">Telefone ausente ou inválido — confirme o número na fonte antes de enviar.</p>}
                        {sel.approved && sel.status !== "contatado" && (
                          <Button variant="secondary" className="w-full" onClick={() => markSent(sel)}>Registrar contato realizado</Button>
                        )}
                        {sel.status === "contatado" && <p className="text-xs text-muted-foreground">Contato registrado manualmente.</p>}
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
