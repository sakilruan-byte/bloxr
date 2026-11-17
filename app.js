const qwen7 = ['qwen', 'Qwen2.5 Coder 7B', 'Qwen/Qwen2.5-Coder-7B-Instruct', 8192];
const qwen30 = ['qwen3', 'Qwen3 Coder 30B', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 20480];
const qwenVision = ['vision', 'Qwen3 VL 30B (API de visão)', 'Qwen/Qwen3-VL-30B-A3B-Instruct', 8192];
export const kaggleModels = {
  qwen: { model: qwen7, repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', gpus: 2, context: 12288, timeout: 2700 },
};
const providers = {
  colab: { label: 'Google Colab', link: 'https://colab.research.google.com/drive/1OUNba7U6gOh6vRZlBsTFMUGkQHuuyKRR', models: [qwen7, qwenVision] },
  kaggle: { label: 'Kaggle', link: 'https://www.kaggle.com/code', models: [qwen7] },
};
const $ = id => document.getElementById(id);
const form = typeof document !== 'undefined' ? $('task') : null;
const connections = new Map();
let kaggleCredentials;
try { const saved = JSON.parse(sessionStorage.getItem('bloxr-kaggle-session') || 'null'); if (saved && typeof saved.username === 'string' && typeof saved.token === 'string') kaggleCredentials = saved; } catch { /* Armazenamento pode estar bloqueado. */ }
const provider = () => form.elements.provider.value;
let connectionProvider, downloadUrl;
let busy = false;
let imageData = null, previewUrl = null;
const resultUrls = [];

function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function showOutput(value) {
  $('output').textContent = value;
  $('output').hidden = !value;
  $('empty').hidden = Boolean(value);
  $('copy').disabled = !value;
}
function resetHandoff() {
  $('handoff').hidden = true;
  $('notebook-download').removeAttribute('href');
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
}
function refresh() {
  const source = providers[provider()];
  const current = $('model').value;
  $('model').replaceChildren(...source.models.map(([key, label]) => new Option(label, key)));
  if (source.models.some(([key]) => key === current)) $('model').value = current;
  const kaggleReady = provider() === 'kaggle' && kaggleCredentials;
  const direct = kaggleReady || connections.has(provider());
  $('send').textContent = direct ? 'Enviar prompt' : 'Preparar execução ↗';
  $('settings').textContent = kaggleReady ? 'Kaggle: credenciais salvas' : 'Conexões';
  $('mode').textContent = direct ? 'Envio direto configurado.' : 'Execução pelo notebook da plataforma.';
  updateTokenLimit();
  updateResume();
}

function updateTokenLimit() {
  const selected = providers[provider()].models.find(([key]) => key === $('model').value);
  const input = $('tokens');
  input.max = selected[3];
  if (Number(input.value) > selected[3]) input.value = selected[3];
  $('model-hint').textContent = selected === qwen7 && provider() === 'kaggle' ? 'Qwen Coder 7B dividido entre as duas T4. Cada envio cria uma execução privada; não se conecta à sessão interativa já aberta.' : selected === qwenVision ? 'Requer uma API de visão configurada em Conexões; o notebook padrão não instala esse modelo.' : ''; 
}

function endpointOf(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Informe uma URL HTTPS válida para a API.');
  return url.href;
}
function setBusy(value) {
  busy = value;
  for (const item of form.elements) item.disabled = value;
  $('settings').disabled = value;
  $('import').disabled = value;
  updateResume();
}

function pythonPrompt(prompt) {
  const bytes = new TextEncoder().encode(prompt);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return 'import base64\nTAREFA = base64.b64decode("' + btoa(binary) + '").decode("utf-8")\n';
}

export function notebookFor(notebook, platform, mode, prompt, tokens) {
  const params = pythonPrompt(prompt) + 'MAX_TOKENS = ' + tokens + '\n';
  const downloadCode = 'from IPython.display import FileLink, display\n' +
    'Path("bloxr-output.txt").write_text(resposta, encoding="utf-8")\n' +
    'display(FileLink("bloxr-output.txt"))\n';
  notebook.cells[0].source = [
    '# Bloxr · tarefa preparada no painel\n',
    'Selecione GPU e execute as células em ordem. No Kaggle, mantenha o notebook privado e habilite Internet para baixar os pesos. No fim, baixe bloxr-output.txt.\n',
  ];
  if (platform === 'colab') {
    const original = notebook.cells[3].source.join('');
    const start = original.indexOf('prompt = tokenizer.apply_chat_template(');
    const stop = original.indexOf('Path("resposta_qwen.txt")');
    if (start < 0 || stop <= start) throw new Error('O notebook Colab mudou de formato.');
    notebook.cells[3].source = 'from pathlib import Path\n' + params +
      original.slice(start, stop).replace(/,\s*streamer=TextStreamer[^\n]*,/u, '') +
      downloadCode + 'from google.colab import files\nfiles.download("bloxr-output.txt")\n';
  } else {
    const config = kaggleModels[mode];
    const cell = notebook.cells[2];
    cell.source = params +
      'MODEL_REPO = ' + JSON.stringify(config.repo) + '\n' +
      'MODEL_FILE = ' + JSON.stringify(config.file) + '\n' +
      'GPU_COUNT = ' + config.gpus + '\n' +
      'CONTEXT = ' + config.context + '\n' +
      cell.source +
      'Path("/kaggle/working/bloxr-output.txt").write_text(resposta, encoding="utf-8")\n' +
      'from IPython.display import FileLink, display\n' +
      'display(FileLink("/kaggle/working/bloxr-output.txt"))\n';
  }
  return notebook;
}

async function directRequest(connection, model, prompt, tokens, image) {
  const headers = { 'Content-Type': 'application/json' };
  if (connection.token) headers.Authorization = 'Bearer ' + connection.token;
  const response = await fetch(connection.url, {
    method: 'POST', headers, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    signal: AbortSignal.timeout(300000),
    body: JSON.stringify({ model, messages: [{ role: 'user', content: image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] : prompt }], max_tokens: tokens, stream: false }),
  });
  if (!response.ok) throw new Error('A API retornou HTTP ' + response.status + '.');
  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string') throw new Error('A API não retornou uma resposta de texto.');
  const final = answer.split('</think>').at(-1).replace(/<think>[\s\S]*$/u, '').trim();
  if (!final) throw new Error('O modelo terminou antes de produzir uma resposta final.');
  return final;
}

const jobKey = 'bloxr-latest-kaggle-job';

function savedJob() {
  try { return JSON.parse(sessionStorage.getItem(jobKey)); } catch { return null; }
}

function rememberJob(job) {
  try { sessionStorage.setItem(jobKey, JSON.stringify(job)); } catch { /* Storage can be disabled. */ }
}

function updateResume() {
  const job = savedJob();
  $('resume').hidden = busy || provider() !== 'kaggle' || !job;
}

async function kaggleRequest(action, credentials, data) {
  const { kaggleApi } = await import('./kaggle-api.js?v=3');
  const response = await kaggleApi(action, { ...credentials, ...data });
  const reply = await response.json().catch(() => null);
  if (!response.ok || !reply) {
    const error = new Error(reply?.error || 'Falha de comunicação com o Kaggle.');
    error.status = response.status;
    throw error;
  }
  return reply;
}

async function watchKaggle(job, credentials) {
  const deadline = Date.now() + 125 * 60_000;
  let failures = 0;
  while (Date.now() < deadline) {
    let result;
    try {
      result = await kaggleRequest('status', credentials, { job: job.job, version: job.version });
      failures = 0;
    } catch (error) {
      const retryable = [404, 429, 502, 503, 504].includes(error.status) || error instanceof TypeError || error.name === 'TimeoutError';
      if (!retryable || ++failures >= 6) throw error;
      setStatus('Aguardando o Kaggle confirmar a execução…');
    }
    if (result?.phase === 'complete') {
      showOutput(result.answer || '');
      setStatus('');
      await showKaggleImages(job, credentials, result.images || []);
      return;
    }
    if (result?.phase === 'failed') throw new Error(result.error);
    if (result) {
      setStatus({ queued: 'Na fila do Kaggle…', running: 'Executando no Kaggle…', finishing: 'Buscando a resposta…' }[result.phase] || 'Consultando execução…');
    }
    await new Promise(resolve => setTimeout(resolve, 12000));
  }
  setStatus('A sessão de acompanhamento terminou. Use Consultar última execução para verificar novamente.');
}

async function showKaggleImages(job, credentials, files) {
  for (const url of resultUrls.splice(0)) URL.revokeObjectURL(url);
  $('result-images').replaceChildren();
  for (const file of files) {
    const { kaggleApi } = await import('./kaggle-api.js?v=3');
    const response = await kaggleApi('image', { ...credentials, job: job.job, name: file.name });
    if (!response.ok) { setStatus('Não foi possível carregar uma imagem do Kaggle.', true); continue; }
    const url = URL.createObjectURL(await response.blob()); resultUrls.push(url);
    const figure = document.createElement('figure'), img = document.createElement('img'), caption = document.createElement('figcaption'), link = document.createElement('a');
    img.src = url; img.alt = 'Imagem produzida no Kaggle: ' + file.name; link.href = url; link.download = file.name.split('/').pop(); link.textContent = 'Baixar imagem'; caption.textContent = file.name + ' · '; caption.append(link); figure.append(img, caption); $('result-images').append(figure);
  }
}

if (typeof document !== 'undefined') {
  form.elements.provider.forEach(input => input.addEventListener('change', () => {
    resetHandoff();
    refresh();
    setStatus('');
  }));
  $('model').addEventListener('change', updateTokenLimit);
  $('image-input').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5_000_000) { setStatus('Escolha uma imagem JPG, PNG, WebP ou GIF de até 5 MB.', true); event.target.value = ''; return; }
    try { imageData = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(file); $('image-preview').src = previewUrl; $('image-preview').hidden = false; $('image-remove').hidden = false; setStatus('');
    } catch { setStatus('Não foi possível abrir a imagem.', true); }
  });
  $('image-remove').addEventListener('click', () => { imageData = null; $('image-input').value = ''; $('image-preview').hidden = true; $('image-preview').removeAttribute('src'); $('image-remove').hidden = true; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; });
  $('settings').addEventListener('click', () => {
    connectionProvider = provider();
    const source = providers[connectionProvider];
    const saved = connections.get(connectionProvider);
    $('connection-help').textContent = source.label;
    const isKaggle = connectionProvider === 'kaggle';
    $('kaggle-credentials').hidden = !isKaggle;
    $('endpoint-credentials').hidden = isKaggle;
    $('endpoint').disabled = isKaggle;
    $('kaggle-user').value = kaggleCredentials?.username || '';
    $('kaggle-token').value = kaggleCredentials?.token || '';
    $('endpoint').value = saved?.url ?? '';
    $('token').value = saved?.token ?? '';
    $('model-ids').textContent = 'IDs enviados à API: ' + source.models.map(model => model[2]).join(', ');
    $('connection').showModal();
  });
  $('close').addEventListener('click', () => $('connection').close());
  $('disconnect').addEventListener('click', () => { if (connectionProvider === 'kaggle') { kaggleCredentials = undefined; try { sessionStorage.removeItem('bloxr-kaggle-session'); } catch {} } else connections.delete(connectionProvider); $('connection').close(); refresh(); setStatus('Conexão removida desta aba.'); });
  $('connection-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (connectionProvider === 'kaggle') {
      const username = $('kaggle-user').value.trim().replace(/^@/, '');
      const token = $('kaggle-token').value.trim().replace(/^Bearer\s+/i, '');
      if ((username || token) && (!/^[a-z0-9_-]{2,80}$/i.test(username) || !/^[\x21-\x7e]{12,4096}$/.test(token))) {
        $('kaggle-token').setCustomValidity('Confira o usuário do Kaggle e o token de API.');
        $('kaggle-token').reportValidity();
        return;
      }
      if (!username || !token) { setStatus('Preencha usuário e token do Kaggle.', true); return; }
      const button = event.submitter;
      if (button) { button.disabled = true; button.textContent = 'Testando conexão…'; }
      try { await kaggleRequest('check', { username, token }, {}); }
      catch (error) { $('connection-error').textContent = error.message + (error.status ? ' (HTTP ' + error.status + ')' : ''); return; }
      finally { if (button) { button.disabled = false; button.textContent = 'Testar e conectar'; } }
      $('connection-error').textContent = '';
      kaggleCredentials = { username, token };
      try { if (kaggleCredentials) sessionStorage.setItem('bloxr-kaggle-session', JSON.stringify(kaggleCredentials)); else sessionStorage.removeItem('bloxr-kaggle-session'); } catch {} 
      $('kaggle-token').value = '';
      $('connection').close();
      resetHandoff();
      refresh();
      setStatus(kaggleCredentials ? 'Conexão com a API do Kaggle confirmada. Envie uma tarefa para iniciar uma execução privada.' : 'Informe usuário e token para conectar o Kaggle.', !kaggleCredentials);
      return;
    }
    const input = $('endpoint');
    try {
      if (input.value.trim()) connections.set(connectionProvider, { url: endpointOf(input.value.trim()), token: $('token').value.trim() });
      else connections.delete(connectionProvider);
    } catch (error) {
      input.setCustomValidity(error.message);
      input.reportValidity();
      return;
    }
    $('connection').close();
    $('token').value = '';
    resetHandoff();
    refresh();
  });
  $('endpoint').addEventListener('input', () => $('endpoint').setCustomValidity(''));
  for (const id of ['kaggle-user', 'kaggle-token']) $(id).addEventListener('input', () => $('kaggle-token').setCustomValidity(''));
  $('connection').addEventListener('close', () => {
    $('kaggle-token').setCustomValidity('');
    $('kaggle-token').value = '';
    $('token').value = '';
  });
  $('resume').addEventListener('click', async () => {
    if (busy) return;
    if (!kaggleCredentials) {
      $('settings').click();
      return;
    }
    const job = savedJob();
    if (!job || job.username !== kaggleCredentials.username) {
      setStatus('A última execução pertence a outro usuário do Kaggle.', true);
      return;
    }
    setBusy(true);
    setStatus('Consultando a execução…');
    try { await watchKaggle(job, kaggleCredentials); }
    catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const platform = provider();
    const prompt = $('prompt').value.trim();
    if (!prompt) {
      setStatus('Digite o prompt.', true);
      $('prompt').focus();
      return;
    }
    const tokens = Number($('tokens').value);
    const model = providers[platform].models.find(entry => entry[0] === $('model').value);
    if (!model || !Number.isInteger(tokens) || tokens < 1 || tokens > model[3]) return;
    const connection = connections.get(platform);
    if (imageData && (platform !== 'colab' || model !== qwenVision || !connection)) { setStatus('Para analisar a imagem, selecione Google Colab e Qwen3 VL 30B e configure uma API de visão em Conexões. O envio direto ao Kaggle ainda usa modelos de texto.', true); return; }
    if (model === qwenVision && !connection) { setStatus('Configure uma API compatível com Qwen visual em Conexões.', true); return; }
    setBusy(true);
    resetHandoff();
    showOutput('');
    for (const url of resultUrls.splice(0)) URL.revokeObjectURL(url);
    $('result-images').replaceChildren();
    const credentials = platform === 'kaggle' ? kaggleCredentials : undefined;
    setStatus(credentials ? 'Enviando ao Kaggle…' : connection ? 'Aguardando a resposta do modelo…' : 'Preparando notebook…');
    try {
      if (credentials) {
        const job = { job: 'bloxr-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16), version: null, username: credentials.username };
        rememberJob(job);
        const queued = await kaggleRequest('submit', credentials, { job: job.job, model: model[0], prompt, tokens });
        job.version = queued.version;
        rememberJob(job);
        await watchKaggle(job, credentials);
      } else if (connection) {
        showOutput(await directRequest(connection, model[2], prompt, tokens, imageData));
        setStatus('');
      } else {
        const response = await fetch('./' + platform + '-notebook.json');
        if (!response.ok) throw new Error('Não foi possível carregar o modelo de notebook.');
        const notebook = notebookFor(await response.json(), platform, model[0], prompt, tokens);
        downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(notebook, null, 2)], { type: 'application/x-ipynb+json' }));
        $('notebook-download').href = downloadUrl;
        $('notebook-download').download = 'Bloxr_' + platform + '_' + model[0] + '.ipynb';
        $('provider-link').href = providers[platform].link;
        $('provider-link').textContent = 'Abrir ' + providers[platform].label + ' ↗';
        $('handoff').hidden = false;
        setStatus('');
      }
    } catch (error) {
      const message = error.name === 'TimeoutError' ? 'A conexão excedeu cinco minutos.' :
        error instanceof TypeError ? 'A conexão com o Kaggle falhou no navegador. Confira sua rede; se persistir, envie a mensagem exibida em Conexões.' : error.message;
      setStatus(message, true);
    } finally {
      setBusy(false);
    }
  });
  $('import').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('A saída de texto deve ter até 2 MB.');
      const value = await file.text();
      if (!value.trim()) throw new Error('O arquivo de saída está vazio.');
      showOutput(value);
      setStatus('');
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      event.target.value = '';
    }
  });
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('output').textContent);
      setStatus('Resposta copiada.');
    } catch {
      setStatus('Selecione o texto da resposta para copiar.', true);
    }
  });
  refresh();
}

