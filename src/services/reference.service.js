const ApiError = require('../utils/ApiError');

/** Ensures every id in `ids` exists in `Model`; throws 422 listing the missing ones. */
async function ensureAllExist(Model, ids, label, field) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
  if (!list.length) return;
  const unique = [...new Set(list)];
  const found = await Model.find({ _id: { $in: unique } }).select('_id').lean();
  if (found.length !== unique.length) {
    const have = new Set(found.map((d) => String(d._id)));
    const missing = unique.filter((id) => !have.has(id));
    throw new ApiError(422, 'INVALID_REFERENCE', `${label} not found`, [{ path: field, message: `Unknown ${label.toLowerCase()}: ${missing.join(', ')}` }]);
  }
}

module.exports = { ensureAllExist };
