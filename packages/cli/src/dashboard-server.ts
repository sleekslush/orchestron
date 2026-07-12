import http from 'node:http';
import type { ConcertStore } from '@orchestron/core';

export async function startDashboardServer(
  store: ConcertStore,
  port: number,
): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/aggregates') {
        const aggregates = await store.getAggregates();
        sendJson(res, aggregates);
        return;
      }

      if (req.url === '/api/concerts') {
        const concerts = await store.listConcerts({ limit: 100 });
        sendJson(res, concerts);
        return;
      }

      const concertMatch = req.url?.match(/^\/api\/concerts\/([^/]+)$/);
      if (concertMatch) {
        const concertId = concertMatch[1];
        const concert = await store.getConcert(concertId);
        if (!concert) {
          sendJson(res, { error: 'Concert not found' }, 404);
          return;
        }
        const history = await store.getMovementHistory(concertId);
        sendJson(res, { ...concert, history });
        return;
      }

      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(dashboardHtml());
        return;
      }

      sendJson(res, { error: 'Not found' }, 404);
    } catch (err) {
      sendJson(res, { error: (err as Error).message }, 500);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  return {
    url: `http://localhost:${port}`,
    close: () => server.close(),
  };
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="5">
  <title>Orchestron Dashboard</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; background: #0f172a; color: #e2e8f0; }
    h1 { color: #38bdf8; }
    h2 { color: #94a3b8; margin-top: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1rem 0; }
    .card { background: #1e293b; padding: 1rem; border-radius: 0.5rem; }
    .card .value { font-size: 1.5rem; font-weight: bold; color: #38bdf8; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #334155; }
    th { color: #94a3b8; }
    .status-completed { color: #4ade80; }
    .status-failed { color: #f87171; }
    .status-running { color: #38bdf8; }
    .status-paused { color: #facc15; }
    .status-cancelled { color: #a78bfa; }
  </style>
</head>
<body>
  <h1>🎼 Orchestron Dashboard</h1>
  <p>Real-time overview of concerts and resource usage.</p>

  <h2>Aggregates</h2>
  <div class="grid" id="aggregates">
    <div class="card"><div>Total Concerts</div><div class="value" id="totalConcerts">—</div></div>
    <div class="card"><div>Active Concerts</div><div class="value" id="activeConcerts">—</div></div>
    <div class="card"><div>Total Spend</div><div class="value" id="totalSpend">—</div></div>
    <div class="card"><div>Total Tokens</div><div class="value" id="totalTokens">—</div></div>
    <div class="card"><div>Avg Duration</div><div class="value" id="avgDurationMs">—</div></div>
    <div class="card"><div>Failure Rate</div><div class="value" id="failureRate">—</div></div>
  </div>

  <h2>Concerts</h2>
  <table>
    <thead>
      <tr><th>ID</th><th>Score</th><th>Status</th><th>Started</th><th>Usage</th></tr>
    </thead>
    <tbody id="concerts"></tbody>
  </table>

  <script>
    async function load() {
      const [aggregates, concerts] = await Promise.all([
        fetch('/api/aggregates').then(r => r.json()),
        fetch('/api/concerts').then(r => r.json()),
      ]);

      document.getElementById('totalConcerts').textContent = aggregates.totalConcerts;
      document.getElementById('activeConcerts').textContent = aggregates.activeConcerts;
      document.getElementById('totalSpend').textContent = '$' + (aggregates.totalSpend / 1_000_000).toFixed(6);
      document.getElementById('totalTokens').textContent = aggregates.totalTokens;
      document.getElementById('avgDurationMs').textContent = aggregates.avgDurationMs ? (aggregates.avgDurationMs / 1000).toFixed(1) + 's' : '—';
      document.getElementById('failureRate').textContent = (aggregates.failureRate * 100).toFixed(1) + '%';

      const tbody = document.getElementById('concerts');
      tbody.innerHTML = concerts.map(c => \`
        <tr>
          <td>\${c.id}</td>
          <td>\${c.scoreId}</td>
          <td class="status-\${c.status}">\${c.status}</td>
          <td>\${new Date(c.startedAt).toLocaleString()}</td>
          <td>\${c.usage.spend ? '$' + (c.usage.spend / 1_000_000).toFixed(6) : '$0.000000'} / \${c.usage.tokens ?? 0} tokens</td>
        </tr>
      \`).join('');
    }
    load();
  </script>
</body>
</html>
`;
}
