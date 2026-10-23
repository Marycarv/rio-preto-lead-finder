# ADVEXON Prospect

Aplicativo de prospecção assistida para encontrar negócios locais que podem precisar de um site profissional ou cardápio digital.

## Pesquisa com Gemini

A busca usa uma única integração do Gemini API, com Google Search e Google Maps grounding habilitados na mesma interação. O Gemini pesquisa a cidade e o tema escolhido, retorna negócios com fontes verificáveis e o aplicativo mostra os links de referência. A busca retorna até 10 oportunidades por vez; não promete listar todos os negócios.

O mesmo Gemini gera o resumo, a pontuação e a sugestão de mensagem comercial. Toda mensagem continua sujeita à aprovação manual. O aplicativo não envia mensagens automaticamente.

### Configuração

No Lovable Cloud, adicione a variável secreta de servidor `GEMINI_API_KEY`. Obtenha uma chave no [Google AI Studio](https://aistudio.google.com/apikey). Não adicione essa chave ao código nem a exponha no navegador.

A API pode cobrar pelo uso de Google Search/Google Maps grounding depois da franquia da conta. Confira [os preços oficiais do Gemini](https://ai.google.dev/gemini-api/docs/pricing) e o consumo antes de pesquisar repetidamente.

## Desenvolvimento

O projeto foi criado com [Lovable](https://lovable.dev) e é sincronizado com o repositório.

```sh
git clone <this-repository-url>
cd <repository-name>
npm install
npm run dev
```

Consulte [docs/security-and-deployment.md](docs/security-and-deployment.md) para configuração do Supabase, grounding do Gemini, custos e pontos de atenção sobre privacidade.
