const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { escapeRegex, isObjectId } = require('../../utils/helpers');
const { audit, diff } = require('../../services/audit.service');

/**
 * Generic, secured CRUD controller.
 *
 * options:
 *  resource      audit/resource key, e.g. 'products'
 *  label         human label, e.g. 'Product'
 *  searchFields  fields matched case-insensitively by ?q=
 *  filters       { queryKey: 'string' | 'boolean' | 'objectId' | { field, type } }
 *  sortable      whitelisted sort fields
 *  defaultSort   e.g. '-createdAt'
 *  populate      mongoose populate spec for list and detail
 *  listSelect    projection for list
 *  hooks         { beforeCreate(req, data), beforeUpdate(req, doc, data), beforeDelete(req, doc) }
 */
function crudController(Model, options) {
  const {
    resource, label, searchFields = [], filters = {}, sortable = ['createdAt', 'updatedAt'],
    defaultSort = '-createdAt', populate = [], listSelect, hooks = {},
  } = options;

  const castFilterValue = (type, raw) => {
    if (type === 'boolean') {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw ApiError.badRequest(`Invalid boolean filter value "${raw}"`);
    }
    if (type === 'objectId') {
      if (raw === 'null') return null;
      if (!isObjectId(raw)) throw ApiError.badRequest('Invalid id filter');
      return new mongoose.Types.ObjectId(raw);
    }
    return String(raw);
  };

  const buildFilter = (query) => {
    const filter = {};
    for (const [key, spec] of Object.entries(filters)) {
      const raw = query[key];
      if (raw === undefined || raw === '') continue;
      const { field = key, type = 'string' } = typeof spec === 'string' ? { type: spec } : spec;
      filter[field] = castFilterValue(type, raw);
    }
    if (query.q && searchFields.length) {
      const rx = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = searchFields.map((f) => ({ [f]: rx }));
    }
    if (query.ids) {
      const ids = query.ids.split(',').filter(isObjectId);
      filter._id = { $in: ids };
    }
    return filter;
  };

  const buildSort = (sort) => {
    const s = sort || defaultSort;
    const field = s.replace(/^-/, '');
    if (!sortable.includes(field)) return { [defaultSort.replace(/^-/, '')]: defaultSort.startsWith('-') ? -1 : 1, _id: -1 };
    return { [field]: s.startsWith('-') ? -1 : 1, _id: -1 };
  };

  const list = asyncHandler(async (req, res) => {
    const { page, limit, sort } = req.query;
    const filter = options.buildFilter ? await options.buildFilter(req, buildFilter(req.query)) : buildFilter(req.query);
    let query = Model.find(filter).sort(buildSort(sort)).skip((page - 1) * limit).limit(limit);
    if (listSelect) query = query.select(listSelect);
    if (populate.length) query = query.populate(populate);
    const [items, total] = await Promise.all([query.lean({ virtuals: true }), Model.countDocuments(filter)]);
    res.json({ success: true, data: items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
  });

  const getOne = asyncHandler(async (req, res) => {
    let query = Model.findById(req.params.id);
    if (populate.length) query = query.populate(populate);
    const doc = await query;
    if (!doc) throw ApiError.notFound(label);
    res.json({ success: true, data: doc });
  });

  const create = asyncHandler(async (req, res) => {
    const data = { ...req.body };
    if (hooks.beforeCreate) await hooks.beforeCreate(req, data);
    if (Model.schema.path('createdBy')) data.createdBy = req.user._id;
    const doc = await Model.create(data);
    audit(req, { action: `${resource}.create`, resource, resourceId: doc._id, summary: `Created ${label.toLowerCase()} "${doc.name || doc.title || doc.code || doc.question || doc._id}"` });
    res.status(201).json({ success: true, data: doc });
  });

  const update = asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw ApiError.notFound(label);
    const data = { ...req.body };
    if (hooks.beforeUpdate) await hooks.beforeUpdate(req, doc, data);
    const before = doc.toObject();
    doc.set(data);
    if (Model.schema.path('updatedBy')) doc.updatedBy = req.user._id;
    const changes = diff(before, doc);
    await doc.save();
    if (Object.keys(changes).length) {
      audit(req, { action: `${resource}.update`, resource, resourceId: doc._id, summary: `Updated ${label.toLowerCase()}`, changes });
    }
    res.json({ success: true, data: doc });
  });

  const remove = asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw ApiError.notFound(label);
    if (hooks.beforeDelete) await hooks.beforeDelete(req, doc);
    await doc.deleteOne();
    audit(req, { action: `${resource}.delete`, resource, resourceId: doc._id, summary: `Deleted ${label.toLowerCase()} "${doc.name || doc.title || doc.code || doc.question || doc._id}"` });
    res.json({ success: true, data: { _id: doc._id } });
  });

  return { list, getOne, create, update, remove };
}

module.exports = { crudController };
