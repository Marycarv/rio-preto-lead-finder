import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AuthMode = "in" | "up" | "recover" | "reset";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Entrar — ADVEXON Prospect" },
      { name: "description", content: "Acesse sua central de prospecção de leads locais." },
      { property: "og:title", content: "Entrar — ADVEXON Prospect" },
      { property: "og:description", content: "Acesse sua central de prospecção de leads locais." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<AuthMode>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "reset"
      ? "reset"
      : "in",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        nav({ to: "/dashboard" });
      } else if (mode === "up") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + "/dashboard" },
        });
        if (error) throw error;
        toast.success("Se o cadastro puder ser concluído, você receberá as próximas instruções por e-mail.");
        setMode("in");
      } else if (mode === "recover") {
        const redirectTo = new URL("/auth?mode=reset", window.location.origin).toString();
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        toast.success("Se o endereço puder receber instruções, você receberá um e-mail para redefinir a senha.");
      } else {
        if (password.length < 6) {
          toast.error("A nova senha deve ter pelo menos 6 caracteres.");
          return;
        }
        if (password !== confirmPassword) {
          toast.error("As senhas não coincidem.");
          return;
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        toast.success("Senha alterada com sucesso.");
        nav({ to: "/dashboard" });
      }
    } catch {
      if (mode === "recover") {
        toast.error("Não foi possível processar a solicitação agora. Tente novamente mais tarde.");
      } else if (mode === "reset") {
        toast.error("Não foi possível alterar a senha. Abra novamente o link de recuperação mais recente.");
      } else if (mode === "in") {
        toast.error("Não foi possível entrar. Confira os dados e tente novamente.");
      } else {
        toast.error("Não foi possível concluir o cadastro. Confira os dados e tente novamente.");
      }
    } finally {
      setBusy(false);
    }
  }

  const heading =
    mode === "in" ? "Entrar" :
    mode === "up" ? "Criar conta" :
    mode === "recover" ? "Recuperar senha" :
    "Definir nova senha";

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-8">
        <div className="mb-2 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand font-display font-black text-primary-foreground">A</div>
          <h1 className="text-xl font-bold">{heading}</h1>
        </div>
        {mode !== "reset" && (
          <div className="space-y-1.5">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        )}
        {(mode === "in" || mode === "up" || mode === "reset") && (
          <div className="space-y-1.5">
            <Label htmlFor="pw">{mode === "reset" ? "Nova senha" : "Senha"}</Label>
            <Input
              id="pw"
              type="password"
              autoComplete={mode === "reset" ? "new-password" : mode === "in" ? "current-password" : "new-password"}
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}
        {mode === "reset" && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-pw">Confirmar nova senha</Label>
            <Input
              id="confirm-pw"
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
        )}
        <Button className="w-full" disabled={busy}>
          {busy ? "Aguarde..." :
            mode === "in" ? "Entrar" :
            mode === "up" ? "Criar conta" :
            mode === "recover" ? "Enviar instruções" :
            "Salvar nova senha"}
        </Button>
        {mode === "in" && (
          <>
            <button type="button" onClick={() => setMode("recover")} className="w-full text-sm text-muted-foreground hover:text-foreground">
              Esqueci minha senha
            </button>
            <button type="button" onClick={() => setMode("up")} className="w-full text-sm text-muted-foreground hover:text-foreground">
              Não tem conta? Criar agora
            </button>
          </>
        )}
        {mode === "up" && (
          <button type="button" onClick={() => setMode("in")} className="w-full text-sm text-muted-foreground hover:text-foreground">
            Já tem conta? Entrar
          </button>
        )}
        {mode === "recover" && (
          <button type="button" onClick={() => setMode("in")} className="w-full text-sm text-muted-foreground hover:text-foreground">
            Voltar ao login
          </button>
        )}
      </form>
    </div>
  );
}
