import { notebookFor, kaggleModels } from './app.js';
const assets = { 'kaggle-notebook.json': JSON.stringify(await (await fetch('./kaggle-notebook.json')).json()) };
const kaggleBase = 'https://api.kaggle.com/v1/kernels.KernelsApiService/';
const jobPattern = /^bloxr-[a-f0-9]{16}$/;
const userPattern = /^[a-z0-9_-]{2,80}$/i;
const outputName = 'bloxr-output.txt';
const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json' };

class KaggleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

async function rpc(method, data, token) {
  let response;
  try {
    response = await fetch(kaggleBase + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(data), credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new KaggleError(502, 'Não foi possível confirmar a chamada ao Kaggle.');
  }
  const body = await response.json().catch(() => null);
  const status = response.ok ? Number(body?.code) : response.status;
  if (status === 401 || status === 403) throw new KaggleError(status, 'O Kaggle recusou o acesso. Confira o token, o usuário e as permissões da conta.');
  if (status === 404) throw new KaggleError(404, 'O Kaggle ainda não encontrou essa execução.');
  if (status === 429) throw new KaggleError(429, 'O Kaggle está limitando chamadas. Aguarde alguns segundos.');
  if (!response.ok || !body || status >= 400 || body.error) throw new KaggleError(502, 'O Kaggle recusou a operação. Confira a disponibilidade de GPU e Internet na sua conta.');
  return body;
}

function trustedOutputUrl(url) {
  let source;
  try { source = new URL(url); } catch { throw new KaggleError(502, 'O endereço de saída do Kaggle é inválido.'); }
  const host = source.hostname;
  if (source.protocol !== 'https:' || source.username || source.password || !['kaggle.com', 'googleapis.com', 'googleusercontent.com'].some(domain => host === domain || host.endsWith('.' + domain))) throw new KaggleError(502, 'O endereço de saída do Kaggle é inválido.');
  return source;
}
async function resultText(url) {
  if (!url) return null;
  const source = trustedOutputUrl(url);
  const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '', size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return result + decoder.decode();
    size += value.byteLength;
    if (size > 2_000_000) {
      await reader.cancel();
      throw new KaggleError(502, 'A saída ultrapassou 2 MB.');
    }
    result += decoder.decode(value, { stream: true });
  }
}

async function kaggle(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'Método inválido.' }, 405);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'Formato inválido.' }, 415);
  try {
    const raw = await request.text();
    if (raw.length > 60000) return json({ error: 'O prompt é grande demais.' }, 413);
    const data = JSON.parse(raw);
    const owner = env.KAGGLE_USERNAME || data?.username;
    const rawToken = env.KAGGLE_API_TOKEN || data?.token;
    const token = typeof rawToken === 'string' ? (rawToken.startsWith('KGAT_') ? 'Bearer ' + rawToken : 'Basic ' + btoa(owner + ':' + rawToken)) : null;
    if (typeof owner !== 'string' || !userPattern.test(owner) || typeof rawToken !== 'string' || !/^[\x21-\x7e]{12,4096}$/.test(rawToken)) {
      return json({ error: 'Preencha seu usuário do Kaggle e o token de API em Conexões.' }, 400);
    }
    const action = url.pathname.slice('/api/kaggle/'.length);
    if (action === 'check') {
      await rpc('ListKernels', { user: owner, pageSize: 1 }, token);
      return json({ connected: true });
    }
    if (action === 'submit') {
      const { model, prompt, tokens, job } = data;
      const config = Object.hasOwn(kaggleModels, model) ? kaggleModels[model] : null;
      if (!jobPattern.test(job ?? '') || !config || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50000 || !Number.isInteger(tokens) || tokens < 1 || tokens > config.model[3]) {
        return json({ error: 'Confira o modelo, o prompt e o limite de tokens.' }, 400);
      }
      const notebook = notebookFor(JSON.parse(assets['kaggle-notebook.json']), 'kaggle', model, prompt, tokens);
      const saved = await rpc('SaveKernel', {
        slug: owner + '/' + job, newTitle: job, text: JSON.stringify(notebook), language: 'python',
        kernelType: 'notebook', isPrivate: true, enableGpu: true, enableInternet: true,
        machineShape: 'NvidiaTeslaT4', sessionTimeoutSeconds: config.timeout,
      }, token);
      return json({ job, version: saved.versionNumber ?? null }, 202);
    }
    if (action === 'image') {
      const { job, name } = data;
      if (!jobPattern.test(job ?? '') || typeof name !== 'string' || name.length > 500 || !/\.(png|jpe?g|webp|gif)$/i.test(name)) return json({ error: 'Imagem inválida.' }, 400);
      const files = await rpc('ListKernelSessionOutput', { userName: owner, kernelSlug: job, pageSize: 100 }, token);
      const file = files.files?.find(entry => entry.fileName === name);
      if (!file?.url) return json({ error: 'Imagem não encontrada.' }, 404);
      const response = await fetch(trustedOutputUrl(file.url), { redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok || !response.body) return json({ error: 'Falha ao buscar imagem.' }, 502);
      const reader = response.body.getReader(), chunks = []; let size = 0;
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 5_000_000) { await reader.cancel(); return json({ error: 'Imagem acima de 5 MB.' }, 413); } chunks.push(value); }
      const ext = name.toLowerCase().split('.').pop();
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
      return new Response(new Blob(chunks, { type }), { headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (action === 'status') {
      const { job, version } = data;
      if (!jobPattern.test(job ?? '') || (version !== null && (!Number.isInteger(version) || version < 1))) return json({ error: 'Execução inválida.' }, 400);
      const target = { userName: owner, kernelSlug: job };
      const status = await rpc('GetKernelSessionStatus', { ...target, ...(version && { versionLabel: 'v' + version }) }, token);
      const phases = ['QUEUED', 'RUNNING', 'COMPLETE', 'ERROR', 'CANCEL_REQUESTED', 'CANCEL_ACKNOWLEDGED', 'NEW_SCRIPT'];
      const phase = /^\d+$/.test(String(status.status)) ? phases[Number(status.status)] : String(status.status ?? '').toUpperCase();
      if (['ERROR', 'CANCEL_REQUESTED', 'CANCEL_ACKNOWLEDGED', 'CANCELLED'].includes(phase)) {
        return json({ phase: 'failed', error: 'O Kaggle encerrou a execução sem resposta. Veja o notebook privado na sua conta.' });
      }
      if (phase !== 'COMPLETE') {
        if (!['QUEUED', 'RUNNING', 'NEW_SCRIPT'].includes(phase)) throw new KaggleError(502, 'O Kaggle retornou um status de execução desconhecido.');
        return json({ phase: phase === 'RUNNING' ? 'running' : 'queued' });
      }
      const files = await rpc('ListKernelSessionOutput', { ...target, pageSize: 100 }, token);
      const file = files.files?.find(entry => entry.fileName === outputName || entry.fileName === '/kaggle/working/' + outputName);
      const answer = await resultText(file?.url);
      const images = (files.files || []).filter(entry => typeof entry.fileName === 'string' && /\.(png|jpe?g|webp|gif)$/i.test(entry.fileName) && entry.url).slice(0, 12).map(entry => ({ name: entry.fileName }));
      return answer?.trim() || images.length ? json({ phase: 'complete', answer: answer || '', images }) : json({ phase: 'finishing' });
    }
    return json({ error: 'Operação inválida.' }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: 'Pedido inválido.' }, 400);
    return json({ error: error instanceof KaggleError ? error.message : 'Falha ao consultar o Kaggle.' }, error.status || 502);
  }
}

export function kaggleApi(action, data) {
 const url = new URL('/api/kaggle/' + action, location.origin);
 return kaggle(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), {}, url);
}
