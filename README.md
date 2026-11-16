# Garimpo

App web (PWA) para mandar vídeos do Instagram para o Claude analisar no PC, sem copiar link por link.

No celular (Android, Chrome), o app aparece na lista de **Compartilhar** do Instagram. Cada vídeo vira uma issue
num repositório **privado** do GitHub. O título da issue é o link e o corpo é a sua nota. No PC, a skill
`ver-instagram` lê essas issues com o `fila_github.py`, baixa e transcreve os vídeos, e o Claude responde na própria
issue com **Vale a pena** ou **Evite**. A resposta aparece no app.

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
| `estilo.css` | Visual, com tema claro e escuro. |
| `manifest.webmanifest` | Nome, ícones e o `share_target` (o que põe o app no Compartilhar). |
| `sw.js` | Service worker: abre o app sem internet. Não guarda nada do GitHub. |
| `icone-*.png` | Ícones (o *maskable* é o recortado pelo Android). |
