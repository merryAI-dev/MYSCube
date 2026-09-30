const routes = new Map([
  ['/api/slack/events', ['POST']],
  ['/api/slack/interactions', ['POST']],
  ['/api/internal/workers/settlement-agent/run', ['GET']],
  ['/api/v1/merryhere/connect', ['GET', 'POST']],
  ...['register', 'poll', 'approve', 'permit', 'complete'].map(action => [`/api/v1/merryhere/local/${action}`, ['POST']]),
]);

export function createSlackServiceHandler(app, { release } = {}) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.searchParams.get('__path') || url.pathname;
    if (path === '/healthz' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store');
      return res.status(200).json({ ok: true, service: 'mysc-slack-agent', release });
    }
    if (!routes.get(path)?.includes(req.method)) return res.status(404).json({ error: 'not_found' });
    url.searchParams.delete('__path');
    req.url = path + (url.searchParams.size ? `?${url.searchParams}` : '');
    return app(req, res);
  };
}
