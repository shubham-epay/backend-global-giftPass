const { routeContext, forLog } = require('../utils/logSafe');

/**
 * Logs every API call: the route, what a POST/PUT/PATCH/DELETE sends, and what it answers.
 * Also remembers the route for the request, so the SynraPay calls it makes are logged against it.
 */
module.exports = (req, res, next) => {
  const ctx = { method: req.method, path: req.originalUrl.split('?')[0], id: req.id };
  const tag = `[api] ${ctx.method} ${ctx.path} #${String(req.id).slice(0, 8)}`;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (write) console.log(`${tag} -> request: ${forLog(req.body ?? {})}`);
  else console.log(`${tag} ->${Object.keys(req.query || {}).length ? ` query: ${forLog(req.query)}` : ''}`);

  const started = Date.now();
  const json = res.json.bind(res);
  res.json = (body) => {
    const ms = Date.now() - started;
    // Writes and errors in full; a successful GET by size only (catalog lists are large).
    if (write || res.statusCode >= 400) console.log(`${tag} <- ${res.statusCode} (${ms} ms) response: ${forLog(body)}`);
    else console.log(`${tag} <- ${res.statusCode} (${ms} ms) ${Buffer.byteLength(JSON.stringify(body ?? null))} bytes`);
    return json(body);
  };
  routeContext.run(ctx, next);
};
