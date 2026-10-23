import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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

function waLink(l: Lead, msg: string) {
  let n = (l.whatsapp || l.phone || "").replace(/\D/g, "");
  if (!n) return null;
  if (!n.startsWith("55")) n = "55" + n;
  return `https://wa.me/${n}?text=${encodeURIComponent(msg)}`;
}

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

  const { data: leads = [] } = useQuery({
    queryKey: ["leads"],
    queryFn: async () => {
      const all: Lead[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("leads").select("*").order("created_at", { ascending: false }).range(from, from + 999);
        if (error) throw error;
        all.push(...(data as Lead[]));
        if (!data || data.length < 1000) break;
      }
      return all;
    },
  });

  const filtered = useMemo(() => leads.filter((l) =>
    (!onlyNoSite || !l.has_website) && (!onlyPhone || l.phone || l.whatsapp) &&
    (!filterCity || l.city === filterCity) &&
    (!q || `${l.name} ${l.category ?? ""}`.toLowerCase().includes(q.toLowerCase()))
  ), [leads, onlyNoSite, onlyPhone, filterCity, q]);

  const stats = {
    total: leads.length,
    noSite: leads.filter((l) => !l.has_website).length,
    analyzed: leads.filter((l) => l.ai_message).length,
    approved: leads.filter((l) => l.approved).length,
  };

  async function doImport() {
    setImporting(true);
    try {
      const r = await runImport({ data: { city } });
      toast.success(`${r.found} encontrados em ${city} (${r.withoutSite} sem site). ${r.inserted} novos salvos.`);
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e) { toast.error((e as Error).message); }
    finally { setImporting(false); }
  }

  async function doAnalyze(l: Lead) {
    setBusyId(l.id);
    try {
      const r = await runAnalyze({ data: { id: l.id } });
      const updated = { ...l, ai_score: r.score, ai_summary: r.summary, ai_message: r.message, status: "analisado" };
      setSel(updated); setDraft(r.message);
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusyId(null); }
  }

  async function approve(l: Lead) {
    const { error } = await supabase.from("leads").update({ ai_message: draft, approved: true, status: "aprovado" }).eq("id", l.id);
    if (error) return toast.error(error.message);
    setSel({ ...l, ai_message: draft, approved: true, status: "aprovado" });
    qc.invalidateQueries({ queryKey: ["leads"] });
    toast.success("Mensagem aprovada.");
  }

  async function markSent(l: Lead) {
    await supabase.from("leads").update({ status: "contatado" }).eq("id", l.id);
    qc.invalidateQueries({ queryKey: ["leads"] });
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
        {[["Leads", stats.total], ["Sem site", stats.noSite], ["Analisados pela IA", stats.analyzed], ["Aprovados", stats.approved]].map(([k, v]) => (
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
            <Input placeholder="Buscar nome ou categoria" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <select value={filterCity} onChange={(e) => setFilterCity(e.target.value)} className="h-9 rounded-md border bg-input/30 px-3 text-sm">
              <option value="">Todas as cidades</option>
              {CITIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyNoSite} onChange={(e) => setOnlyNoSite(e.target.checked)} /> Só sem site</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyPhone} onChange={(e) => setOnlyPhone(e.target.checked)} /> Com telefone</label>
          </div>
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="p-2">Negócio</th><th className="p-2">Cidade</th><th className="p-2">Contato</th><th className="p-2">Status</th></tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((l) => (
                  <tr key={l.id} onClick={() => { setSel(l); setDraft(l.ai_message ?? ""); }}
                    className={`cursor-pointer border-t hover:bg-muted ${sel?.id === l.id ? "bg-muted" : ""}`}>
                    <td className="p-2"><div className="font-semibold">{l.name}</div><div className="text-xs text-muted-foreground">{l.category}</div></td>
                    <td className="p-2">{l.city}</td>
                    <td className="p-2">{l.phone || l.whatsapp || <span className="text-muted-foreground">—</span>}</td>
                    <td className="p-2"><Badge variant={l.approved ? "default" : "secondary"}>{l.status}{l.ai_score != null ? ` · ${l.ai_score}` : ""}</Badge></td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">Nenhum lead. Escolha uma cidade e clique em "Buscar leads".</td></tr>}
              </tbody>
            </table>
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
                    const link = waLink(sel, draft);
                    return link
                      ? <Button asChild variant="outline" className="w-full"><a href={link} target="_blank" rel="noreferrer" onClick={() => markSent(sel)}>Abrir no WhatsApp</a></Button>
                      : <p className="text-xs text-muted-foreground">Sem telefone na fonte — copie a mensagem e envie manualmente.</p>;
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
