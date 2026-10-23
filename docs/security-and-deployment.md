# Configuração de segurança e pesquisa Gemini

## Autenticação e isolamento dos leads

- Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` somente nos ambientes apropriados. Nunca grave chaves secretas no Git.
- Revise `supabase/migrations/20261023000100_secure_leads_rls.sql` antes de aplicá-la a um banco compartilhado. Ela habilita RLS em `public.leads`, substitui as policies existentes por policies que comparam `user_id` com `auth.uid()`, e muda o comportamento de acesso embora não apague registros.
- O repositório não contém o histórico completo de migrations de produção. Confirme o esquema de `public.leads`, a coluna `user_id` e a constraint/índice único `(user_id, source, source_id)` antes de aplicar a migration.
- Execute os testes de RLS num banco Supabase local ou de staging isolado com o histórico de migrations completo. Esta alteração de integração Gemini não executa migrations em nenhum banco remoto.

## Uma única inteligência: Gemini com pesquisa Google

O fluxo de pesquisa e geração de mensagens usa diretamente o Gemini API. Pesquisa e redação usam `gemini-2.5-flash`; para buscar negócios, o agente ativa somente o Google Search grounding. Isso evita exigir acesso ao Maps grounding, cujo uso e disponibilidade de quota diferem por nível de conta. Não há chamadas ao Outscraper, Nominatim ou Overpass no fluxo do produto.

### Segredo obrigatório

Adicione `GEMINI_API_KEY` aos Secrets de servidor do Lovable Cloud. Crie e administre a chave no Google AI Studio: https://aistudio.google.com/apikey

- A chave deve existir somente no servidor. Não use prefixo `VITE_`, não a inclua no navegador e não a grave no Git.
- A mesma chave atende à pesquisa de negócios e à geração/avaliação das mensagens. Se estiver ausente ou inválida, o aplicativo exibe erro explícito.
- A pesquisa é limitada a 10 negócios por solicitação. O Gemini usa fontes do Google e a aplicação só importa candidatos que tenham URL de fonte presente nas anotações de grounding da resposta.
- Os links de pesquisa web são apresentados no detalhe do lead. Não invente um link do Google Maps quando a busca por texto não fornecer uma citação de Maps.
- O agente envia instruções de pesquisa em inglês, preservando os nomes e endereços originais; o tema digitado pelo usuário é solicitado ao modelo para tradução antes da busca.
- Uma busca não representa todos os estabelecimentos da cidade. Os resultados do Google podem ser incompletos, e a ausência de URL de site/cardápio é uma oportunidade potencial, não uma comprovação absoluta de que esse recurso não exista.
- A aprovação manual da mensagem continua obrigatória. A aplicação não envia mensagens automaticamente.

### Custos e limites

A tabela de preços oficial consultada em outubro de 2026 indica que `gemini-2.5-flash` inclui Google Search grounding gratuito até 500 consultas por dia, compartilhadas com Flash-Lite. Esse limite é por projeto e a conta ainda pode estar sujeita a limites próprios. Google Maps grounding tem quota e cobrança separadas; por isso ele não é chamado na pesquisa atual.

- Limites de taxa: https://ai.google.dev/gemini-api/docs/rate-limits
- Google Search grounding: https://ai.google.dev/gemini-api/docs/google-search
- Preços do Gemini API: https://ai.google.dev/gemini-api/docs/pricing

### Fontes, privacidade e prospecção

- Os links de citação retornados pela API devem ficar visíveis junto aos resultados a que dão suporte. O painel exibe os links no detalhe do lead.
- Os campos que não foram encontrados devem ficar vazios; não preencha telefone, site, cardápio, endereço ou coordenadas por suposição.
- Verifique os dados antes do primeiro contato. Avalie finalidade, retenção, base legal, transparência e tratamento de pedidos de não contato sob a LGPD antes de prospecção comercial.
- Esta integração usa as ferramentas de grounding do Gemini, não coleta automática em massa nem envio automático de mensagens.

## Recuperação de senha

No painel do Supabase, configure **Site URL** e **Redirect URLs** para os domínios reais do aplicativo. A URL de retorno da recuperação é `/auth?mode=reset` no domínio atual. Permita apenas as origens de desenvolvimento/staging/produção usadas pelo app, configure o envio dos e-mails e teste o fluxo em staging.

