// Garimpo: recebe links de video pelo "Compartilhar" do Android e guarda cada um como issue num repositorio
// privado do GitHub. O PC le essas issues, baixa e transcreve os videos, e o Claude responde na propria issue.
'use strict';

const API = 'https://api.github.com';
const CHAVE_CONFIG = 'fila-config';        // {repo: "usuario/nome", token: "..."}
const CHAVE_PENDENTES = 'fila-pendentes';  // links que nao chegaram ao GitHub: [{link, nota, quando}]
const RASTREIO = /^(utm_.*|igsh|igshid|si|fbclid|gclid|mibextid|ref|ref_src|share_id)$/i;
const RE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
    if (valor === null) localStorage.removeItem(chave);
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

// ------------------------------------------------------------------ links

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
    const m = String(t).match(/https?:\/\/[^\s<>"'“”]+/i);
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
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return link;
  }
}

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
    const limite = r.headers.get('x-ratelimit-remaining') === '0';
    if (limite) throw new ErroGitHub('Limite de uso do GitHub atingido. Tente de novo daqui a pouco.', { rede: true });
    throw new ErroGitHub(`O GitHub não deixou acessar ${c.repo} (${r.status}). Confira o nome do repositório e se o token tem acesso a ele com "Issues: Read and write".`, { token: true });
  }
  if (r.status >= 500) throw new ErroGitHub(`O GitHub está com problema (${r.status}).`, { rede: true });
  if (!r.ok) throw new ErroGitHub(`O GitHub respondeu ${r.status}.`);
  return r.status === 204 ? null : r.json();
}

async function enviarLink(link, nota = '') {
  const { repo } = config();
  const abertas = await gh(`/repos/${repo}/issues?state=open&per_page=100`);
  const repetida = abertas.find((i) => !i.pull_request && i.title === link);
  if (repetida) return { issue: repetida, repetida: true };
  const issue = await gh(`/repos/${repo}/issues`, { metodo: 'POST', corpo: { title: link, body: nota } });
  return { issue, repetida: false };
}

// ------------------------------------------------------------------ telas

function avisar(texto, tipo = '') {
  const el = $('aviso');
  el.textContent = texto;
  el.dataset.tipo = tipo;
  el.hidden = !texto;
}

function mostrarConfig(abrir) {
  $('config').hidden = !abrir;
  $('abrir-config').setAttribute('aria-expanded', String(abrir));
  if (abrir) {
    const c = config() || {};
    $('repo').value = c.repo || '';
    $('token').value = c.token ? '••••••••' : '';
    $('token').dataset.salvo = c.token ? 'sim' : '';
    $('repo').focus();
  }
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
  const ul = $('lista-pendentes');
  ul.replaceChildren(...lista.map((p) => {
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
      const { issue, repetida } = await enviarLink(p.link, p.nota);
      enviados += 1;
      if (p.link === linkAtual) mostrarEnviado(issue, repetida);
    } catch (e) {
      erro = e;
      sobrou.push(p);
    }
  }
  gravar(CHAVE_PENDENTES, sobrou);
  mostrarPendentes();
  if (erro) avisar(erro.message, 'erro');
  else if (enviados) avisar(`${enviados} link(s) enviados para a fila.`, 'ok');
  if (enviados) carregarFila();
}

// ------------------------------------------------------------------ compartilhar

let issueAtual = null;
let linkAtual = null;

function mostrarEnviado(issue, repetida) {
  const estado = $('estado-compartilhado');
  issueAtual = issue;
  estado.textContent = repetida ? 'Já estava na fila.' : 'Na fila ✓';
  estado.dataset.tipo = 'ok';
  $('nota').value = issue.body || '';
  $('form-nota').hidden = false;
}

async function receber(link, nota = '') {
  const secao = $('compartilhado');
  const estado = $('estado-compartilhado');
  secao.hidden = false;
  $('link-compartilhado').textContent = link;
  $('form-nota').hidden = true;
  issueAtual = null;
  linkAtual = link;
  if (!configurado()) {
    guardarPendente(link, nota);
    estado.textContent = 'Guardado neste celular. Configure o GitHub para enviar.';
    estado.dataset.tipo = 'erro';
    mostrarConfig(true);
    return;
  }
  estado.textContent = 'Enviando…';
  estado.dataset.tipo = '';
  try {
    const { issue, repetida } = await enviarLink(link, nota);
    mostrarEnviado(issue, repetida);
    carregarFila();
  } catch (e) {
    guardarPendente(link, nota);
    estado.textContent = e.rede ? 'Sem conexão: guardado neste celular, envio depois.' : e.message;
    estado.dataset.tipo = 'erro';
    if (e.token) mostrarConfig(true);
  }
}

async function salvarNota(evento) {
  evento.preventDefault();
  if (!issueAtual) return;
  const botao = evento.submitter || $('form-nota').querySelector('button');
  botao.disabled = true;
  try {
    const { repo } = config();
    const nota = $('nota').value.trim().slice(0, 500);
    issueAtual = await gh(`/repos/${repo}/issues/${issueAtual.number}`, { metodo: 'PATCH', corpo: { body: nota } });
    avisar('Nota salva.', 'ok');
    carregarFila();
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
  avisar('');
  receber(link);
}

// ------------------------------------------------------------------ fila

const DATA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function situacao(issue) {
  const nomes = new Set((issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)));
  if (nomes.has('vale-a-pena')) return ['Vale a pena', 'ok'];
  if (nomes.has('evite')) return ['Evite', 'erro'];
  if (nomes.has('falhou')) return ['Falhou', 'erro'];
  if (nomes.has('baixado')) return ['Esperando análise', 'espera'];
  if (issue.state === 'closed') return ['Fechado', ''];
  return ['Na fila', ''];
}

async function carregarComentarios(issue, destino) {
  const { repo } = config();
  destino.textContent = 'Carregando…';
  try {
    const comentarios = await gh(`/repos/${repo}/issues/${issue.number}/comments?per_page=20`);
    if (!comentarios.length) {
      destino.textContent = 'Sem resposta ainda.';
      return;
    }
    destino.replaceChildren(...comentarios.map((c) => {
      const p = document.createElement('p');
      p.className = 'comentario';
      p.textContent = c.body.replace(/\*\*/g, '');
      return p;
    }));
  } catch (e) {
    destino.textContent = e.message;
  }
}

function itemDaFila(issue) {
  const li = document.createElement('li');
  const topo = document.createElement('div');
  topo.className = 'item-topo';

  const bloco = document.createElement('div');
  const link = acharLink(issue.title);
  const a = document.createElement(link ? 'a' : 'span');
  a.className = 'item-link';
  a.textContent = link ? linkCurto(link) : issue.title;
  if (link) {
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  const meta = document.createElement('p');
  meta.className = 'item-meta';
  meta.textContent = `#${issue.number} · ${DATA.format(new Date(issue.created_at))}`;
  bloco.append(a, meta);

  const [texto, tipo] = situacao(issue);
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.dataset.tipo = tipo;
  chip.textContent = texto;
  topo.append(bloco, chip);
  li.append(topo);

  if (issue.body) {
    const nota = document.createElement('p');
    nota.className = 'item-nota';
    nota.textContent = issue.body;
    li.append(nota);
  }
  if (issue.comments > 0) {
    const det = document.createElement('details');
    det.className = 'item-detalhes';
    const resumo = document.createElement('summary');
    const analisado = texto === 'Vale a pena' || texto === 'Evite';
    resumo.textContent = analisado ? 'Ver a análise' : texto === 'Falhou' ? 'Ver o motivo' : 'Ver comentários';
    const corpo = document.createElement('div');
    det.append(resumo, corpo);
    det.addEventListener('toggle', () => {
      if (det.open && !corpo.dataset.carregado) {
        corpo.dataset.carregado = 'sim';
        carregarComentarios(issue, corpo);
      }
    });
    li.append(det);
  }
  return li;
}

let carregando = false;

async function carregarFila() {
  if (!configurado() || carregando) return;
  carregando = true;
  const botao = $('atualizar');
  botao.disabled = true;
  try {
    const { repo } = config();
    const issues = await gh(`/repos/${repo}/issues?state=all&per_page=30&sort=created&direction=desc`);
    const lista = issues.filter((i) => !i.pull_request);
    $('fila').replaceChildren(...lista.map(itemDaFila));
    $('fila-vazia').hidden = lista.length > 0;
  } catch (e) {
    avisar(e.message, 'erro');
    if (e.token) mostrarConfig(true);
  } finally {
    carregando = false;
    botao.disabled = false;
  }
}

// ------------------------------------------------------------------ configuracao

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
    $('token').dataset.salvo = 'sim';
    avisar('Tudo certo. Agora é só compartilhar os vídeos com o Garimpo.', 'ok');
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
  $('repo').value = '';
  $('token').value = '';
  $('token').dataset.salvo = '';
  $('fila').replaceChildren();
  avisar('Repositório e token apagados deste celular.', 'ok');
}

// ------------------------------------------------------------------ inicio

function iniciar() {
  $('abrir-config').addEventListener('click', () => mostrarConfig($('config').hidden));
  $('form-config').addEventListener('submit', salvarConfig);
  $('apagar-config').addEventListener('click', apagarConfig);
  $('form-colar').addEventListener('submit', colar);
  $('form-nota').addEventListener('submit', salvarNota);
  $('atualizar').addEventListener('click', carregarFila);
  $('reenviar').addEventListener('click', reenviarPendentes);
  $('token').addEventListener('focus', (e) => {
    if (e.target.dataset.salvo && e.target.value === '••••••••') e.target.select();
  });
  window.addEventListener('online', reenviarPendentes);

  // Veio do "Compartilhar"? Le os parametros e limpa a barra de endereco, para recarregar nao mandar de novo.
  const p = new URLSearchParams(location.search);
  const veio = p.has('text') || p.has('url') || p.has('title');
  const link = veio ? acharLink(p.get('url'), p.get('text'), p.get('title')) : null;
  if (veio) history.replaceState(null, '', location.pathname);

  mostrarPendentes();
  if (!configurado()) {
    mostrarConfig(true);
    avisar('Primeiro, configure o repositório e o token do GitHub.');
  }
  if (veio && !link) avisar('Não achei um link no que foi compartilhado.', 'erro');
  if (veio && link) {
    receber(link).then(reenviarPendentes);  // um de cada vez, para nao criar a mesma issue duas vezes
  } else if (configurado()) {
    reenviarPendentes();
    carregarFila();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', iniciar);
