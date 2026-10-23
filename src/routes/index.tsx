import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ADVEXON Prospect — Leads sem site em Rio Preto e região" },
      { name: "description", content: "Encontre negócios sem site ou cardápio em São José do Rio Preto e região e aborde com mensagens personalizadas por IA." },
      { property: "og:title", content: "ADVEXON Prospect — Leads sem site em Rio Preto" },
      { property: "og:description", content: "Prospecção local com OpenStreetMap e IA, com aprovação manual antes de cada contato." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-16">
      <div className="mb-8 flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand font-display text-lg font-black text-primary-foreground">A</div>
        <span className="font-display text-lg font-bold">ADVEXON Prospect</span>
      </div>
      <h1 className="text-4xl font-extrabold leading-tight md:text-6xl">
        Negócios de Rio Preto <span className="text-primary">sem site</span>, prontos para sua abordagem.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
        Busca em São José do Rio Preto, Mirassol, Bady Bassitt, Cedral, Guapiaçu e Ipiguá. A IA classifica cada lead e escreve a mensagem — você revisa, aprova e envia pelo WhatsApp.
      </p>
      <div className="mt-10 flex gap-3">
        <Button asChild size="lg"><Link to="/dashboard">Abrir painel</Link></Button>
        <Button asChild size="lg" variant="outline"><Link to="/auth">Entrar</Link></Button>
      </div>
    </div>
  );
}
