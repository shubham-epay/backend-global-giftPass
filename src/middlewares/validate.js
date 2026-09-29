/** Parses (and strips unknown keys from) body / query / params with zod schemas. */
module.exports = ({ body, query, params } = {}) => (req, _res, next) => {
  try {
    if (params) req.params = params.parse(req.params);
    if (query) req.query = query.parse(req.query);
    if (body) req.body = body.parse(req.body ?? {});
    next();
  } catch (err) {
    next(err);
  }
};
