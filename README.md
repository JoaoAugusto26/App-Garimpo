# Garimpo

App web (PWA) para mandar vídeos do Instagram para o Claude analisar no PC, sem copiar link por link.

No celular (Android, Chrome), o app aparece na lista de **Compartilhar** do Instagram. Cada vídeo vira uma issue
num repositório **privado** do GitHub. No PC, a skill `ver-instagram` lê essas issues com o `fila_github.py`, baixa e
transcreve os vídeos, e o Claude responde na própria issue com **Vale a pena** ou **Evite**. A resposta aparece no app.

## O que o app faz

- **Compartilhar → Garimpo** manda o vídeo para a fila, com uma nota opcional ("ver se serve pro Ultron"). Também
  dá para colar um link, ou vários de uma vez.
- Se o vídeo **já foi analisado**, mostra o veredito na hora, sem criar outro pedido. Se já está na fila, avisa.
- A lista é agrupada por dia (Hoje, Ontem, Esta semana...). Cada cartão mostra:
  - o nome da ferramenta e a situação;
  - o andamento (Recebido → Baixado → Analisado);
  - a análise, com a **fonte** oficial, os **projetos** para quem serve e o **comando de instalação** com botão
    Copiar.
- Vereditos que chegaram desde a última visita ganham **Novo**, um filtro próprio e a contagem no título.
- **Caixa de ferramentas** (a aba ao lado de Vídeos):
  - mostra só o que vale a pena, uma vez por ferramenta, com o custo, os projetos e o comando de instalar;
  - o círculo marca a ferramenta como instalada (etiqueta `instalado` no GitHub), e o PC passa a saber o que
    você já tem.
- Tocar numa etiqueta de projeto (Ultron, Remedicy...) mostra só o que serve para ele, nas duas abas.
- **Filtros** com contagem e **busca** por ferramenta, nota ou análise.
- **Compartilhar** um veredito, **Tentar de novo** num vídeo que falhou, **Editar a nota** de um vídeo na fila e
  **Remover** (sai na hora, com **Desfazer** na mensagem de baixo).
- O site não bloqueia mais o "puxar para atualizar" do Chrome. No app instalado ele ainda não foi testado; o
  botão de atualizar continua lá.
- Segurando o ícone do app: atalhos **Colar link** e **Caixa de ferramentas**.
- Abre na hora com a última lista, inclusive sem internet, e atualiza sozinho quando você volta para o app.
- A configuração tem o botão **Criar token no GitHub**, que abre a página já preenchida. O app também oferece
  **Instalar** quando o Chrome deixa.

## Contrato com o PC

| Parte da issue | O que guarda |
|---|---|
| Título | `<rótulo> · <link>` ou só `<link>`. O rótulo é o @autor depois do download e o nome da ferramenta depois da análise. |
| Corpo | A nota. |
| Etiquetas | `baixado`, `falhou`, `analisado` + `vale-a-pena` ou `evite`. São a fonte da verdade da situação. O app põe `instalado` quando você marca a ferramenta. |
| Comentário | O último que começa com `**Vale a pena**` ou `**Evite**` é a análise: o motivo num parágrafo e, depois de uma linha em branco, as linhas opcionais `Fonte: https://...`, `Custo: Grátis (MIT)`, `Para: Ultron, Remedicy` e ``Instalar: `comando` ``. |

## Como funciona

- O app não tem servidor: são arquivos estáticos no GitHub Pages. Ele fala direto com a API do GitHub.
- O token fica só no celular (`localStorage`). Use um token *fine-grained* com acesso só ao repositório da fila e a
  permissão **Issues: Read and write**. Se o celular for perdido, apague o token no GitHub.
- O link é limpo antes de ir para a fila: no Instagram, sai tudo depois do `?` (o `igsh` identifica quem
  compartilhou).
- Sem internet, o link fica guardado no celular e vai sozinho quando a conexão voltar.
- O app recusa um repositório público, para os links e as notas não ficarem visíveis.
- O texto das análises vem de comentários do GitHub. A tela só o mostra como texto, e a fonte só vira link se
  for `https`.

## Instalar

1. Abra o endereço do app no **Chrome** do Android.
2. Menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial" → Instalar).
   - Xiaomi (MIUI/HyperOS): se não aparecer o ícone, libere em Configurações → Apps → Chrome → Outras permissões
     → **Atalhos na tela inicial**.
3. Abra o app e siga os dois passos da configuração:
   - **Criar token no GitHub**. A página abre com o nome e a validade de 1 ano (o link também pede a permissão de
     Issues). Escolha *Only select repositories* → a fila e confira *Issues: Read and write* em *Permissions*.
   - Preencha o repositório (`usuario/garimpo-fila`) e cole o token.
4. No Instagram: Compartilhar → **Garimpo**. Ele só aparece na lista se foi *instalado* (passo 2), não
   apenas adicionado como favorito.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `index.html` | A tela. CSP rígida: sem script inline, conexões só com `api.github.com`. |
| `app.js` | Recebe o compartilhamento, limpa o link, cria a issue e mostra a fila. |
| `estilo.css` | Visual: tema escuro, preto com dourado. |
| `manifest.webmanifest` | Nome, ícones, os atalhos do ícone e o `share_target` (o que põe o app no Compartilhar). |
| `sw.js` | Service worker: abre o app sem internet. Não guarda nada do GitHub. |
| `icone-*.png` | Ícones (o *maskable* é o recortado pelo Android). |

## Ao mudar o site

Quem muda `app.js` ou `estilo.css` sobe junto o `?v=` deles no `index.html` e a `VERSAO` do `sw.js`. O GitHub Pages
guarda os arquivos por 10 minutos, e sem isso o celular pode juntar o HTML novo com o script velho.
