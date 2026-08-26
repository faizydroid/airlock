import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = import.meta.dirname;

// Read on each request so edits are picked up without a restart.
function page(name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

const routes = {
  '/': 'agent.html',        // agent-facing probe: canaries + 6 tools + two-phase approval
  '/agent': 'agent.html',
  '/api': 'page.html'       // API-shape probe: namespace, annotations, validation, executeTool
};

// Base port is overridable: PROBE_PORT=9300 node probe/server.mjs
const base = Number(process.env.PROBE_PORT || 8201);

// port -> Origin-Agent-Cluster header value (null = omit the header).
// Three origins so E12 can compare default / explicit opt-in / explicit opt-out.
const configs = { [base]: null, [base + 1]: '?1', [base + 2]: '?0' };

for (const [port, oac] of Object.entries(configs)) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0].replace(/\/+$/, '') || '/';
    const file = routes[url];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found. try / (agent probe) or /api (api-shape probe)');
      return;
    }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    if (oac !== null) headers['Origin-Agent-Cluster'] = oac;
    res.writeHead(200, headers);
    res.end(page(file));
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`port ${port} in use — rerun with PROBE_PORT=<n> to pick a different base`);
    } else {
      console.error(`port ${port}: ${e.message}`);
    }
  });

  server.listen(Number(port), '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${port}/      agent probe   OAC=${oac ?? '(omitted)'}`);
    console.log(`http://127.0.0.1:${port}/api   api probe     OAC=${oac ?? '(omitted)'}`);
  });
}
