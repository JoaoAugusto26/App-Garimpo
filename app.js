// Garimpo: recebe links de video pelo "Compartilhar" do Android e guarda cada um como issue num repositorio
// privado do GitHub. O PC le essas issues, baixa e transcreve os videos, e o Claude responde na propria issue.
//
// Contrato com o PC (fila_github.py): titulo "<rotulo> · <link>" ou so "<link>"; corpo = nota; etiquetas =
// status (baixado, falhou, analisado + vale-a-pena/evite) e "instalado" (posta por este app); o veredito e o
// ultimo comentario que comeca com "**Vale a pena**" ou "**Evite**", no formato do compor_veredito():
//   **Vale a pena**: <motivo>
//
//   Fonte: https://...        (opcional)
//   Custo: Gratis (MIT)       (opcional)
//   Confiança: alta           (opcional: alta, média ou baixa)
//   Para: Ultron, Remedicy    (opcional)
//   Instalar: `comando`       (opcional)
// e talvez "_Já analisado na #N; ..._" no fim.
'use strict';

const API = 'https://api.github.com';
const CHAVE_CONFIG = 'fila-config';          // {repo: "usuario/nome", token: "..."}
const CHAVE_PENDENTES = 'fila-pendentes';    // links que nao chegaram ao GitHub: [{link, nota, quando}]
const CHAVE_TEXTOS = 'garimpo-textos';       // cache dos comentarios: {numero: {n: quantos comentarios, t: corpo}}
const CHAVE_FILTRO = 'garimpo-filtro';
const CHAVE_ISSUES = 'garimpo-issues';       // a ultima lista, para abrir na hora e sem internet
const CHAVE_VISTOS = 'garimpo-vistos';       // numeros dos vereditos que ele ja viu (os outros ganham "Novo")
const CHAVE_ATUALIZADO = 'garimpo-atualizado';
const CHAVE_VISTA = 'garimpo-vista';         // "videos" ou "ferramentas"
const CHAVE_INSTALAR_DEPOIS = 'garimpo-instalar-depois';  // quando ele tocou em "Agora nao" no cartao de instalar
const CHAVE_RODADA = 'garimpo-rodada-pc';     // hora (UTC) da ultima rodada automatica do PC, da etiqueta "baixado"
const PC_PARADO_MIN = 75;                     // a tarefa roda a cada 30 min: mais que isso parado = PC desligado?
const INSTALAR_DEPOIS_MS = 14 * 864e5;      // o cartao volta depois de 14 dias
const RASTREIO = /^(utm_.*|igsh|igshid|si|fbclid|gclid|mibextid|ref|ref_src|share_id)$/i;
const RE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RE_URL = /https?:\/\/[^\s<>"'“”]+/i;
const MAX_TEXTOS_POR_VEZ = 15;
const MAX_PAGINAS = 5;                       // 500 videos
const LIMITE_TEXTO = 280;                    // analise maior que isso fica fechada, com "Ver tudo"
const FILTROS = [
  ['novos', 'Novos'], ['tudo', 'Tudo'], ['fila', 'Na fila'], ['esperando', 'Esperando'],
  ['vale', 'Vale a pena'], ['evite', 'Evite'], ['falhou', 'Falhou'],
];
const FILTROS_CAIXA = [['todas', 'Todas'], ['instalar', 'Para instalar'], ['instaladas', 'Instaladas']];

const $ = (id) => document.getElementById(id);

function el(tag, classe = '', texto = null) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== null) e.textContent = texto;
  return e;
}

function botao(classe, texto, dados = {}) {
  const b = el('button', classe, texto);
  b.type = 'button';
  Object.assign(b.dataset, dados);
  return b;
}

// ------------------------------------------------------------------ icones (tracos, 24x24)

const SVG = 'http://www.w3.org/2000/svg';
const ICONES = {
  vale: 'M20 6 9 17l-5-5',
  evite: 'M18 6 6 18M6 6l12 12',
  falhou: 'M12 6v8M12 18h.01',
  esperando: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  fila: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  abrir: 'M8 5.5v13l10.5-6.5z',
  externo: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  copiar: 'M9 9h11v11H9zM5 15H4V4h11v1',
  compartilhar: 'M12 3v12M7 8l5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5',
  tentar: 'M20 12a8 8 0 1 1-2.34-5.66L20 8.5M20 3.5v5h-5',
  remover: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  nota: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
};

function icone(nome, tamanho = 16) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', tamanho);
  s.setAttribute('height', tamanho);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ic');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', ICONES[nome]);
  s.append(p);
  return s;
}

// ------------------------------------------------------------------ armazenamento (pode falhar em modo privado)

function ler(chave, padrao) {
  try {
    const v = localStorage.getItem(chave);
    return v ? JSON.parse(v) : padrao;
  } catch {
    return padrao;
  }
}

function gravar(chave, valor) {
  try {
    if (valor === null || valor === undefined) localStorage.removeItem(chave);
    else localStorage.setItem(chave, JSON.stringify(valor));
    return true;
  } catch {
    return false;
  }
}

const config = () => ler(CHAVE_CONFIG, null);
const configurado = () => {
  const c = config();
  return Boolean(c && c.token && RE_REPO.test(c.repo || ''));
};

// ------------------------------------------------------------------ links, titulos e datas

// Tira o rastreamento. No Instagram, tudo depois do "?" (o igsh identifica quem compartilhou).
function limparLink(bruto) {
  let u;
  try {
    u = new URL(bruto);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  if (/(^|\.)instagram\.com$/i.test(u.hostname)) {
    u.hostname = 'www.instagram.com';
    u.search = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
  } else {
    for (const k of [...u.searchParams.keys()]) if (RASTREIO.test(k)) u.searchParams.delete(k);
  }
  u.protocol = 'https:';
  return u.toString();
}

const tirarPontuacao = (l) => l.replace(/[).,;:!?\]]+$/, '');

// O Android costuma mandar o link no campo "text", junto com outras palavras; as vezes no "url" ou no "title".
function acharLink(...textos) {
  for (const t of textos) {
    if (!t) continue;
    const m = String(t).match(RE_URL);
    if (m) {
      const link = limparLink(tirarPontuacao(m[0]));
      if (link) return link;
    }
  }
  return null;
}

// Todos os links de um texto colado. O campo de uma linha so junta as linhas, entao separa antes de cada http.
function acharLinks(texto) {
  const separado = String(texto || '').replace(/(?!^)(?=https?:\/\/)/g, ' ');
  const achados = separado.match(new RegExp(RE_URL.source, 'gi')) || [];
  return [...new Set(achados.map((l) => limparLink(tirarPontuacao(l))).filter(Boolean))];
}

function linkCurto(link) {
  try {
    const u = new URL(link);
    const curto = (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
    return u.search ? `${curto}${u.search}`.slice(0, 60) : curto;  // o ?v= do YouTube diz qual video e
  } catch {
    return link;
  }
}

function plataforma(link) {
  try {
    const h = new URL(link).hostname.replace(/^(www|m)\./, '');
    if (/(^|\.)instagram\.com$/.test(h)) return 'Instagram';
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return 'YouTube';
    if (/(^|\.)tiktok\.com$/.test(h)) return 'TikTok';
    if (/(^|\.)(x|twitter)\.com$/.test(h)) return 'X';
    return h;
  } catch {
    return 'link';
  }
}

// O que o cartao mostra: o rotulo do titulo (o @autor ou o nome da ferramenta).
function rotulo(issue) {
  return (issue.title || '').replace(RE_URL, '').replace(/^[\s·\-–|]+|[\s·\-–|]+$/g, '');
}

// So https vira link na tela; qualquer outra coisa fica de fora.
function linkSeguro(texto) {
  try {
    const u = new URL(String(texto).trim());
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function textoLimpo(corpo) {
  return (corpo || '')
    .replace(/^\s*\*\*(Vale a pena|Evite)\*\*:\s*/i, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Separa o comentario do veredito no que a tela mostra: motivo, fonte, custo, projetos, comando e observacao.
function partesDoVeredito(corpo) {
  const p = { motivo: '', fonte: null, custo: '', confianca: '', para: [], instalar: '', obs: '' };
  const resto = [];
  for (const linha of String(corpo || '').replace(/\r/g, '').split('\n')) {
    const m = linha.match(/^\s*(Fonte|Custo|Confian[cç]a|Para|Instalar):\s*(.+?)\s*$/i);
    if (m) {
      const campo = semAcento(m[1]);
      if (campo === 'fonte') p.fonte = linkSeguro(m[2]);
      else if (campo === 'confianca') p.confianca = ['alta', 'media', 'baixa'].find((n) => semAcento(m[2]).startsWith(n)) || '';
      else if (campo === 'custo') p.custo = m[2].slice(0, 60);
      else if (campo === 'para') p.para = m[2].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
      else p.instalar = m[2].replace(/^`+|`+$/g, '').trim();
      continue;
    }
    const obs = linha.match(/^\s*_(Já analisado na #\d+[^_]*)_\s*$/i);
    if (obs) {
      p.obs = obs[1];
      continue;
    }
    resto.push(linha);
  }
  p.motivo = textoLimpo(resto.join('\n'));
  return p;
}

function fonteCurta(url) {
  try {
    const u = new URL(url);
    const t = (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
    return t.length > 46 ? `${t.slice(0, 45)}…` : t;
  } catch {
    return url;
  }
}

const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const RELATIVO = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto', style: 'short' });
const DIA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

// "agora", "há 5 min.", "há 2 h", "ontem", "há 3 dias", "em 12/11"
function quando(iso) {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (Number.isNaN(s)) return '';
  if (s < 60) return 'agora';
  if (s < 3600) return RELATIVO.format(-Math.floor(s / 60), 'minute');
  if (s < 86400 && d.getDate() === new Date().getDate()) return RELATIVO.format(-Math.floor(s / 3600), 'hour');
  const dias = diasAtras(d);
  if (dias < 7) return RELATIVO.format(-Math.max(1, dias), 'day');
  return `em ${DIA.format(d)}`;
}

function diasAtras(d) {
  const meiaNoite = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((meiaNoite(new Date()) - meiaNoite(d)) / 864e5);
}

function grupoDaData(iso) {
  const dias = diasAtras(new Date(iso));
  if (dias <= 0) return 'Hoje';
  if (dias === 1) return 'Ontem';
  if (dias < 7) return 'Esta semana';
  if (dias < 31) return 'Este mês';
  return 'Mais antigos';
}

// ------------------------------------------------------------------ GitHub

class ErroGitHub extends Error {
  constructor(mensagem, { token = false, rede = false, status = 0 } = {}) {
    super(mensagem);
    this.token = token;    // problema no token ou no repositorio: nao adianta tentar de novo sozinho
    this.rede = rede;      // sem internet ou GitHub fora: guarda para reenviar
    this.status = status;
  }
}

async function gh(caminho, { metodo = 'GET', corpo } = {}) {
  const c = config();
  const cabecalhos = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${c.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(API + caminho, {
      method: metodo,
      headers: cabecalhos,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      cache: 'no-store',
    });
  } catch {
    throw new ErroGitHub('Sem conexão com o GitHub.', { rede: true });
  }
  if (r.status === 401) {
    throw new ErroGitHub('O GitHub recusou o token: ele pode ter expirado ou sido apagado. Gere outro e salve na configuração.', { token: true, status: 401 });
  }
  if (r.status === 403 || r.status === 404) {
    if (r.headers.get('x-ratelimit-remaining') === '0') {
      throw new ErroGitHub('Limite de uso do GitHub atingido. Tente de novo daqui a pouco.', { rede: true, status: r.status });
    }
    throw new ErroGitHub(`O GitHub não deixou acessar ${c.repo} (${r.status}). Confira o nome do repositório e se o token tem acesso a ele com "Issues: Read and write".`, { token: true, status: r.status });
  }
  if (r.status >= 500) throw new ErroGitHub(`O GitHub está com problema (${r.status}).`, { rede: true, status: r.status });
  if (!r.ok) throw new ErroGitHub(`O GitHub respondeu ${r.status}.`, { status: r.status });
  return r.status === 204 ? null : r.json();
}

const caminhoRepo = () => `/repos/${config().repo}`;
const dono = () => config().repo.split('/')[0].toLowerCase();

// So os campos que a tela usa: a lista guardada e o que aparece ao abrir sem internet.
function guardarIssues(lista) {
  gravar(CHAVE_ISSUES, lista.map((i) => ({
    number: i.number, title: i.title, body: i.body, state: i.state, comments: i.comments,
    created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at,
    labels: (i.labels || []).map((l) => ({ name: l.name || l })),
  })));
}

async function buscarIssues() {
  let todas = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina += 1) {
    const lista = await gh(`${caminhoRepo()}/issues?state=all&per_page=100&sort=created&direction=desc&page=${pagina}`);
    todas = todas.concat(lista);
    if (lista.length < 100) break;
  }
  const minhas = todas.filter((i) => !i.pull_request && (i.user?.login || '').toLowerCase() === dono());
  guardarIssues(minhas);
  ultimaCargaOk = Date.now();
  gravar(CHAVE_ATUALIZADO, ultimaCargaOk);
  semearVistos(minhas);
  return minhas;
}

// ------------------------------------------------------------------ estado de cada issue

function nomesDasEtiquetas(issue) {
  return new Set((issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)));
}

function situacao(issue) {
  const n = nomesDasEtiquetas(issue);
  if (n.has('vale-a-pena')) return 'vale';
  if (n.has('evite')) return 'evite';
  if (issue.state === 'closed') return 'removido';  // fechada sem veredito: removida no app, mesmo com "falhou"
  if (n.has('falhou')) return 'falhou';
  if (n.has('baixado')) return 'esperando';
  return 'fila';
}

const temVeredito = (i) => ['vale', 'evite'].includes(situacao(i));
const instalada = (i) => nomesDasEtiquetas(i).has('instalado');

const ROTULO_SITUACAO = {
  vale: ['Vale a pena', 'ok'], evite: ['Evite', 'erro'], falhou: ['Falhou', 'erro'],
  esperando: ['Esperando análise', 'espera'], fila: ['Na fila', 'fila'], removido: ['Removido', ''],
};

// A data que conta: quando foi analisado (para os vereditos) ou quando foi mandado.
const dataDoItem = (i) => (temVeredito(i) && i.closed_at ? i.closed_at : i.created_at) || '';
const maisNovoPrimeiro = (a, b) => dataDoItem(b).localeCompare(dataDoItem(a));

// ------------------------------------------------------------------ vereditos novos

let vistos = ler(CHAVE_VISTOS, null);  // null: primeira vez neste celular

const numerosComVeredito = (lista = issues) => lista.filter(temVeredito).map((i) => i.number);
const ehNovo = (i) => Array.isArray(vistos) && temVeredito(i) && !vistos.includes(i.number);

// Na primeira vez, tudo o que ja existe conta como visto: so o que chegar depois ganha "Novo".
function semearVistos(lista = issues) {
  if (vistos !== null) return;
  vistos = numerosComVeredito(lista);
  gravar(CHAVE_VISTOS, vistos);
}

// Ao sair do app, os novos desta visita ficam gravados como vistos. A tela so muda na proxima abertura (ou
// depois de um bom tempo fora): tocar em "Abrir video" e voltar nao apaga o "Novo" no meio da leitura.
let escondidoEm = 0;
const LONGE = 30 * 60 * 1000;

function marcarVistos() {
  if (!Array.isArray(vistos) || !configurado()) return;
  const salvos = ler(CHAVE_VISTOS, null) || vistos;
  gravar(CHAVE_VISTOS, [...new Set([...salvos, ...numerosComVeredito()])].slice(-2000));
}

function voltouDeLonge() {
  if (escondidoEm && Date.now() - escondidoEm > LONGE && Array.isArray(vistos)) vistos = ler(CHAVE_VISTOS, vistos);
}

// ------------------------------------------------------------------ textos (comentarios) com cache

// A chave e o numero de comentarios: mudar uma etiqueta (como "instalado") nao invalida o texto guardado.
const textos = ler(CHAVE_TEXTOS, {});
const abertos = new Set();  // analises abertas com "Ver tudo" (sobrevive ao redesenho da lista)

function textoEmCache(issue) {
  const c = textos[issue.number];
  return c && c.n === issue.comments ? c.t : null;
}

async function carregarTexto(issue) {
  const comentarios = await gh(`${caminhoRepo()}/issues/${issue.number}/comments?per_page=50`);
  const meus = comentarios.filter((c) => (c.user?.login || '').toLowerCase() === dono());
  let escolhido = [...meus].reverse().find((c) => /^\s*\*\*(Vale a pena|Evite)\*\*/i.test(c.body || ''));
  if (!escolhido) escolhido = meus[meus.length - 1];
  const t = escolhido ? String(escolhido.body || '').trim() : '';
  textos[issue.number] = { n: issue.comments, t };
  // guarda so os 150 mais novos
  const chaves = Object.keys(textos).map(Number).sort((a, b) => b - a);
  for (const k of chaves.slice(150)) delete textos[k];
  gravar(CHAVE_TEXTOS, textos);
  return t;
}

async function emParalelo(itens, limite, fn) {
  const fila = [...itens];
  const trabalhadores = Array.from({ length: Math.min(limite, fila.length) }, async () => {
    while (fila.length) await fn(fila.shift());
  });
  await Promise.all(trabalhadores);
}

// ------------------------------------------------------------------ avisos

function avisar(texto, tipo = '') {
  const e = $('aviso');
  e.textContent = texto;
  e.dataset.tipo = tipo;
  e.hidden = !texto;
}

// Mensagens de baixo, uma de cada vez. A de "Desfazer" fica mais tempo e nao e atropelada pelas outras.
const filaToasts = [];
let toastAtivo = null;

function toast(texto, { acao = null, aoTocar = null, ms = 2600 } = {}) {
  const t = { texto, acao, aoTocar, ms };
  if (acao && toastAtivo && !toastAtivo.acao) {
    filaToasts.unshift(t);  // o "Desfazer" entra na hora, no lugar de uma mensagem simples
    proximoToast();
    return;
  }
  filaToasts.push(t);
  if (!toastAtivo) proximoToast();
}

function proximoToast() {
  const e = $('toast');
  if (toastAtivo) clearTimeout(toastAtivo.tempo);
  const t = filaToasts.shift();
  toastAtivo = t || null;
  if (!t) {
    e.classList.remove('visivel');
    setTimeout(() => { if (!toastAtivo) e.hidden = true; }, 250);
    return;
  }
  e.replaceChildren(el('span', 'toast-texto', t.texto));
  if (t.acao) {
    const b = botao('toast-acao', t.acao);
    b.addEventListener('click', () => {
      proximoToast();
      t.aoTocar();
    }, { once: true });
    e.append(b);
  }
  e.hidden = false;
  requestAnimationFrame(() => e.classList.add('visivel'));
  // Uma mensagem simples com outra esperando sai mais cedo; a de "Desfazer" fica o tempo todo.
  t.tempo = setTimeout(proximoToast, !t.acao && filaToasts.length ? 1400 : t.ms);
}

const vibrar = () => {
  // O Chrome so deixa vibrar depois de um toque na pagina; antes disso, nem tenta.
  if (!navigator.userActivation?.hasBeenActive) return;
  try { navigator.vibrate?.(15); } catch { /* sem vibracao */ }
};

const podeCopiar = () => Boolean(navigator.clipboard?.writeText) && window.isSecureContext;

async function copiar(texto, aviso) {
  try {
    await navigator.clipboard.writeText(texto);
    toast(aviso);
    vibrar();
  } catch {
    avisar('O celular não deixou copiar. Toque e segure no texto para copiar.', 'erro');
  }
}

function mostrarConexao() {
  $('offline').hidden = navigator.onLine !== false;
}

// ------------------------------------------------------------------ instalar o app

let pedidoInstalar = null;
const instaladoNoCelular = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function prepararInstalacao() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();  // o Chrome mostra o pedido quando ele tocar em "Instalar"
    pedidoInstalar = e;
    const adiado = Date.now() - ler(CHAVE_INSTALAR_DEPOIS, 0) < INSTALAR_DEPOIS_MS;
    $('instalar-app').hidden = instaladoNoCelular() || adiado;
  });
  $('instalar-depois').addEventListener('click', () => {
    gravar(CHAVE_INSTALAR_DEPOIS, Date.now());
    $('instalar-app').hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    pedidoInstalar = null;
    $('instalar-app').hidden = true;
    toast('Instalado. Agora o Garimpo aparece no Compartilhar.');
  });
  $('instalar').addEventListener('click', async () => {
    if (!pedidoInstalar) return;
    pedidoInstalar.prompt();
    try { await pedidoInstalar.userChoice; } catch { /* cancelou */ }
    pedidoInstalar = null;
    $('instalar-app').hidden = true;
  });
}

// ------------------------------------------------------------------ configuracao

function mostrarConfig(abrir, { comErro = false } = {}) {
  $('config').hidden = !abrir;
  $('abrir-config').setAttribute('aria-expanded', String(abrir));
  if (!abrir) return;
  const c = config() || {};
  $('repo').value = c.repo || '';
  $('token').value = c.token ? '••••••••' : '';
  $('token').dataset.salvo = c.token ? 'sim' : '';
  const ok = configurado() && !comErro;
  $('apagar-config').hidden = !c.token;
  $('conectado').hidden = !ok;
  $('conectado').textContent = ok ? `Conectado a ${c.repo}` : '';
  $('config').dataset.conectado = ok ? 'sim' : '';
  (c.repo ? $('token') : $('repo')).focus({ preventScroll: true });
}

async function colarToken() {
  try {
    const texto = (await navigator.clipboard.readText()).trim();
    const m = texto.match(/(github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)/);
    if (!m) {
      avisar('Não achei um token na área de transferência. Copie o token no GitHub e toque em Colar de novo.', 'erro');
      return;
    }
    $('token').value = m[1];
    $('token').dataset.salvo = '';
    avisar('');
    toast('Token colado');
  } catch {
    avisar('O celular não deixou ler a área de transferência. Toque e segure no campo do token e escolha Colar.', 'erro');
  }
}

async function salvarConfig(evento) {
  evento.preventDefault();
  const repo = $('repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  const campoToken = $('token');
  const anterior = config();
  const token = campoToken.dataset.salvo && campoToken.value === '••••••••' ? anterior.token : campoToken.value.trim();
  if (!RE_REPO.test(repo)) {
    avisar('O repositório fica no formato usuario/nome, por exemplo usuario/garimpo-fila.', 'erro');
    $('repo').focus();
    return;
  }
  if (!token) {
    avisar('Cole o token do GitHub.', 'erro');
    campoToken.focus();
    return;
  }
  const b = $('salvar-config');
  b.disabled = true;
  // Grava para o teste usar; se o token ou o repositorio nao servirem, volta a configuracao anterior.
  gravar(CHAVE_CONFIG, { repo, token });
  avisar('Testando…');
  try {
    const info = await gh(`/repos/${repo}`);
    if (!info.private) {
      gravar(CHAVE_CONFIG, anterior);
      avisar('Este repositório é PÚBLICO: qualquer um veria os seus links e notas. Deixe ele privado no GitHub e salve de novo.', 'erro');
      return;
    }
    if (anterior && anterior.repo !== repo) {  // outra fila: o que estava guardado era da antiga
      issues = [];
      vistos = null;
      gravar(CHAVE_VISTOS, null);
      gravar(CHAVE_ISSUES, null);
    }
    campoToken.dataset.salvo = 'sim';
    avisar('');
    toast('Conectado. Agora é só compartilhar os vídeos com o Garimpo.');
    mostrarConfig(false);
    await reenviarPendentes();
    carregarFila();
  } catch (e) {
    if (e.rede) {
      avisar('Sem conexão para testar agora. A configuração ficou salva e será usada quando a internet voltar.', 'erro');
    } else {
      gravar(CHAVE_CONFIG, anterior);
      avisar(e.message, 'erro');
    }
  } finally {
    b.disabled = false;
  }
}

function apagarConfig() {
  for (const k of [CHAVE_CONFIG, CHAVE_TEXTOS, CHAVE_ISSUES, CHAVE_VISTOS, CHAVE_ATUALIZADO, CHAVE_RODADA]) gravar(k, null);
  for (const k of Object.keys(textos)) delete textos[k];
  $('repo').value = '';
  $('token').value = '';
  $('token').dataset.salvo = '';
  $('conectado').hidden = true;
  $('apagar-config').hidden = true;
  $('config').dataset.conectado = '';
  issues = [];
  vistos = null;
  ultimaCargaOk = 0;
  desenharFila();
  avisar('Repositório e token apagados deste celular.', 'ok');
}

// ------------------------------------------------------------------ enviar

// Ve se o link ja esta na fila ou ja foi analisado; se nao, cria a issue. Com "lista", usa ela em vez de buscar
// de novo (varios links colados de uma vez).
async function enviarLink(link, nota = '', lista = null) {
  const todas = lista || await buscarIssues();
  if (!lista) issues = todas;
  const mesmo = todas.filter((i) => acharLink(i.title) === link);
  const analisada = mesmo.find(temVeredito);
  if (analisada) return { issue: analisada, ja: 'analisada' };
  const aberta = mesmo.find((i) => i.state === 'open');
  if (aberta) return { issue: aberta, ja: 'na-fila' };
  const issue = await gh(`${caminhoRepo()}/issues`, { metodo: 'POST', corpo: { title: link, body: nota } });
  issues = [issue, ...issues];
  guardarIssues(issues);
  return { issue, ja: null };
}

function guardarPendente(link, nota = '') {
  const lista = ler(CHAVE_PENDENTES, []);
  if (!lista.some((p) => p.link === link)) lista.push({ link, nota, quando: new Date().toISOString() });
  gravar(CHAVE_PENDENTES, lista);
  mostrarPendentes();
}

function mostrarPendentes() {
  const lista = ler(CHAVE_PENDENTES, []);
  $('secao-pendentes').hidden = lista.length === 0;
  $('lista-pendentes').replaceChildren(...lista.map((p) => el('li', '', linkCurto(p.link))));
}

async function reenviarPendentes() {
  const lista = ler(CHAVE_PENDENTES, []);
  if (!lista.length || !configurado()) return;
  const sobrou = [];
  let enviados = 0;
  let erro = null;
  for (const p of lista) {
    if (erro) { sobrou.push(p); continue; }
    try {
      const r = await enviarLink(p.link, p.nota);
      enviados += 1;
      if (p.link === linkAtual) mostrarEnviado(r);
    } catch (e) {
      erro = e;
      sobrou.push(p);
    }
  }
  gravar(CHAVE_PENDENTES, sobrou);
  mostrarPendentes();
  if (erro && !erro.rede) avisar(erro.message, 'erro');  // sem internet, o cartao "Ainda nao enviados" ja diz
  else if (enviados) toast(enviados === 1 ? '1 link enviado para a fila' : `${enviados} links enviados para a fila`);
  if (enviados) desenharFila();
}

// ------------------------------------------------------------------ compartilhar (o video que chegou)

let issueAtual = null;
let linkAtual = null;

function estadoRecebido(texto, tipo, selo) {
  const estado = $('estado-compartilhado');
  estado.textContent = texto;
  estado.dataset.tipo = tipo;
  $('selo').dataset.tipo = selo;
}

function blocoDeAnalise(issue, corpo) {
  const caixa = el('div', 'analise');
  caixa.dataset.tipo = ROTULO_SITUACAO[situacao(issue)][1];
  caixa.dataset.numero = issue.number;
  preencherAnalise(caixa, corpo);
  return caixa;
}

async function mostrarEnviado({ issue, ja }) {
  issueAtual = issue;
  vibrar();
  const caixa = $('veredito-anterior');
  caixa.hidden = true;
  $('andamento-compartilhado').replaceChildren();
  if (ja === 'analisada') {
    const [texto, tipo] = ROTULO_SITUACAO[situacao(issue)];
    estadoRecebido(`Já analisado: ${texto}`, tipo, tipo);
    $('titulo-compartilhado').textContent = rotulo(issue) || 'Vídeo recebido';
    $('form-nota').hidden = true;
    $('dica-compartilhado').hidden = true;
    caixa.hidden = false;
    let corpo = textoEmCache(issue);
    if (corpo === null) {
      caixa.replaceChildren(el('p', 'suave pequeno', 'Carregando a análise…'));
      try {
        corpo = await carregarTexto(issue);
      } catch (e) {
        caixa.replaceChildren(el('p', 'suave pequeno', e.message));
        return;
      }
    }
    caixa.replaceChildren(blocoDeAnalise(issue, corpo));
    return;
  }
  $('titulo-compartilhado').textContent = 'Vídeo recebido';
  estadoRecebido(ja === 'na-fila' ? `Já estava na fila (#${issue.number})` : 'Na fila', 'ok', 'ok');
  $('andamento-compartilhado').replaceChildren(andamento(situacao(issue)));
  $('dica-compartilhado').hidden = false;
  $('nota').value = issue.body || '';
  $('form-nota').hidden = false;
}

async function receber(link, nota = '') {
  $('compartilhado').hidden = false;
  $('link-compartilhado').textContent = link;
  $('form-nota').hidden = true;
  $('veredito-anterior').hidden = true;
  $('dica-compartilhado').hidden = true;
  $('andamento-compartilhado').replaceChildren();
  $('titulo-compartilhado').textContent = 'Vídeo recebido';
  issueAtual = null;
  linkAtual = link;
  if (!configurado()) {
    guardarPendente(link, nota);
    estadoRecebido('Guardado neste celular. Configure o GitHub para enviar.', 'erro', 'espera');
    mostrarConfig(true);
    return;
  }
  estadoRecebido('Enviando…', '', 'espera');
  try {
    await mostrarEnviado(await enviarLink(link, nota));
    desenharFila();
  } catch (e) {
    guardarPendente(link, nota);
    estadoRecebido(e.rede ? 'Sem conexão: guardado neste celular, vai depois.' : e.message, 'erro', 'erro');
    if (e.token) mostrarConfig(true, { comErro: true });
  }
}

async function salvarNota(evento) {
  evento.preventDefault();
  if (!issueAtual) return;
  const b = $('form-nota').querySelector('button');
  b.disabled = true;
  try {
    const nota = $('nota').value.trim().slice(0, 500);
    issueAtual = await gh(`${caminhoRepo()}/issues/${issueAtual.number}`, { metodo: 'PATCH', corpo: { body: nota } });
    issues = issues.map((i) => (i.number === issueAtual.number ? issueAtual : i));
    guardarIssues(issues);
    desenharFila();
    toast('Nota salva');
  } catch (e) {
    avisar(e.message, 'erro');
  } finally {
    b.disabled = false;
  }
}

// Varios links colados de uma vez: busca a lista uma vez so e manda um por um.
async function mandarVarios(links) {
  if (!configurado()) {
    links.forEach((l) => guardarPendente(l));
    avisar(`${links.length} links guardados neste celular. Configure o GitHub para enviar.`, 'erro');
    mostrarConfig(true);
    return;
  }
  const b = $('form-colar').querySelector('button');
  b.disabled = true;
  toast(`Mandando ${links.length} links…`);
  let novos = 0;
  let ja = 0;
  let erro = null;
  try {
    issues = await buscarIssues();
    for (const l of links) {
      if (erro) { guardarPendente(l); continue; }
      try {
        const r = await enviarLink(l, '', issues);
        if (r.ja) ja += 1;
        else novos += 1;
      } catch (e) {
        erro = e;
        guardarPendente(l);
      }
    }
  } catch (e) {
    erro = e;
    links.forEach((l) => guardarPendente(l));
  } finally {
    b.disabled = false;
  }
  desenharFila();
  const partes = [];
  if (novos) partes.push(novos === 1 ? '1 novo na fila' : `${novos} novos na fila`);
  if (ja) partes.push(ja === 1 ? '1 já estava lá' : `${ja} já estavam lá`);
  if (partes.length) toast(partes.join(', '));
  if (erro) avisar(erro.rede ? 'Sem conexão: os links que faltaram ficaram guardados neste celular.' : erro.message, 'erro');
}

function colar(evento) {
  evento.preventDefault();
  const campo = $('link-colado');
  const links = acharLinks(campo.value);
  if (!links.length) {
    avisar('Isso não parece um link. Cole o endereço do vídeo, começando com https://', 'erro');
    campo.focus();
    return;
  }
  campo.value = '';
  campo.blur();
  avisar('');
  if (links.length > 1) {
    mandarVarios(links);
    return;
  }
  receber(links[0]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------------ estado da lista

let issues = [];
let vista = ler(CHAVE_VISTA, 'videos');
let filtro = ler(CHAVE_FILTRO, 'tudo');
let filtroCaixa = 'todas';
let projeto = null;          // etiqueta de projeto tocada (filtra as duas vistas)
let busca = '';
let buscaAberta = false;
let carregando = false;
let editandoNota = null;     // numero da issue com a nota aberta para editar
let ultimaCarga = 0;                          // ultima tentativa (para nao buscar de novo a toda hora)
let ultimaCargaOk = ler(CHAVE_ATUALIZADO, 0);  // ultima vez que a lista veio do GitHub

function visiveis() {
  return issues.filter((i) => situacao(i) !== 'removido');
}

const mesmoProjeto = (a, b) => semAcento(a).trim() === semAcento(b).trim();

function temProjeto(i) {
  if (!projeto) return true;
  const corpo = textoEmCache(i);
  return Boolean(corpo) && partesDoVeredito(corpo).para.some((p) => mesmoProjeto(p, projeto));
}

function bateBusca(...textosAlvo) {
  const termo = semAcento(busca.trim());
  return !termo || semAcento(textosAlvo.join(' ')).includes(termo);
}

function contagens() {
  const c = { novos: 0, tudo: 0, fila: 0, esperando: 0, vale: 0, evite: 0, falhou: 0 };
  for (const i of visiveis()) {
    c.tudo += 1;
    c[situacao(i)] += 1;
    if (ehNovo(i)) c.novos += 1;
  }
  return c;
}

function filtrados() {
  return visiveis().filter((i) => {
    if (filtro === 'novos' && !ehNovo(i)) return false;
    if (!['tudo', 'novos'].includes(filtro) && situacao(i) !== filtro) return false;
    if (!temProjeto(i)) return false;
    return bateBusca(i.title, i.body, textoEmCache(i) || '');
  });
}

// ------------------------------------------------------------------ caixa de ferramentas

// Os "Vale a pena" agrupados pelo nome da ferramenta (dois videos do mesmo Context7 viram um cartao so).
const chaveDoNome = (i) => semAcento(rotulo(i)).replace(/\s+/g, ' ').trim() || acharLink(i.title) || `#${i.number}`;

function caixaDeFerramentas() {
  const grupos = new Map();
  for (const i of visiveis()) {
    if (situacao(i) !== 'vale') continue;
    const k = chaveDoNome(i);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(i);
  }
  return [...grupos.entries()].map(([chave, lista]) => {
    lista.sort(maisNovoPrimeiro);
    const comTexto = lista.find((i) => textoEmCache(i) !== null);
    return {
      chave,
      issues: lista,
      principal: lista[0],
      nome: rotulo(lista[0]) || 'Ferramenta',
      instalada: lista.some(instalada),       // basta um video do grupo marcado
      novo: lista.some(ehNovo),
      partes: comTexto ? partesDoVeredito(textoEmCache(comTexto)) : null,
    };
  });
}

function ferramentasFiltradas(grupos) {
  return grupos.filter((g) => {
    if (filtroCaixa === 'instalar' && g.instalada) return false;
    if (filtroCaixa === 'instaladas' && !g.instalada) return false;
    if (projeto && !(g.partes?.para || []).some((p) => mesmoProjeto(p, projeto))) return false;
    return bateBusca(g.nome, ...g.issues.map((i) => `${i.body || ''} ${textoEmCache(i) || ''}`));
  }).sort((a, b) => Number(a.instalada) - Number(b.instalada) || maisNovoPrimeiro(a.principal, b.principal));
}

// ------------------------------------------------------------------ pedacos do desenho

function botaoAcao(texto, acao, numero, { extra = '', icon = null } = {}) {
  const b = botao(`acao ${extra}`.trim(), null, { acao, numero });
  if (icon) b.append(icone(icon, 15));
  b.append(el('span', 'acao-texto', texto));
  return b;
}

function linkAcao(texto, href, icon) {
  const a = el('a', 'acao');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.append(icone(icon, 14), el('span', 'acao-texto', texto));
  return a;
}

// Recebido -> Download -> Analise, para o que ainda nao tem veredito.
const ETAPAS = { fila: ['feito', 'agora', ''], esperando: ['feito', 'feito', 'agora'], falhou: ['feito', 'erro', ''] };

function andamento(sit) {
  const ol = el('ol', 'etapas');
  ol.setAttribute('aria-label', 'Andamento');
  ['Recebido', 'Download', 'Análise'].forEach((nome, k) => {
    const li = el('li', '', nome);
    li.dataset.estado = ETAPAS[sit][k];
    if (ETAPAS[sit][k] === 'agora') li.setAttribute('aria-current', 'step');
    ol.append(li);
  });
  return ol;
}

function textoComVerTudo(classe, texto, chave, limite = LIMITE_TEXTO) {
  const p = el('p', classe, texto);
  if (texto.length <= limite) return [p];
  const aberto = abertos.has(chave);
  p.classList.toggle('fechado', !aberto);
  const b = botao('ver-tudo', aberto ? 'Ver menos' : 'Ver tudo', { acao: 'expandir', chave });
  b.setAttribute('aria-expanded', String(aberto));
  return [p, b];
}

const NOME_CONFIANCA = { alta: 'Confiança alta', media: 'Confiança média', baixa: 'Confiança baixa' };

function seloConfianca(nivel) {
  const s = el('span', 'confianca', NOME_CONFIANCA[nivel]);
  s.dataset.nivel = nivel;
  s.title = 'Quanto o Claude conseguiu conferir na fonte oficial';
  return s;
}

function linhaProjetos(para) {
  const linha = el('div', 'analise-linha');
  linha.append(el('span', 'analise-rotulo', 'Para'));
  for (const t of para) {
    const b = botao('tag', t, { acao: 'projeto', projeto: t });
    b.setAttribute('aria-pressed', String(Boolean(projeto) && mesmoProjeto(t, projeto)));
    b.setAttribute('aria-label', `Ver só o que serve para ${t}`);
    linha.append(b);
  }
  return linha;
}

function linhaComando(comando) {
  const linha = el('div', 'comando');
  linha.append(el('code', '', comando));
  if (podeCopiar()) {
    const b = botao('comando-copiar', null, { acao: 'copiar', texto: comando });
    b.setAttribute('aria-label', 'Copiar o comando');
    b.append(icone('copiar', 15));
    linha.append(b);
  }
  return linha;
}

function preencherAnalise(caixa, corpo) {
  const p = partesDoVeredito(corpo);
  caixa.classList.remove('analise-carregar');
  const filhos = [...textoComVerTudo('analise-texto', p.motivo || 'Sem texto na análise.', `a${caixa.dataset.numero}`)];
  if (p.custo || p.confianca) {
    const linha = el('div', 'analise-linha');
    if (p.custo) linha.append(el('span', 'analise-rotulo', 'Custo'), el('span', 'custo', p.custo));
    if (p.confianca) linha.append(seloConfianca(p.confianca));
    filhos.push(linha);
  }
  if (p.para.length) filhos.push(linhaProjetos(p.para));
  if (p.fonte) {
    const linha = el('div', 'analise-linha analise-fonte');
    const a = el('a', 'fonte');
    a.href = p.fonte;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.append(el('span', '', fonteCurta(p.fonte)), icone('externo', 13));
    linha.append(el('span', 'analise-rotulo', 'Fonte'), a);
    filhos.push(linha);
  }
  if (p.instalar) filhos.push(el('p', 'analise-rotulo analise-rotulo-bloco', 'Como instalar'), linhaComando(p.instalar));
  if (p.obs) filhos.push(el('p', 'analise-obs', p.obs));
  caixa.replaceChildren(...filhos);
}

function editorDeNota(issue) {
  const f = el('div', 'editar-nota');
  const ta = el('textarea');
  ta.rows = 2;
  ta.maxLength = 500;
  ta.value = issue.body || '';
  ta.placeholder = 'ex.: ver se serve pro Ultron';
  ta.setAttribute('aria-label', 'Nota para o Claude');
  const linha = el('div', 'linha-botoes');
  linha.append(botao('botao', 'Salvar nota', { acao: 'salvar-nota', numero: issue.number }),
    botao('botao botao-perigo', 'Cancelar', { acao: 'cancelar-nota', numero: issue.number }));
  f.append(ta, linha);
  return f;
}

function itemDaFila(issue) {
  const sit = situacao(issue);
  const [textoSit, tipo] = ROTULO_SITUACAO[sit];
  const link = acharLink(issue.title);
  const nome = rotulo(issue);
  const novo = ehNovo(issue);

  const li = el('li', 'item');
  li.dataset.situacao = sit;
  if (novo) li.dataset.novo = 'sim';

  const topo = el('div', 'item-topo');
  const marca = el('span', 'item-icone');
  marca.append(icone(sit, 16));
  const bloco = el('div', 'item-bloco');
  const titulo = el('p', 'item-titulo', nome || (link ? `Vídeo do ${plataforma(link)}` : issue.title));
  if (novo) titulo.append(' ', el('span', 'novo', 'Novo'));
  if (sit === 'vale' && instalada(issue)) titulo.append(' ', el('span', 'selo-instalada', 'Instalada'));
  const meta = el('p', 'item-meta');
  const st = el('span', 'status', textoSit);
  st.dataset.tipo = tipo;
  const analisado = temVeredito(issue) && issue.closed_at;
  const momento = `${analisado ? 'analisado' : 'enviado'} ${quando(analisado ? issue.closed_at : issue.created_at)}`;
  meta.append(st, el('span', 'sep', '·'), link ? plataforma(link) : 'sem link', el('span', 'sep', '·'), momento);
  bloco.append(titulo, meta);
  topo.append(marca, bloco);
  li.append(topo);

  const editavel = sit === 'fila' || sit === 'esperando';  // a nota so serve enquanto o PC ainda vai ler
  if (editavel && editandoNota === issue.number) {
    li.append(editorDeNota(issue));
  } else if (issue.body) {
    const nota = el('p', 'item-nota');
    nota.append(el('span', 'item-nota-rotulo', 'Sua nota'), issue.body);
    li.append(nota);
  }

  if (['vale', 'evite', 'falhou'].includes(sit) && issue.comments > 0) {
    const corpo = textoEmCache(issue);
    if (corpo !== null) {
      li.append(blocoDeAnalise(issue, corpo));
    } else {
      const caixa = el('div', 'analise analise-carregar');
      caixa.append(botaoAcao(sit === 'falhou' ? 'Ver o motivo' : 'Ver a análise', 'texto', issue.number, { extra: 'acao-link' }));
      li.append(caixa);
    }
  }

  if (ETAPAS[sit]) li.append(andamento(sit));

  const acoes = el('div', 'item-acoes');
  if (link) acoes.append(linkAcao('Abrir vídeo', link, 'abrir'));
  if (temVeredito(issue) && (navigator.share || podeCopiar())) {
    acoes.append(botaoAcao('Compartilhar', 'compartilhar', issue.number, { icon: 'compartilhar' }));
  }
  if (sit === 'falhou') acoes.append(botaoAcao('Tentar de novo', 'refazer', issue.number, { icon: 'tentar' }));
  if (editavel && editandoNota !== issue.number) {
    acoes.append(botaoAcao(issue.body ? 'Editar nota' : 'Nota', 'nota', issue.number, { icon: 'nota' }));
  }
  if (sit === 'fila' || sit === 'falhou') {
    const b = botaoAcao('Remover', 'remover', issue.number, { extra: 'acao-perigo acao-so-icone', icon: 'remover' });
    b.setAttribute('aria-label', 'Remover da fila');
    acoes.append(b);
  }
  if (acoes.childElementCount) li.append(acoes);
  return li;
}

function cartaoFerramenta(g) {
  const li = el('li', 'item ferramenta');
  li.dataset.situacao = 'vale';
  if (g.instalada) li.dataset.instalada = 'sim';
  if (g.novo) li.dataset.novo = 'sim';

  const topo = el('div', 'item-topo');
  const marcar = botao('marcar', null, { acao: 'marcar', chave: g.chave });
  marcar.setAttribute('aria-pressed', String(g.instalada));
  marcar.setAttribute('aria-label', g.instalada ? `${g.nome} está instalada. Tocar desmarca.` : `Marcar ${g.nome} como instalada`);
  marcar.append(icone('vale', 16));
  const bloco = el('div', 'item-bloco');
  const titulo = el('p', 'item-titulo', g.nome);
  if (g.novo) titulo.append(' ', el('span', 'novo', 'Novo'));
  const meta = el('p', 'item-meta');
  const st = el('span', 'status', g.instalada ? 'Instalada' : 'Para instalar');
  st.dataset.tipo = g.instalada ? 'ok' : 'espera';
  meta.append(st);
  if (g.partes?.custo) meta.append(el('span', 'sep', '·'), el('span', 'custo', g.partes.custo));
  if (g.partes?.confianca) meta.append(el('span', 'sep', '·'), seloConfianca(g.partes.confianca));
  if (g.issues.length > 1) meta.append(el('span', 'sep', '·'), `${g.issues.length} vídeos`);
  bloco.append(titulo, meta);
  topo.append(marcar, bloco);
  li.append(topo);

  if (!g.partes) {
    const caixa = el('div', 'analise analise-carregar');
    caixa.append(botaoAcao('Ver detalhes', 'texto', g.principal.number, { extra: 'acao-link' }));
    li.append(caixa);
  } else {
    const corpo = el('div', 'ferramenta-corpo');
    if (g.partes.motivo) corpo.append(...textoComVerTudo('ferramenta-motivo', g.partes.motivo, `f${g.chave}`, 140));
    if (g.partes.para.length) corpo.append(linhaProjetos(g.partes.para));
    if (g.partes.instalar && !g.instalada) corpo.append(linhaComando(g.partes.instalar));
    li.append(corpo);
  }

  const acoes = el('div', 'item-acoes');
  if (g.partes?.fonte) acoes.append(linkAcao('Fonte', g.partes.fonte, 'externo'));
  const link = acharLink(g.principal.title);
  if (link) acoes.append(linkAcao('Vídeo', link, 'abrir'));
  if (navigator.share || podeCopiar()) {
    const b = botaoAcao('Compartilhar', 'compartilhar', g.principal.number, { extra: 'acao-so-icone', icon: 'compartilhar' });
    b.setAttribute('aria-label', `Compartilhar o veredito de ${g.nome}`);
    acoes.append(b);
  }
  li.append(acoes);
  return li;
}

// ------------------------------------------------------------------ desenho

function chipFiltro(chave, nome, n, ativo, extra = '') {
  const b = botao(`filtro ${extra}`.trim(), null, { filtro: chave });
  b.setAttribute('aria-pressed', String(ativo));
  b.append(nome);
  if (n !== null) b.append(el('span', 'filtro-n', String(n)));
  return b;
}

function chipProjeto() {
  const b = botao('filtro filtro-projeto', null, { filtro: '__projeto' });
  b.setAttribute('aria-label', `Tirar o filtro do projeto ${projeto}`);
  b.append(el('span', '', projeto), icone('evite', 13));
  return b;
}

// O PC grava a hora de cada rodada automatica na descricao da etiqueta "baixado" (marcar_rodada() no
// fila_github.py). Sem a etiqueta ou sem internet, fica a ultima hora conhecida.
async function lerRodadaPC() {
  try {
    const l = await gh(`${caminhoRepo()}/labels/baixado`);
    const m = /ultima rodada (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)(?: (\w+))?/.exec((l && l.description) || '');
    if (m) gravar(CHAVE_RODADA, { quando: m[1], resultado: m[2] || 'ok' });
  } catch {
    // a lista continua normal; so a dica fica sem a hora do PC
  }
}

// Ha quanto tempo o mais antigo dos prontos foi mandado: lembra que tem video parado esperando a analise no PC.
function esperaDesde() {
  const datas = visiveis().filter((i) => situacao(i) === 'esperando' && i.created_at).map((i) => i.created_at).sort();
  if (!datas.length || Date.now() - new Date(datas[0]).getTime() < 3600 * 1000) return '';
  return ` (mandado ${quando(datas[0]).replace(/\.$/, '')})`;
}

function textoNaFila(n) {
  const qtos = n === 1 ? '1 na fila' : `${n} na fila`;
  const r = ler(CHAVE_RODADA, null);
  const hora = r && typeof r === 'object' ? r.quando : r;
  const min = hora ? (Date.now() - new Date(hora).getTime()) / 60000 : NaN;
  if (Number.isNaN(min)) return `${qtos}: o PC baixa sozinho.`;
  const q = quando(hora);
  const desde = (q.startsWith('em ') ? `desde ${q.slice(3)}` : q).replace(/\.$/, '');  // "há 10 min." -> "há 10 min"
  if (min > PC_PARADO_MIN) return `${qtos}, mas o PC não baixa ${desde}: ele está ligado?`;
  if (r && r.resultado === 'erro') return `${qtos}: o PC rodou ${desde}, mas deu erro. No PC, pergunte ao Claude “como tá a fila?”.`;
  return `${qtos}: o PC baixa sozinho (última vez ${desde}).`;
}

function desenharVideos() {
  const c = contagens();
  if (filtro === 'novos' && !c.novos) filtro = 'tudo';
  const chips = FILTROS.filter(([k]) => k === 'tudo' || k === filtro || c[k] > 0)
    .map(([k, nome]) => chipFiltro(k, nome, c[k], k === filtro, k === 'novos' ? 'filtro-novos' : ''));
  $('filtros').replaceChildren(...(projeto ? [chipProjeto()] : []), ...chips);
  const partesResumo = [c.tudo === 1 ? '1 vídeo' : `${c.tudo} vídeos`];
  if (c.vale) partesResumo.push(`${c.vale} Vale a pena`);
  if (c.evite) partesResumo.push(`${c.evite} Evite`);
  $('resumo').textContent = c.tudo ? partesResumo.join(' · ') : '';

  const lista = filtrados().sort(maisNovoPrimeiro);
  const nos = [];
  let grupo = null;
  for (const i of lista) {
    const g = grupoDaData(dataDoItem(i));
    if (g !== grupo) {
      grupo = g;
      const cab = el('li', 'grupo');
      cab.append(el('h3', '', g));
      nos.push(cab);
    }
    nos.push(itemDaFila(i));
  }
  $('fila').replaceChildren(...nos);

  // Na fila: o PC baixa sozinho. Esperando analise: ja esta baixado, falta pedir no Claude Code.
  const dicas = [];
  if (c.fila) dicas.push(textoNaFila(c.fila));
  if (c.esperando) dicas.push(`${c.esperando === 1 ? '1 pronto' : `${c.esperando} prontos`}${esperaDesde()}: peça “analisa os vídeos novos”.`);
  $('dica-fila').hidden = !dicas.length || !['tudo', 'fila', 'esperando'].includes(filtro) || Boolean(busca) || Boolean(projeto);
  $('dica-fila-texto').textContent = dicas.join(' ');

  let titulo = 'Nenhum vídeo nesta situação';
  let texto = 'Escolha outro filtro acima.';
  if (!configurado()) {
    titulo = 'Falta conectar o GitHub';
    texto = 'Siga os passos da configuração para ver a sua fila.';
  } else if (!visiveis().length) {
    titulo = 'Nada garimpado ainda';
    texto = 'No Instagram, toque em Compartilhar e escolha Garimpo. Ou cole um link acima.';
  } else if (busca) {
    titulo = 'Nada encontrado';
    texto = 'Tente outra palavra: o nome da ferramenta, da nota ou da análise.';
  } else if (projeto) {
    titulo = `Nada para ${projeto} aqui`;
    texto = 'Toque no projeto acima para ver tudo de novo.';
  }
  mostrarVazio(lista.length, titulo, texto);
  return c;
}

function desenharCaixa() {
  const grupos = caixaDeFerramentas();
  const n = { todas: grupos.length, instaladas: grupos.filter((g) => g.instalada).length };
  n.instalar = n.todas - n.instaladas;
  const chips = FILTROS_CAIXA.map(([k, nome]) => chipFiltro(k, nome, n[k], k === filtroCaixa));
  $('filtros').replaceChildren(...(projeto ? [chipProjeto()] : []), ...chips);
  $('dica-fila').hidden = true;

  const lista = ferramentasFiltradas(grupos);
  $('fila').replaceChildren(...lista.map(cartaoFerramenta));
  const resumo = $('resumo');
  resumo.textContent = !grupos.length ? '' : `${n.todas === 1 ? '1 ferramenta vale' : `${n.todas} ferramentas valem`} a pena · `
    + `${n.instaladas} de ${n.todas} instalada${n.todas === 1 ? '' : 's'}`
    + (n.instalar ? '. Toque no círculo quando instalar.' : '');

  let titulo = 'Nada nesta lista';
  let texto = 'Escolha outro filtro acima.';
  if (!grupos.length) {
    titulo = 'Nenhuma ferramenta ainda';
    texto = 'O que o Claude julgar “Vale a pena” aparece aqui, com o comando para instalar.';
  } else if (busca) {
    titulo = 'Nada encontrado';
    texto = 'Tente outra palavra.';
  } else if (projeto) {
    titulo = `Nada para ${projeto} aqui`;
    texto = 'Toque no projeto acima para ver tudo de novo.';
  } else if (filtroCaixa === 'instalar') {
    titulo = 'Tudo instalado';
    texto = 'Todas as ferramentas que valem a pena já estão marcadas como instaladas.';
  }
  mostrarVazio(lista.length, titulo, texto);
}

function mostrarVazio(quantos, titulo, texto) {
  $('fila-vazia').hidden = quantos > 0 || carregando;
  $('fila-vazia-titulo').textContent = titulo;
  $('fila-vazia-texto').textContent = texto;
}

function desenharFila() {
  // O redesenho recria os cartoes: guarda o que ele estava digitando na nota.
  const ta = document.querySelector('.editar-nota textarea');
  const rascunho = ta ? { valor: ta.value, foco: document.activeElement === ta, pos: ta.selectionStart } : null;

  for (const b of $('vistas').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.vista === vista));
  $('titulo-vista').textContent = vista === 'ferramentas' ? 'Caixa de ferramentas' : 'Vídeos';
  $('atualizar').hidden = !configurado();  // sem GitHub conectado, nao ha o que atualizar
  $('n-ferramentas').textContent = String(caixaDeFerramentas().length || '');
  const c = vista === 'ferramentas' ? (desenharCaixa(), contagens()) : desenharVideos();
  $('n-novos').textContent = c.novos ? String(c.novos) : '';
  $('busca').hidden = !(buscaAberta || busca);
  $('abrir-busca').setAttribute('aria-expanded', String(!$('busca').hidden));

  if (rascunho) {
    const novo = document.querySelector('.editar-nota textarea');
    if (novo) {
      novo.value = rascunho.valor;
      if (rascunho.foco) {
        novo.focus({ preventScroll: true });
        novo.setSelectionRange(rascunho.pos, rascunho.pos);
      }
    }
  }
  mostrarAtualizado();
  document.title = c.novos ? `(${c.novos}) Garimpo` : 'Garimpo';
  try {
    if (c.novos) navigator.setAppBadge?.(c.novos)?.catch(() => {});
    else navigator.clearAppBadge?.()?.catch(() => {});
  } catch { /* sem selo no icone */ }
}

function mostrarAtualizado() {
  $('atualizado').textContent = ultimaCargaOk && configurado()
    ? `Atualizado ${quando(new Date(ultimaCargaOk).toISOString())}` : '';
}

function trocarVista(nova) {
  if (nova === vista) return;
  vista = nova;
  gravar(CHAVE_VISTA, vista);
  busca = '';
  buscaAberta = false;
  $('busca').value = '';
  desenharFila();
  window.scrollTo({ top: 0 });
  completarTextos();
}

// Busca os textos dos vereditos que faltam, poucos por vez. Na Caixa de ferramentas, os "Vale a pena" primeiro.
async function completarTextos() {
  if (!configurado()) return;
  const primeiro = (i) => (vista === 'ferramentas' && situacao(i) === 'vale' ? 0 : 1);
  const faltam = visiveis()
    .filter((i) => ['vale', 'evite', 'falhou'].includes(situacao(i)) && i.comments > 0 && textoEmCache(i) === null)
    .sort((a, b) => primeiro(a) - primeiro(b) || maisNovoPrimeiro(a, b))
    .slice(0, MAX_TEXTOS_POR_VEZ);
  if (!faltam.length) return;
  await emParalelo(faltam, 4, async (i) => {
    try {
      await carregarTexto(i);
    } catch { /* fica com o botao "Ver a analise" */ }
  });
  desenharFila();
}

async function carregarFila() {
  if (!configurado() || carregando) return;
  carregando = true;
  ultimaCarga = Date.now();
  $('atualizar').disabled = true;
  $('atualizar').setAttribute('aria-busy', 'true');
  $('carregando').hidden = issues.length > 0;
  $('fila-vazia').hidden = true;
  try {
    [issues] = await Promise.all([buscarIssues(), lerRodadaPC()]);
    carregando = false;
    $('carregando').hidden = true;
    desenharFila();
    completarTextos();
  } catch (e) {
    if (!e.rede || !issues.length) avisar(e.message, 'erro');  // sem internet e com lista guardada: o selo do topo ja diz
    if (e.token) mostrarConfig(true, { comErro: true });
  } finally {
    carregando = false;
    $('carregando').hidden = true;
    $('atualizar').disabled = false;
    $('atualizar').removeAttribute('aria-busy');
    if (!issues.length) desenharFila();
  }
}

// ------------------------------------------------------------------ acoes

async function compartilharVeredito(issue) {
  const p = partesDoVeredito(textoEmCache(issue) || '');
  const nome = rotulo(issue) || 'Vídeo';
  const [veredito] = ROTULO_SITUACAO[situacao(issue)];
  const link = acharLink(issue.title);
  const texto = [`${nome}: ${veredito}`, p.motivo, p.custo ? `Custo: ${p.custo}` : '', p.fonte ? `Fonte: ${p.fonte}` : '']
    .filter(Boolean).join('\n\n');
  if (navigator.share) {
    try {
      await navigator.share({ title: nome, text: texto, url: link || undefined });
    } catch (e) {
      if (e.name !== 'AbortError') avisar('Não deu para compartilhar.', 'erro');
    }
    return;
  }
  copiar(link ? `${texto}\n\n${link}` : texto, 'Veredito copiado');
}

const comEtiqueta = (i, nome, por) => {
  const sem = (i.labels || []).filter((l) => (l.name || l) !== nome);
  return { ...i, labels: por ? [...sem, { name: nome }] : sem };
};

// "Instalei": poe (ou tira) a etiqueta "instalado" em todos os videos da ferramenta. A tela muda na hora e volta
// se o GitHub recusar.
async function marcarInstalada(g, por) {
  const numeros = new Set(g.issues.map((i) => i.number));
  const antes = issues;
  issues = issues.map((i) => (numeros.has(i.number) ? comEtiqueta(i, 'instalado', por) : i));
  desenharFila();
  vibrar();
  try {
    for (const n of numeros) {
      if (por) {
        await gh(`${caminhoRepo()}/issues/${n}/labels`, { metodo: 'POST', corpo: { labels: ['instalado'] } });
      } else {
        try {
          await gh(`${caminhoRepo()}/issues/${n}/labels/instalado`, { metodo: 'DELETE' });
        } catch (e) {
          if (e.status !== 404) throw e;  // 404: aquele video ja estava sem a etiqueta
        }
      }
    }
    guardarIssues(issues);
    toast(por ? `${g.nome}: instalada` : `${g.nome}: desmarcada`);
  } catch (e) {
    issues = antes;
    desenharFila();
    avisar(e.rede ? 'Sem conexão: não deu para marcar agora.' : e.message, 'erro');
  }
}

// Remover sai na hora e fica uns segundos com "Desfazer".
async function remover(issue) {
  const antes = issue;
  const n = issue.number;
  issues = issues.map((i) => (i.number === n ? { ...i, state: 'closed' } : i));
  desenharFila();
  try {
    await gh(`${caminhoRepo()}/issues/${n}`, { metodo: 'PATCH', corpo: { state: 'closed', state_reason: 'not_planned' } });
    guardarIssues(issues);
  } catch (e) {
    issues = issues.map((i) => (i.number === n ? antes : i));
    desenharFila();
    avisar(e.message, 'erro');
    return;
  }
  toast('Removido da fila', { acao: 'Desfazer', ms: 7000, aoTocar: () => desfazerRemocao(antes) });
}

async function desfazerRemocao(antes) {
  try {
    const volta = await gh(`${caminhoRepo()}/issues/${antes.number}`, {
      metodo: 'PATCH', corpo: { state: 'open', state_reason: 'reopened' },
    });
    issues = issues.map((i) => (i.number === antes.number ? { ...antes, updated_at: volta?.updated_at || antes.updated_at } : i));
    guardarIssues(issues);
    desenharFila();
    toast('Voltou para a fila');
  } catch (e) {
    avisar(`Não deu para desfazer: ${e.message}`, 'erro');
  }
}

async function salvarNotaDaLista(b, issue) {
  const ta = b.closest('.item').querySelector('.editar-nota textarea');
  b.disabled = true;
  try {
    const atual = await gh(`${caminhoRepo()}/issues/${issue.number}`, {
      metodo: 'PATCH', corpo: { body: ta.value.trim().slice(0, 500) },
    });
    issues = issues.map((i) => (i.number === issue.number ? { ...i, body: atual.body, updated_at: atual.updated_at } : i));
    editandoNota = null;
    guardarIssues(issues);
    desenharFila();
    toast('Nota salva');
  } catch (e) {
    avisar(e.message, 'erro');
    b.disabled = false;
  }
}

async function agir(evento) {
  const b = evento.target.closest('button[data-acao]');
  if (!b) return;
  const acao = b.dataset.acao;

  if (acao === 'expandir') {
    const aberto = b.getAttribute('aria-expanded') !== 'true';
    if (aberto) abertos.add(b.dataset.chave);
    else abertos.delete(b.dataset.chave);
    b.previousElementSibling.classList.toggle('fechado', !aberto);
    b.setAttribute('aria-expanded', String(aberto));
    b.textContent = aberto ? 'Ver menos' : 'Ver tudo';
    return;
  }
  if (acao === 'copiar') {
    copiar(b.dataset.texto, 'Comando copiado');
    return;
  }
  if (acao === 'projeto') {
    projeto = projeto && mesmoProjeto(projeto, b.dataset.projeto) ? null : b.dataset.projeto;
    desenharFila();
    $('filtros').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  if (acao === 'marcar') {
    const g = caixaDeFerramentas().find((x) => x.chave === b.dataset.chave);
    if (g) marcarInstalada(g, !g.instalada);
    return;
  }

  const numero = Number(b.dataset.numero);
  const issue = issues.find((i) => i.number === numero) || (issueAtual?.number === numero ? issueAtual : null);
  if (!issue) return;

  if (acao === 'texto') {
    b.disabled = true;
    b.querySelector('.acao-texto').textContent = 'Carregando…';
    try {
      await carregarTexto(issue);
      desenharFila();
    } catch (e) {
      avisar(e.message, 'erro');
      b.disabled = false;
    }
    return;
  }
  if (acao === 'compartilhar') {
    compartilharVeredito(issue);
    return;
  }
  if (acao === 'nota') {
    editandoNota = numero;
    desenharFila();
    document.querySelector('.editar-nota textarea')?.focus();
    return;
  }
  if (acao === 'cancelar-nota') {
    editandoNota = null;
    desenharFila();
    return;
  }
  if (acao === 'salvar-nota') {
    salvarNotaDaLista(b, issue);
    return;
  }
  if (acao === 'remover') {
    remover(issue);
    return;
  }
  if (acao === 'refazer') {
    b.disabled = true;
    try {
      await gh(`${caminhoRepo()}/issues/${numero}/labels/falhou`, { metodo: 'DELETE' });
      issues = issues.map((i) => (i.number === numero ? comEtiqueta(i, 'falhou', false) : i));
      guardarIssues(issues);
      toast('Volta para a fila');
      desenharFila();
    } catch (e) {
      avisar(e.message, 'erro');
      b.disabled = false;
    }
  }
}

// ------------------------------------------------------------------ inicio

function iniciar() {
  $('abrir-config').addEventListener('click', () => mostrarConfig($('config').hidden));
  $('form-config').addEventListener('submit', salvarConfig);
  $('apagar-config').addEventListener('click', apagarConfig);
  $('colar-token').addEventListener('click', colarToken);
  $('form-colar').addEventListener('submit', colar);
  $('form-nota').addEventListener('submit', salvarNota);
  $('atualizar').addEventListener('click', carregarFila);
  $('reenviar').addEventListener('click', reenviarPendentes);
  $('fila').addEventListener('click', agir);
  $('compartilhado').addEventListener('click', agir);
  $('vistas').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-vista]');
    if (b) trocarVista(b.dataset.vista);
  });
  $('filtros').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filtro]');
    if (!b) return;
    if (b.dataset.filtro === '__projeto') projeto = null;
    else if (vista === 'ferramentas') filtroCaixa = b.dataset.filtro;
    else {
      filtro = b.dataset.filtro;
      gravar(CHAVE_FILTRO, filtro);
    }
    desenharFila();
  });
  $('busca').addEventListener('input', (e) => {
    busca = e.target.value;
    desenharFila();
  });
  // A lupa nao tira o foco do campo ao ser tocada (senao o campo fecha antes do clique e ela abre de novo).
  $('abrir-busca').addEventListener('mousedown', (e) => e.preventDefault());
  $('abrir-busca').addEventListener('click', () => {
    buscaAberta = $('busca').hidden;
    if (!buscaAberta) {
      busca = '';
      $('busca').value = '';
    }
    desenharFila();
    if (buscaAberta) $('busca').focus();
  });
  // Campo vazio perdeu o foco: so esconde. Redesenhar aqui recriaria o chip ou botao que ele acabou de tocar.
  $('busca').addEventListener('blur', () => {
    if (busca) return;
    buscaAberta = false;
    $('busca').hidden = true;
    $('abrir-busca').setAttribute('aria-expanded', 'false');
  });
  $('token').addEventListener('focus', (e) => {
    if (e.target.dataset.salvo && e.target.value === '••••••••') e.target.select();
  });
  if (!navigator.clipboard?.readText) $('colar-token').hidden = true;
  // Primeiro manda o que estava guardado, depois busca a lista: assim ela ja vem com o que acabou de ir.
  window.addEventListener('online', () => { mostrarConexao(); reenviarPendentes().finally(carregarFila); });
  window.addEventListener('offline', mostrarConexao);
  // Saiu do app: grava os vereditos novos como vistos. Voltou depois de um tempo: atualiza sozinho.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      escondidoEm = Date.now();
      marcarVistos();
      return;
    }
    voltouDeLonge();
    if (Date.now() - ultimaCarga > 30000) carregarFila();
    else desenharFila();
  });
  window.addEventListener('pagehide', marcarVistos);
  setInterval(() => { if (document.visibilityState === 'visible') mostrarAtualizado(); }, 60000);
  prepararInstalacao();
  mostrarConexao();

  // Veio do "Compartilhar" ou de um atalho do icone? Le os parametros e limpa a barra de endereco, para
  // recarregar nao mandar de novo.
  const p = new URLSearchParams(location.search);
  const veio = p.has('text') || p.has('url') || p.has('title');
  const link = veio ? acharLink(p.get('url'), p.get('text'), p.get('title')) : null;
  const atalho = p.get('abrir');
  if (veio || atalho) history.replaceState(null, '', location.pathname);
  if (atalho === 'ferramentas') vista = 'ferramentas';
  if (!['videos', 'ferramentas'].includes(vista)) vista = 'videos';

  if (!FILTROS.some(([k]) => k === filtro) || filtro === 'novos') filtro = 'tudo';
  if (configurado()) {
    issues = ler(CHAVE_ISSUES, []);  // mostra a ultima lista na hora; a nova chega em seguida
    if (issues.length) semearVistos();
  }
  mostrarPendentes();
  desenharFila();
  if (!configurado()) {
    mostrarConfig(true);
    avisar('Primeiro, conecte o Garimpo ao seu GitHub: são dois passos.');
  }
  if (veio && !link) avisar('Não achei um link no que foi compartilhado.', 'erro');
  if (veio && link) {
    receber(link).then(reenviarPendentes).then(() => completarTextos());
  } else if (configurado()) {
    reenviarPendentes().finally(carregarFila);
  }
  if (atalho === 'colar' && !veio) $('link-colado').focus();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', iniciar);
