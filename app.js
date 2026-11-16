// Garimpo: recebe links de video pelo "Compartilhar" do Android e guarda cada um como issue num repositorio
// privado do GitHub. O PC le essas issues, baixa e transcreve os videos, e o Claude responde na propria issue.
//
// Contrato com o PC (fila_github.py): titulo "<rotulo> · <link>" ou so "<link>"; corpo = nota; etiquetas =
// status (baixado, falhou, analisado + vale-a-pena/evite); o veredito e o ultimo comentario "**Vale a pena**: ..."
// ou "**Evite**: ...".
'use strict';

const API = 'https://api.github.com';
const CHAVE_CONFIG = 'fila-config';          // {repo: "usuario/nome", token: "..."}
const CHAVE_PENDENTES = 'fila-pendentes';    // links que nao chegaram ao GitHub: [{link, nota, quando}]
const CHAVE_TEXTOS = 'garimpo-textos';       // cache dos comentarios: {numero: {u: updated_at, t: texto}}
const CHAVE_FILTRO = 'garimpo-filtro';
const CHAVE_ISSUES = 'garimpo-issues';       // a ultima lista, para abrir na hora e sem internet
const RASTREIO = /^(utm_.*|igsh|igshid|si|fbclid|gclid|mibextid|ref|ref_src|share_id)$/i;
const RE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RE_URL = /https?:\/\/[^\s<>"'“”]+/i;
const MAX_TEXTOS_POR_VEZ = 15;
const FILTROS = [
  ['tudo', 'Tudo'], ['fila', 'Na fila'], ['esperando', 'Esperando'],
  ['vale', 'Vale a pena'], ['evite', 'Evite'], ['falhou', 'Falhou'],
];

const $ = (id) => document.getElementById(id);

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

// ------------------------------------------------------------------ links e titulos

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

// O Android costuma mandar o link no campo "text", junto com outras palavras; as vezes no "url" ou no "title".
function acharLink(...textos) {
  for (const t of textos) {
    if (!t) continue;
    const m = String(t).match(RE_URL);
    if (m) {
      const link = limparLink(m[0].replace(/[).,;:!?\]]+$/, ''));
      if (link) return link;
    }
  }
  return null;
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

// O que o cartao mostra: o rotulo do titulo (o @autor ou o nome da ferramenta), ou o link curto.
function rotulo(issue) {
  const t = (issue.title || '').replace(RE_URL, '').replace(/^[\s·\-–|]+|[\s·\-–|]+$/g, '');
  return t;
}

// Texto do comentario para a tela: sem o "**Vale a pena**:" (o chip ja diz) e sem a marcacao do markdown.
function textoLimpo(corpo) {
  return (corpo || '')
    .replace(/^\*\*(Vale a pena|Evite)\*\*:\s*/i, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
    .trim();
}

const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ------------------------------------------------------------------ GitHub

class ErroGitHub extends Error {
  constructor(mensagem, { token = false, rede = false } = {}) {
    super(mensagem);
    this.token = token;  // problema no token ou no repositorio: nao adianta tentar de novo sozinho
    this.rede = rede;    // sem internet ou GitHub fora: guarda para reenviar
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
    throw new ErroGitHub('O GitHub recusou o token: ele pode ter expirado ou sido apagado. Gere outro e salve na configuração.', { token: true });
  }
  if (r.status === 403 || r.status === 404) {
    if (r.headers.get('x-ratelimit-remaining') === '0') {
      throw new ErroGitHub('Limite de uso do GitHub atingido. Tente de novo daqui a pouco.', { rede: true });
    }
    throw new ErroGitHub(`O GitHub não deixou acessar ${c.repo} (${r.status}). Confira o nome do repositório e se o token tem acesso a ele com "Issues: Read and write".`, { token: true });
  }
  if (r.status >= 500) throw new ErroGitHub(`O GitHub está com problema (${r.status}).`, { rede: true });
  if (!r.ok) throw new ErroGitHub(`O GitHub respondeu ${r.status}.`);
  return r.status === 204 ? null : r.json();
}

const caminhoRepo = () => `/repos/${config().repo}`;
const dono = () => config().repo.split('/')[0].toLowerCase();

async function buscarIssues() {
  const lista = await gh(`${caminhoRepo()}/issues?state=all&per_page=100&sort=created&direction=desc`);
  const minhas = lista.filter((i) => !i.pull_request && (i.user?.login || '').toLowerCase() === dono());
  gravar(CHAVE_ISSUES, minhas.map((i) => ({
    number: i.number, title: i.title, body: i.body, state: i.state, comments: i.comments,
    created_at: i.created_at, updated_at: i.updated_at, labels: (i.labels || []).map((l) => ({ name: l.name || l })),
  })));
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

const ROTULO_SITUACAO = {
  vale: ['Vale a pena', 'ok'], evite: ['Evite', 'erro'], falhou: ['Falhou', 'erro'],
  esperando: ['Esperando análise', 'espera'], fila: ['Na fila', ''], removido: ['Removido', ''],
};

// ------------------------------------------------------------------ textos (comentarios) com cache

const textos = ler(CHAVE_TEXTOS, {});

function textoEmCache(issue) {
  const c = textos[issue.number];
  return c && c.u === issue.updated_at ? c.t : null;
}

async function carregarTexto(issue) {
  const comentarios = await gh(`${caminhoRepo()}/issues/${issue.number}/comments?per_page=50`);
  const meus = comentarios.filter((c) => (c.user?.login || '').toLowerCase() === dono());
  let escolhido = [...meus].reverse().find((c) => /^\*\*(Vale a pena|Evite)\*\*/i.test(c.body || ''));
  if (!escolhido) escolhido = meus[meus.length - 1];
  const t = escolhido ? textoLimpo(escolhido.body) : '';
  textos[issue.number] = { u: issue.updated_at, t };
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
  const el = $('aviso');
  el.textContent = texto;
  el.dataset.tipo = tipo;
  el.hidden = !texto;
}

let tempoToast = null;
function toast(texto) {
  const el = $('toast');
  el.textContent = texto;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('visivel'));
  clearTimeout(tempoToast);
  tempoToast = setTimeout(() => {
    el.classList.remove('visivel');
    setTimeout(() => { el.hidden = true; }, 250);
  }, 2600);
}

const vibrar = () => {
  // O Chrome so deixa vibrar depois de um toque na pagina; antes disso, nem tenta.
  if (!navigator.userActivation?.hasBeenActive) return;
  try { navigator.vibrate?.(15); } catch { /* sem vibracao */ }
};

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
  $('conectado').hidden = !ok;
  $('conectado').textContent = ok ? `Conectado a ${c.repo}` : '';
  (c.repo ? $('token') : $('repo')).focus();
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
  }
}

function apagarConfig() {
  gravar(CHAVE_CONFIG, null);
  gravar(CHAVE_TEXTOS, null);
  gravar(CHAVE_ISSUES, null);
  $('repo').value = '';
  $('token').value = '';
  $('token').dataset.salvo = '';
  $('conectado').hidden = true;
  issues = [];
  desenharFila();
  avisar('Repositório e token apagados deste celular.', 'ok');
}

// ------------------------------------------------------------------ enviar

// Ve se o link ja esta na fila ou ja foi analisado; se nao, cria a issue.
async function enviarLink(link, nota = '') {
  const todas = await buscarIssues();
  issues = todas;
  const mesmo = todas.filter((i) => acharLink(i.title) === link);
  const analisada = mesmo.find((i) => ['vale', 'evite'].includes(situacao(i)));
  if (analisada) return { issue: analisada, ja: 'analisada' };
  const aberta = mesmo.find((i) => i.state === 'open');
  if (aberta) return { issue: aberta, ja: 'na-fila' };
  const issue = await gh(`${caminhoRepo()}/issues`, { metodo: 'POST', corpo: { title: link, body: nota } });
  issues = [issue, ...issues];
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
  $('lista-pendentes').replaceChildren(...lista.map((p) => {
    const li = document.createElement('li');
    li.textContent = linkCurto(p.link);
    return li;
  }));
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
  else if (enviados) toast(`${enviados} link(s) enviados para a fila`);
  if (enviados) desenharFila();
}

// ------------------------------------------------------------------ compartilhar

let issueAtual = null;
let linkAtual = null;

function estadoRecebido(texto, tipo, selo) {
  const estado = $('estado-compartilhado');
  estado.textContent = texto;
  estado.dataset.tipo = tipo;
  $('selo').dataset.tipo = selo;
}

async function mostrarEnviado({ issue, ja }) {
  issueAtual = issue;
  vibrar();
  const caixa = $('veredito-anterior');
  caixa.hidden = true;
  if (ja === 'analisada') {
    const [texto, tipo] = ROTULO_SITUACAO[situacao(issue)];
    estadoRecebido(`Já analisado: ${texto}`, tipo, tipo);
    $('titulo-compartilhado').textContent = rotulo(issue) || 'Vídeo recebido';
    $('form-nota').hidden = true;
    caixa.dataset.tipo = tipo;
    caixa.textContent = textoEmCache(issue) || 'Carregando a análise…';
    caixa.hidden = false;
    if (!textoEmCache(issue)) {
      try {
        caixa.textContent = (await carregarTexto(issue)) || 'Sem texto na análise.';
      } catch (e) {
        caixa.textContent = e.message;
      }
    }
    return;
  }
  $('titulo-compartilhado').textContent = 'Vídeo recebido';
  estadoRecebido(ja === 'na-fila' ? `Já estava na fila (#${issue.number})` : 'Na fila', 'ok', 'ok');
  $('nota').value = issue.body || '';
  $('form-nota').hidden = false;
}

async function receber(link, nota = '') {
  $('compartilhado').hidden = false;
  $('link-compartilhado').textContent = link;
  $('form-nota').hidden = true;
  $('veredito-anterior').hidden = true;
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
  const botao = $('form-nota').querySelector('button');
  botao.disabled = true;
  try {
    const nota = $('nota').value.trim().slice(0, 500);
    issueAtual = await gh(`${caminhoRepo()}/issues/${issueAtual.number}`, { metodo: 'PATCH', corpo: { body: nota } });
    issues = issues.map((i) => (i.number === issueAtual.number ? issueAtual : i));
    desenharFila();
    toast('Nota salva');
  } catch (e) {
    avisar(e.message, 'erro');
  } finally {
    botao.disabled = false;
  }
}

function colar(evento) {
  evento.preventDefault();
  const campo = $('link-colado');
  const link = acharLink(campo.value);
  if (!link) {
    avisar('Isso não parece um link. Cole o endereço do vídeo, começando com https://', 'erro');
    campo.focus();
    return;
  }
  campo.value = '';
  campo.blur();
  avisar('');
  receber(link);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------------ fila: dados, filtros e busca

let issues = [];
let filtro = ler(CHAVE_FILTRO, 'tudo');
let busca = '';
let carregando = false;
let ultimaCarga = 0;

function visiveis() {
  return issues.filter((i) => situacao(i) !== 'removido');
}

function contagens() {
  const c = { tudo: 0, fila: 0, esperando: 0, vale: 0, evite: 0, falhou: 0 };
  for (const i of visiveis()) {
    c.tudo += 1;
    c[situacao(i)] += 1;
  }
  return c;
}

function desenharFiltros() {
  const c = contagens();
  const caixa = $('filtros');
  caixa.replaceChildren(...FILTROS.filter(([k]) => k === 'tudo' || k === filtro || c[k] > 0).map(([k, nome]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filtro';
    b.dataset.filtro = k;
    b.setAttribute('aria-pressed', String(k === filtro));
    const n = document.createElement('span');
    n.className = 'filtro-n';
    n.textContent = c[k];
    b.append(nome, n);
    return b;
  }));
  $('busca').hidden = c.tudo < 6 && !busca;
}

function filtrados() {
  const termo = semAcento(busca.trim());
  return visiveis().filter((i) => {
    if (filtro !== 'tudo' && situacao(i) !== filtro) return false;
    if (!termo) return true;
    const alvo = semAcento([i.title, i.body, textoEmCache(i) || ''].join(' '));
    return alvo.includes(termo);
  });
}

// ------------------------------------------------------------------ fila: desenho

const DATA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function botaoAcao(texto, acao, numero, extra = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `acao ${extra}`.trim();
  b.dataset.acao = acao;
  b.dataset.numero = numero;
  b.textContent = texto;
  return b;
}

function itemDaFila(issue) {
  const sit = situacao(issue);
  const [textoSit, tipo] = ROTULO_SITUACAO[sit];
  const link = acharLink(issue.title);
  const nome = rotulo(issue);

  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.situacao = sit;

  const topo = document.createElement('div');
  topo.className = 'item-topo';
  const bloco = document.createElement('div');
  bloco.className = 'item-bloco';
  const titulo = document.createElement('p');
  titulo.className = 'item-titulo';
  titulo.textContent = nome || (link ? linkCurto(link) : issue.title);
  const meta = document.createElement('p');
  meta.className = 'item-meta';
  if (link && nome) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = linkCurto(link).replace(/^instagram\.com\//, '');
    meta.append(a, ' · ');
  }
  meta.append(`${DATA.format(new Date(issue.created_at))}`);
  bloco.append(titulo, meta);
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.dataset.tipo = tipo;
  chip.textContent = textoSit;
  topo.append(bloco, chip);
  li.append(topo);

  if (issue.body) {
    const nota = document.createElement('p');
    nota.className = 'item-nota';
    nota.textContent = issue.body;
    li.append(nota);
  }

  if (['vale', 'evite', 'falhou'].includes(sit) && issue.comments > 0) {
    const caixa = document.createElement('div');
    caixa.className = 'item-analise';
    caixa.dataset.tipo = tipo;
    caixa.dataset.numero = issue.number;
    const t = textoEmCache(issue);
    if (t !== null) caixa.textContent = t;
    else {
      caixa.classList.add('carregando-texto');
      caixa.append(botaoAcao(sit === 'falhou' ? 'Ver o motivo' : 'Ver a análise', 'texto', issue.number, 'acao-link'));
    }
    li.append(caixa);
  }

  const acoes = document.createElement('div');
  acoes.className = 'item-acoes';
  if (link && !nome) {
    const a = document.createElement('a');
    a.className = 'acao';
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Abrir vídeo';
    acoes.append(a);
  }
  if (sit === 'falhou') acoes.append(botaoAcao('Tentar de novo', 'refazer', issue.number));
  if (sit === 'fila' || sit === 'falhou') acoes.append(botaoAcao('Remover', 'remover', issue.number, 'acao-perigo'));
  if (acoes.childElementCount) li.append(acoes);
  return li;
}

function desenharFila() {
  desenharFiltros();
  const lista = filtrados();
  $('fila').replaceChildren(...lista.map(itemDaFila));
  const vazio = $('fila-vazia');
  vazio.hidden = lista.length > 0 || carregando;
  if (!configurado()) vazio.textContent = 'Configure o GitHub na engrenagem para ver a sua fila.';
  else if (!visiveis().length) vazio.textContent = 'Nada aqui ainda. No Instagram, toque em Compartilhar e escolha Garimpo.';
  else if (busca) vazio.textContent = 'Nada encontrado nessa busca.';
  else vazio.textContent = 'Nenhum vídeo nesta situação.';
}

// Busca os textos dos vereditos que faltam (os mais novos primeiro, poucos por vez).
async function completarTextos() {
  const faltam = visiveis()
    .filter((i) => ['vale', 'evite', 'falhou'].includes(situacao(i)) && i.comments > 0 && textoEmCache(i) === null)
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
  $('carregando').hidden = issues.length > 0;
  $('fila-vazia').hidden = true;
  try {
    issues = await buscarIssues();
    carregando = false;
    $('carregando').hidden = true;
    desenharFila();
    completarTextos();
  } catch (e) {
    avisar(e.message, 'erro');
    if (e.token) mostrarConfig(true, { comErro: true });
  } finally {
    carregando = false;
    $('carregando').hidden = true;
    $('atualizar').disabled = false;
    if (!issues.length) desenharFila();
  }
}

// ------------------------------------------------------------------ fila: acoes

const confirmando = new Map();

async function agir(evento) {
  const b = evento.target.closest('button[data-acao]');
  if (!b) return;
  const numero = Number(b.dataset.numero);
  const issue = issues.find((i) => i.number === numero);
  if (!issue) return;

  if (b.dataset.acao === 'texto') {
    const caixa = b.closest('.item-analise');
    caixa.textContent = 'Carregando…';
    try {
      caixa.textContent = (await carregarTexto(issue)) || 'Sem texto.';
      caixa.classList.remove('carregando-texto');
    } catch (e) {
      caixa.textContent = e.message;
    }
    return;
  }

  if (b.dataset.acao === 'remover' && !confirmando.has(numero)) {
    b.textContent = 'Toque de novo para remover';
    b.classList.add('confirmar');
    confirmando.set(numero, setTimeout(() => {
      confirmando.delete(numero);
      b.textContent = 'Remover';
      b.classList.remove('confirmar');
    }, 4000));
    return;
  }

  b.disabled = true;
  try {
    if (b.dataset.acao === 'remover') {
      clearTimeout(confirmando.get(numero));
      confirmando.delete(numero);
      const fechada = await gh(`${caminhoRepo()}/issues/${numero}`, {
        metodo: 'PATCH', corpo: { state: 'closed', state_reason: 'not_planned' },
      });
      issues = issues.map((i) => (i.number === numero ? { ...fechada, labels: [] } : i));
      toast('Removido da fila');
    } else if (b.dataset.acao === 'refazer') {
      await gh(`${caminhoRepo()}/issues/${numero}/labels/falhou`, { metodo: 'DELETE' });
      issues = issues.map((i) => (i.number === numero
        ? { ...i, labels: (i.labels || []).filter((l) => (l.name || l) !== 'falhou') } : i));
      toast('Volta para a fila');
    }
    desenharFila();
  } catch (e) {
    avisar(e.message, 'erro');
    b.disabled = false;
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
  $('filtros').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filtro]');
    if (!b) return;
    filtro = b.dataset.filtro;
    gravar(CHAVE_FILTRO, filtro);
    desenharFila();
  });
  $('busca').addEventListener('input', (e) => {
    busca = e.target.value;
    desenharFila();
  });
  $('token').addEventListener('focus', (e) => {
    if (e.target.dataset.salvo && e.target.value === '••••••••') e.target.select();
  });
  window.addEventListener('online', reenviarPendentes);
  // Voltou para o app depois de um tempo: atualiza sozinho.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - ultimaCarga > 30000) carregarFila();
  });

  // Veio do "Compartilhar"? Le os parametros e limpa a barra de endereco, para recarregar nao mandar de novo.
  const p = new URLSearchParams(location.search);
  const veio = p.has('text') || p.has('url') || p.has('title');
  const link = veio ? acharLink(p.get('url'), p.get('text'), p.get('title')) : null;
  if (veio) history.replaceState(null, '', location.pathname);

  if (!FILTROS.some(([k]) => k === filtro)) filtro = 'tudo';
  if (configurado()) issues = ler(CHAVE_ISSUES, []);  // mostra a ultima lista na hora; a nova chega em seguida
  mostrarPendentes();
  desenharFila();
  if (!configurado()) {
    mostrarConfig(true);
    avisar('Primeiro, configure o repositório e o token do GitHub.');
  }
  if (veio && !link) avisar('Não achei um link no que foi compartilhado.', 'erro');
  if (veio && link) {
    receber(link).then(reenviarPendentes).then(() => completarTextos());
  } else if (configurado()) {
    reenviarPendentes();
    carregarFila();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', iniciar);
