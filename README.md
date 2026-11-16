# Garimpo

App web (PWA) para mandar vídeos do Instagram para o Claude analisar no PC, sem copiar link por link.

No celular (Android, Chrome), o app aparece na lista de **Compartilhar** do Instagram. Cada vídeo vira uma issue
num repositório **privado** do GitHub. No PC, a skill `ver-instagram` lê essas issues com o `fila_github.py`, baixa e
transcreve os vídeos, e o Claude responde na própria issue com **Vale a pena** ou **Evite**. A resposta aparece no app.

## O que o app faz

- **Compartilhar → Garimpo** manda o vídeo para a fila, com uma nota opcional ("ver se serve pro Ultron").
- Se o vídeo **já foi analisado**, mostra o veredito na hora, sem criar outro pedido. Se já está na fila, avisa.
- A lista mostra o nome da ferramenta, a situação (Na fila, Esperando análise, Vale a pena, Evite, Falhou) e o texto
  da análise direto no cartão.
- **Filtros** com contagem e **busca** por ferramenta, nota ou análise.
- **Tentar de novo** num vídeo que falhou e **Remover** um vídeo da fila (com um segundo toque para confirmar).
- Abre na hora com a última lista, inclusive sem internet, e atualiza sozinho quando você volta para o app.

## Contrato com o PC

| Parte da issue | O que guarda |
|---|---|
| Título | `<rótulo> · <link>` ou só `<link>`. O rótulo é o @autor depois do download e o nome da ferramenta depois da análise. |
| Corpo | A nota. |
| Etiquetas | `baixado`, `falhou`, `analisado` + `vale-a-pena` ou `evite`. São a fonte da verdade da situação. |
| Comentário | O último que começa com `**Vale a pena**` ou `**Evite**` é o texto da análise. |

## Como funciona

- O app não tem servidor: são arquivos estáticos no GitHub Pages. Ele fala direto com a API do GitHub.
- O token fica só no celular (`localStorage`). Use um token *fine-grained* com acesso só ao repositório da fila e a
  permissão **Issues: Read and write**. Se o celular for perdido, apague o token no GitHub.
- O link é limpo antes de ir para a fila: no Instagram, sai tudo depois do `?` (o `igsh` identifica quem
  compartilhou).
- Sem internet, o link fica guardado no celular e vai sozinho quando a conexão voltar.
- O app recusa um repositório público, para os links e as notas não ficarem visíveis.

## Instalar

1. Abra o endereço do app no **Chrome** do Android.
2. Menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial" → Instalar).
   - Xiaomi (MIUI/HyperOS): se não aparecer o ícone, libere em Configurações → Apps → Chrome → Outras permissões
     → **Atalhos na tela inicial**.
3. Abra o app, toque na engrenagem e preencha o repositório (`usuario/garimpo-fila`) e o token.
4. No Instagram: Compartilhar → **Garimpo**. Ele só aparece na lista se foi *instalado* (passo 2), não
   apenas adicionado como favorito.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `index.html` | A tela. CSP rígida: sem script inline, conexões só com `api.github.com`. |
| `app.js` | Recebe o compartilhamento, limpa o link, cria a issue e mostra a fila. |
| `estilo.css` | Visual: tema escuro, preto com dourado. |
| `manifest.webmanifest` | Nome, ícones e o `share_target` (o que põe o app no Compartilhar). |
| `sw.js` | Service worker: abre o app sem internet. Não guarda nada do GitHub. |
| `icone-*.png` | Ícones (o *maskable* é o recortado pelo Android). |

## Ao mudar o site

Quem muda `app.js` ou `estilo.css` sobe junto o `?v=` deles no `index.html` e a `VERSAO` do `sw.js`. O GitHub Pages
guarda os arquivos por 10 minutos, e sem isso o celular pode juntar o HTML novo com o script velho.
