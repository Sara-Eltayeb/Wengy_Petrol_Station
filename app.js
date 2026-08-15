const config = window.FUELGUARD_CONFIG || {};
const apiBase = String(config.apiBase || '').replace(/\/$/, '');
const apiUrl = (path) => `${apiBase}${path}`;
const formatNumber = (value) => new Intl.NumberFormat('en-FR').format(value);

function setValue(key, value) {
  document.querySelectorAll(`[data-fuel="${key}"]`).forEach((node) => {
    node.textContent = value == null ? '--' : value;
  });
}

function setSource(name, connected) {
  document.querySelectorAll(`[data-source-status="${name}"]`).forEach((node) => {
    node.classList.toggle('connected', connected);
    node.innerHTML = `<i></i> ${connected ? 'Connected' : 'Unavailable'}`;
  });
  document.querySelectorAll(`[data-source-status-text="${name}"]`).forEach((node) => {
    node.textContent = connected ? 'Connected' : 'Unavailable';
  });
}

async function loadLiveData() {
  const endpoints = config.endpoints || {};
  const names = ['sheets', 'daily', 'config', 'supplier', 'market'];
  await Promise.all(names.map(async (name) => {
    if (!endpoints[name]) return;
    try {
      const response = await fetch(endpoints[name], { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setSource(name, true);
      if (name === 'daily') {
        if (data.petrolLitres != null) setValue('petrol-litres', formatNumber(data.petrolLitres));
        if (data.dieselLitres != null) setValue('diesel-litres', formatNumber(data.dieselLitres));
        if (data.petrolPercent != null) { setValue('petrol-percent', `${data.petrolPercent}%`); document.querySelector('[data-fuel="petrol-fill"]').style.width = `${data.petrolPercent}%`; }
        if (data.dieselPercent != null) { setValue('diesel-percent', `${data.dieselPercent}%`); document.querySelector('[data-fuel="diesel-fill"]').style.width = `${data.dieselPercent}%`; }
        if (data.petrolDays != null) setValue('petrol-days', data.petrolDays);
        if (data.dieselDays != null) setValue('diesel-days', data.dieselDays);
      }
      Object.entries(data).forEach(([key, value]) => setValue(key, value));
    } catch (error) { setSource(name, false); }
  }));
  document.getElementById('refresh-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function loadServerSources() {
  let sources;
  try {
    const response = await fetch(apiUrl('/api/sources'));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    sources = await response.json();
  } catch (error) {
    try {
      const snapshot = await fetch('./data/runs/latest.json');
      if (!snapshot.ok) return;
      sources = (await snapshot.json()).sources;
    } catch (snapshotError) {
      return;
    }
  }
  try {
    Object.entries(sources).forEach(([name, source]) => setSource(name, source.status === 'CONNECTED'));
    applyFuelRows(sources.daily?.data || sources.sheets?.data);
    applyMarketData(sources.market?.data);
    applyMarketData(sources.marketPetrol?.data);
    document.getElementById('refresh-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (error) {
    // Keep the dashboard usable if a source has an unexpected shape.
  }
}

function litres(value) {
  return Number(String(value ?? '').replace(/[^0-9.-]/g, '')) || 0;
}

function applyFuelRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const fuels = { Petrol: 'petrol', Diesel: 'diesel' };
  Object.entries(fuels).forEach(([fuelName, key]) => {
    const fuelRows = rows.filter((row) => String(row.Fuel_Type).toLowerCase() === fuelName.toLowerCase());
    if (!fuelRows.length) return;
    const latest = fuelRows[fuelRows.length - 1];
    const stock = litres(latest.Closing_Stock_L);
    const capacity = litres(latest.Tank_Capacity_L);
    const recent = fuelRows.slice(-7).map((row) => litres(row.Sales_L)).filter(Boolean);
    const averageSales = recent.reduce((sum, value) => sum + value, 0) / (recent.length || 1);
    const percent = Math.round((stock / capacity) * 100);
    setValue(`${key}-litres`, formatNumber(stock));
    setValue(`${key}-percent`, `${percent}%`);
    setValue(`${key}-days`, (stock / averageSales).toFixed(1));
    setValue(`${key}-capacity`, `${formatNumber(capacity)} L capacity`);
    setValue(`${key}-sales`, `${formatNumber(Math.round(averageSales))} L`);
     document.querySelectorAll(`[data-fuel="${key}-fill"]`).forEach((fill) => {
       fill.style.width = `${Math.min(percent, 100)}%`;
       if (fill.closest('.tank-visual')) fill.style.height = `${Math.min(percent, 100)}%`;
     });
    if (key === 'petrol') setValue('reorder-level', formatNumber(Math.round(averageSales * 3)));
    if (key === 'diesel') setValue('safety-stock', formatNumber(Math.round(averageSales * 2)));
    if (key === 'diesel') {
      setValue('rec-stock', `${formatNumber(stock)} L`);
      setValue('rec-coverage', `${(stock / averageSales).toFixed(1)} days`);
      setValue('rec-order', `${formatNumber(Math.max(0, capacity - stock))} L`);
    }
  });
}

function applyMarketData(data) {
  if (!data || Array.isArray(data)) return;
  const market = data.data || data;
  const price = market.avgPrice1d ?? market.averagePrice ?? market.price;
  if (price == null) return;
  const fuel = String(market.fuelType || '').toLowerCase();
  const key = fuel.includes('gazole') || fuel.includes('diesel') ? 'diesel-price' : fuel.includes('petrol') || fuel.includes('essence') || fuel.includes('sp') ? 'petrol-price' : null;
  if (key) setValue(key, Number(price).toFixed(3));
  if (data.meta?.generated_at || market.computedAt) setValue('market-updated', new Date(data.meta?.generated_at || market.computedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }));
  if (market.trend1d != null) setValue('market-context', `${Number(market.trend1d) >= 0 ? '+' : ''}${market.trend1d} €/L today`);
}

document.getElementById('date-label').textContent = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
loadLiveData();
loadServerSources();

document.querySelector('.mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));

const pipelineButton = document.createElement('button');
pipelineButton.className = 'pipeline-button';
pipelineButton.textContent = 'Run AI pipeline';
document.querySelector('.top-actions').prepend(pipelineButton);

function applyPipelineRun(run) {
  if (!run) return;
  Object.entries(run.sources || {}).forEach(([name, source]) => setSource(name, source.status === 'CONNECTED'));
  if (run.completedAt) document.getElementById('refresh-time').textContent = new Date(run.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const manager = run.outputs?.manager || '';
  const verdict = manager.match(/VERDICT:\s*(.*)/i)?.[1]
    || manager.match(/Priority decision\*\*\s*\n\s*\*\*([^*]+)\*\*\.\s*([^\n]+)/i)?.slice(1).join(': ');
  if (verdict) setValue('manager-verdict', verdict);
  let outputPanel = document.getElementById('handoff-outputs');
  if (!outputPanel) {
    outputPanel = document.createElement('div');
    outputPanel.id = 'handoff-outputs';
    outputPanel.className = 'handoff-outputs';
    document.querySelector('.team-pipeline')?.after(outputPanel);
  }
  if (run.outputs) {
    outputPanel.replaceChildren();
    const handoffs = [
      ['researcher', 'Researcher output', 'Passed to Designer'],
      ['designer', 'Designer output', 'Passed to Maker'],
      ['maker', 'Maker output', 'Passed to Marketer'],
      ['marketer', 'Marketer output', 'Passed to Manager'],
      ['manager', 'Manager output', 'Final decision']
    ];
    handoffs.forEach(([agent, label, next]) => {
      if (!run.outputs[agent]) return;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = label;
      const handoff = document.createElement('span');
      handoff.textContent = next;
      summary.append(handoff);
      const output = document.createElement('pre');
      output.textContent = run.outputs[agent];
      details.append(summary, output);
      outputPanel.append(details);
    });
  }
}

async function loadLatestPipeline() {
  try {
    const response = await fetch(apiUrl('/api/pipeline/latest'));
    if (response.ok) applyPipelineRun(await response.json());
  } catch (error) {
    // The dashboard remains usable when opened without the server.
  }
}

pipelineButton.addEventListener('click', async () => {
  pipelineButton.disabled = true;
  pipelineButton.textContent = 'Agents working...';
  try {
    const response = await fetch(apiUrl('/api/pipeline/run'), { method: 'POST' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    applyPipelineRun(await response.json());
    pipelineButton.textContent = 'Pipeline complete';
  } catch (error) {
    console.error('FuelGuard pipeline failed:', error);
    pipelineButton.textContent = `Pipeline failed: ${error.message}`;
    pipelineButton.title = error.message;
  } finally {
    setTimeout(() => { pipelineButton.disabled = false; pipelineButton.textContent = 'Run AI pipeline'; }, 2600);
  }
});

loadLatestPipeline();
