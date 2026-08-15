import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const runsDir = join(root, 'data', 'runs');
mkdirSync(runsDir, { recursive: true });

function loadDotEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  });
}
loadDotEnv();

const agents = ['researcher', 'designer', 'maker', 'marketer', 'manager'];
const json = (value) => JSON.stringify(value, null, 2);
const sourceEndpoints = {
  sheets: 'GOOGLE_SHEETS_API_URL',
  daily: 'DAILY_FUEL_DATA_API_URL',
  config: 'STATION_CONFIG_API_URL',
  supplier: 'SUPPLIER_DATA_API_URL',
  market: 'FRENCH_MARKET_API_URL',
  marketPetrol: 'FRENCH_MARKET_PETROL_API_URL'
};
const defaultSourceUrls = {
  sheets: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSKT9YZb22fbZZ4N4E09kYvD55jhzzpZ8vLpMPXSe4XE6uY1xL9mf6nq9SaXTv0ycbCdNqAeqKdpARc/pub?output=csv'
};

const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://sara-eltayeb.github.io',
  process.env.FRONTEND_ORIGIN
].filter(Boolean));

function sourceUrl(name) {
  const configured = process.env[sourceEndpoints[name]] || defaultSourceUrls[name];
  if (configured || name !== 'marketPetrol') return configured;
  const marketUrl = process.env.FRENCH_MARKET_API_URL;
  if (!marketUrl) return undefined;
  try {
    const url = new URL(marketUrl);
    url.searchParams.set('fuel', 'e10');
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === ',' && !quoted) { row.push(cell.trim()); cell = ''; continue; }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim()); cell = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
      continue;
    }
    cell += character;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

async function fetchSource(name) {
  const url = sourceUrl(name);
  if (!url) return { name, status: 'UNAVAILABLE', reason: 'Endpoint is not configured', fetchedAt: new Date().toISOString() };
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    const data = contentType.includes('json') || url.includes('output=json') ? JSON.parse(body) : parseCsv(body);
    return { name, status: 'CONNECTED', fetchedAt: new Date().toISOString(), data };
  } catch (error) {
    return { name, status: 'UNAVAILABLE', reason: error.message, fetchedAt: new Date().toISOString() };
  }
}

async function listAvailableModels() {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`);
  if (!response.ok) {
    const error = new Error(`Gemini model discovery ${response.status}: ${await response.text()}`);
    error.statusCode = response.status;
    throw error;
  }
  const payload = await response.json();
  const models = (payload.models || []).filter((model) => model.supportedGenerationMethods?.includes('generateContent'));
  const preference = ['gemini-3.1-flash-preview', 'gemini-3-flash-preview', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
  const ordered = [];
  for (const preferred of preference) {
    const match = models.find((model) => model.name === `models/${preferred}`);
    if (match) ordered.push(match.name.replace(/^models\//, ''));
  }
  models.forEach((model) => {
    const name = model.name.replace(/^models\//, '');
    if (!ordered.includes(name)) ordered.push(name);
  });
  if (!ordered.length) throw new Error('Gemini returned no models that support generateContent');
  return ordered;
}

async function requestGemini(model, persona, input) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: persona }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      generationConfig: { temperature: 0.2 }
    })
  });
}

async function requestOpenRouter(agent, persona, input) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.FRONTEND_ORIGIN || 'https://sara-eltayeb.github.io',
      'X-Title': 'Wengy FuelGuard AI'
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: persona },
        { role: 'user', content: input }
      ],
      temperature: 0.2
    })
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned no text');
  return text;
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  const direct = typeof value.text === 'string' ? value.text : '';
  const nested = Object.entries(value)
    .filter(([key]) => !['text', 'id', 'type', 'status', 'model', 'role', 'created', 'updated'].includes(key))
    .map(([, child]) => extractText(child))
    .filter(Boolean)
    .join('\n');
  return [direct, nested].filter(Boolean).join('\n');
}

function extractGeminiText(payload) {
  return payload.candidates?.flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n') || extractText(payload.output_text || payload.outputs || payload.output || payload.content || payload.steps);
}

async function waitForInteraction(id) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(id)}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Gemini interaction polling ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    if (payload.status === 'failed' || payload.status === 'cancelled') throw new Error(`Gemini interaction ${payload.status}`);
    if (payload.status === 'completed' || extractText(payload.outputs) || extractText(payload.output) || extractText(payload.steps)) return payload;
  }
  throw new Error('Gemini interaction timed out after 45 seconds');
}

async function callGemini(agent, input) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
  const persona = readFileSync(join(root, 'agents', `${agent}.md`), 'utf8');
  const discovered = await listAvailableModels();
  const candidates = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL, ...discovered.filter((name) => name !== process.env.GEMINI_MODEL)] : discovered;
  let response;
  let lastError = '';
  for (const model of candidates) {
    response = await requestGemini(model, persona, input);
    if (response.ok) break;
    lastError = await response.text();
    if (response.status !== 404) break;
  }
  if (!response?.ok) {
    const error = new Error(`Gemini ${response?.status || 500}: ${lastError}`);
    error.statusCode = response?.status || 500;
    throw error;
  }
  let payload = await response.json();
  if (!extractGeminiText(payload) && payload.id) payload = await waitForInteraction(payload.id);
  const text = extractGeminiText(payload);
  if (!text) throw new Error(`Gemini returned no text (response keys: ${Object.keys(payload).join(', ')})`);
  return text;
}

async function callLlm(agent, input) {
  const provider = String(process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (provider === 'openrouter' || process.env.OPENROUTER_API_KEY) {
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
    const persona = readFileSync(join(root, 'agents', `${agent}.md`), 'utf8');
    return requestOpenRouter(agent, persona, input);
  }
  return callGemini(agent, input);
}

async function runPipeline() {
  const startedAt = new Date().toISOString();
  const sources = {};
  for (const name of Object.keys(sourceEndpoints)) sources[name] = await fetchSource(name);
  const outputs = {};
  const base = `Station: Wengy Petrol Station, France\nSource snapshot:\n${json(sources)}`;
   outputs.researcher = await callLlm('researcher', `${base}\n\nAnalyse these live source results. Return your required evidence brief.\n${json(sources)}`);
   outputs.designer = await callLlm('designer', `${base}\n\nRESEARCHER ACTUAL OUTPUT:\n${outputs.researcher}`);
   outputs.maker = await callLlm('maker', `${base}\n\nRESEARCHER ACTUAL OUTPUT:\n${outputs.researcher}\n\nDESIGNER ACTUAL OUTPUT:\n${outputs.designer}`);
   outputs.marketer = await callLlm('marketer', `${base}\n\nRESEARCHER ACTUAL OUTPUT:\n${outputs.researcher}\n\nDESIGNER ACTUAL OUTPUT:\n${outputs.designer}\n\nMAKER ACTUAL OUTPUT:\n${outputs.maker}`);
   outputs.manager = await callLlm('manager', `${base}\n\nRESEARCHER:\n${outputs.researcher}\n\nDESIGNER:\n${outputs.designer}\n\nMAKER:\n${outputs.maker}\n\nMARKETER:\n${outputs.marketer}`);
  const run = { id: startedAt.replace(/[:.]/g, '-'), startedAt, completedAt: new Date().toISOString(), sources, outputs };
  writeFileSync(join(runsDir, `${run.id}.json`), json(run));
  writeFileSync(join(runsDir, 'latest.json'), json(run));
  return run;
}

function latestRun() {
  const file = join(runsDir, 'latest.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const file = join(root, requested);
  if (!file.startsWith(root) || !existsSync(file)) return false;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  response.writeHead(200, { 'Content-Type': `${types[extname(file)] || 'text/plain'}; charset=utf-8` });
  response.end(readFileSync(file));
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const origin = request.headers.origin;
    if (allowedOrigins.has(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === '/api/sources') {
      const sources = {};
      for (const name of Object.keys(sourceEndpoints)) sources[name] = await fetchSource(name);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(json(sources));
      return;
    }
    if (request.url === '/api/pipeline/latest') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(json(latestRun())); return; }
    if (request.url === '/api/pipeline/run' && request.method === 'POST') { const run = await runPipeline(); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(json(run)); return; }
    if (!serveStatic(request, response)) { response.writeHead(404); response.end('Not found'); }
  } catch (error) {
    console.error('FuelGuard request failed:', error.message);
    response.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' });
    response.end(json({ error: error.message }));
  }
});

server.listen(Number(process.env.PORT || 3000), () => console.log(`FuelGuard running on http://localhost:${process.env.PORT || 3000}`));
