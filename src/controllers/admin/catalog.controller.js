const {
  Category, Country, Partner, Product, GiftBox, Coupon, OrderItem, CuratedCollection,
} = require('../../models');
const { COUNTRIES, findIsoCountry } = require('../../constants/countries');
const { escapeRegex } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const { crudController } = require('./crud.factory');
const { ensureAllExist } = require('../../services/reference.service');
const asyncHandler = require('../../utils/asyncHandler');
const { hasPermission } = require('../../middlewares/auth');
const { audit } = require('../../services/audit.service');

// ---------------- Categories ----------------
const categories = crudController(Category, {
  resource: 'categories', label: 'Category',
  searchFields: ['name', 'slug'],
  filters: { status: 'string', parentCategoryId: 'objectId' },
  sortable: ['name', 'sortOrder', 'createdAt', 'updatedAt', 'status'],
  defaultSort: 'sortOrder',
  populate: [{ path: 'parentCategoryId', select: 'name slug' }],
  hooks: {
    beforeCreate: async (_req, data) => {
      if (data.parentCategoryId) await ensureAllExist(Category, data.parentCategoryId, 'Parent category', 'parentCategoryId');
    },
    beforeUpdate: async (_req, doc, data) => {
      if (data.parentCategoryId) {
        if (String(data.parentCategoryId) === String(doc._id)) throw ApiError.badRequest('A category cannot be its own parent');
        await ensureAllExist(Category, data.parentCategoryId, 'Parent category', 'parentCategoryId');
        // prevent cycles: walk up from the new parent
        let cursor = await Category.findById(data.parentCategoryId).select('parentCategoryId').lean();
        for (let depth = 0; cursor && depth < 20; depth += 1) {
          if (cursor.parentCategoryId && String(cursor.parentCategoryId) === String(doc._id)) {
            throw ApiError.badRequest('This parent would create a circular category tree');
          }
          cursor = cursor.parentCategoryId ? await Category.findById(cursor.parentCategoryId).select('parentCategoryId').lean() : null;
        }
      }
    },
    beforeDelete: async (_req, doc) => {
      const [products, children, coupons] = await Promise.all([
        Product.countDocuments({ categoryId: doc._id }),
        Category.countDocuments({ parentCategoryId: doc._id }),
        Coupon.countDocuments({ applicableCategories: doc._id }),
      ]);
      if (products || children || coupons) {
        throw ApiError.conflict(`Category is in use (${products} products, ${children} sub-categories, ${coupons} coupons). Set it inactive instead.`);
      }
    },
  },
});

// ---------------- Partners ----------------
const partners = crudController(Partner, {
  resource: 'partners', label: 'Partner',
  searchFields: ['name', 'city', 'email'],
  filters: { status: 'string', city: 'string', country: 'string' },
  sortable: ['name', 'city', 'createdAt', 'updatedAt', 'status'],
  defaultSort: 'name',
  hooks: {
    beforeDelete: async (_req, doc) => {
      const products = await Product.countDocuments({ partnerId: doc._id });
      if (products) throw ApiError.conflict(`Partner has ${products} product(s). Set it inactive instead.`);
    },
  },
});

// ---------------- Products ----------------
const productRefs = async (data) => {
  if (data.categoryId) await ensureAllExist(Category, data.categoryId, 'Category', 'categoryId');
  if (data.partnerId) await ensureAllExist(Partner, data.partnerId, 'Partner', 'partnerId');
  if (data.countries?.length) await ensureAllExist(Country, data.countries, 'Country', 'countries');
};
const products = crudController(Product, {
  resource: 'products', label: 'Product',
  searchFields: ['title', 'slug', 'city', 'supplierReference'],
  filters: {
    status: 'string', categoryId: 'objectId', partnerId: 'objectId', city: 'string',
    featured: 'boolean', bestSeller: 'boolean', flashSale: 'boolean',
    country: { field: 'countries', type: 'objectId' },
  },
  sortable: ['title', 'price', 'salePrice', 'createdAt', 'updatedAt', 'status', 'soldCount'],
  populate: [{ path: 'categoryId', select: 'name slug' }, { path: 'partnerId', select: 'name city' }, { path: 'countries', select: 'name code flag' }],
  hooks: {
    beforeCreate: async (_req, data) => productRefs(data),
    beforeUpdate: async (_req, _doc, data) => productRefs(data),
    beforeDelete: async (_req, doc) => {
      const [boxes, sold, collections] = await Promise.all([
        GiftBox.countDocuments({ productIds: doc._id }),
        OrderItem.countDocuments({ productId: doc._id }),
        CuratedCollection.countDocuments({ productIds: doc._id }),
      ]);
      if (sold) throw ApiError.conflict('This product has been ordered. Archive it instead of deleting it.');
      if (boxes || collections) throw ApiError.conflict(`Product is used in ${boxes} gift box(es) and ${collections} collection(s). Remove it there first.`);
    },
  },
});

// ---------------- Gift boxes ----------------
const giftBoxes = crudController(GiftBox, {
  resource: 'giftBoxes', label: 'Gift box',
  searchFields: ['name'],
  filters: { status: 'string' },
  sortable: ['name', 'price', 'createdAt', 'updatedAt', 'status'],
  populate: [{ path: 'productIds', select: 'title slug salePrice imageUrls status' }],
  hooks: {
    beforeCreate: async (_req, data) => ensureAllExist(Product, data.productIds, 'Product', 'productIds'),
    beforeUpdate: async (_req, _doc, data) => { if (data.productIds) await ensureAllExist(Product, data.productIds, 'Product', 'productIds'); },
    beforeDelete: async (_req, doc) => {
      if (await OrderItem.exists({ giftBoxId: doc._id })) throw ApiError.conflict('This gift box has been ordered. Set it inactive instead.');
    },
  },
});

// ---------------- Coupons ----------------
const couponRefs = async (data) => {
  if (data.applicableCategories?.length) await ensureAllExist(Category, data.applicableCategories, 'Category', 'applicableCategories');
  if (data.applicableProducts?.length) await ensureAllExist(Product, data.applicableProducts, 'Product', 'applicableProducts');
};
const coupons = crudController(Coupon, {
  resource: 'coupons', label: 'Coupon',
  searchFields: ['code', 'title'],
  filters: { status: 'string', discountType: 'string' },
  sortable: ['code', 'validFrom', 'validTill', 'usedCount', 'createdAt', 'updatedAt'],
  populate: [{ path: 'applicableCategories', select: 'name' }, { path: 'applicableProducts', select: 'title' }],
  hooks: {
    beforeCreate: async (_req, data) => couponRefs(data),
    beforeUpdate: async (_req, doc, data) => {
      await couponRefs(data);
      if (doc.usedCount > 0 && data.code && data.code !== doc.code) throw ApiError.conflict('The code of a coupon that has been used cannot be changed');
    },
    beforeDelete: async (_req, doc) => {
      if (doc.usedCount > 0) throw ApiError.conflict('This coupon has been used. Set it inactive instead.');
    },
  },
});

// ---------------- Countries ----------------
const nameTaken = async (name, exceptId) => Country.exists({
  name: new RegExp(`^${escapeRegex(name.trim())}$`, 'i'), ...(exceptId && { _id: { $ne: exceptId } }),
});
const countries = crudController(Country, {
  resource: 'countries', label: 'Country',
  searchFields: ['name', 'code', 'currency'],
  filters: { status: 'string' },
  sortable: ['name', 'code', 'sortOrder', 'createdAt', 'status'],
  defaultSort: 'name',
  // Product count per country, for the admin list.
  decorate: async (items) => {
    if (!items.length) return items;
    const counts = await Product.aggregate([
      { $match: { countries: { $in: items.map((c) => c._id) } } },
      { $unwind: '$countries' },
      { $group: { _id: '$countries', n: { $sum: 1 }, live: { $sum: { $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0] } } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c]));
    return items.map((c) => ({ ...c, productCount: byId.get(String(c._id))?.n || 0, liveCount: byId.get(String(c._id))?.live || 0 }));
  },
  hooks: {
    beforeCreate: async (_req, data) => {
      // "UAE" / "United States of America" become the standard name + ISO code.
      const iso = findIsoCountry(data.code) || findIsoCountry(data.name);
      if (iso && !data.code) { data.code = iso.code; data.name = iso.name; }
      if (await nameTaken(data.name)) throw ApiError.conflict(`${data.name} already exists`, [{ path: 'name', message: 'Already added' }]);
    },
    beforeUpdate: async (_req, doc, data) => {
      if (data.name && await nameTaken(data.name, doc._id)) throw ApiError.conflict(`${data.name} already exists`, [{ path: 'name', message: 'Already added' }]);
    },
    beforeDelete: async (_req, doc) => {
      const n = await Product.countDocuments({ countries: doc._id });
      if (n) throw ApiError.conflict(`${n} product(s) are sold in ${doc.name}. Hide the country instead, or remove it from those products first.`);
    },
  },
});

// ---------------- Product bulk actions ----------------
const BULK_LIMIT = 5000;
/**
 * POST /admin/products/bulk  { action: 'setStatus' | 'delete', status?, ids? | filter? }
 * `filter` uses the same fields as the product list, so "select all matching" acts on exactly what the admin sees.
 * Deleting skips products that are ordered or used in gift boxes / collections and reports why.
 */
const productBulk = asyncHandler(async (req, res) => {
  const { action, status, ids, filter } = req.body;
  const need = action === 'delete' ? 'products.delete' : 'products.update';
  if (!hasPermission(req.user.permissions, need)) throw ApiError.forbidden();

  const query = ids?.length ? { _id: { $in: ids } } : products.filterFromQuery(filter || {});
  const total = await Product.countDocuments(query);
  if (total === 0) throw ApiError.badRequest('No products match this selection');
  if (total > BULK_LIMIT) throw ApiError.badRequest(`Select at most ${BULK_LIMIT} products at a time (this selection has ${total})`);

  if (action === 'setStatus') {
    // Only products whose status actually changes are touched (and counted).
    const r = await Product.updateMany({ $and: [query, { status: { $ne: status } }] }, { $set: { status, updatedBy: req.user._id } });
    audit(req, { action: 'products.bulkStatus', resource: 'products', summary: `Set ${r.modifiedCount} product(s) to ${status}`, changes: { status: { from: null, to: status }, count: { from: null, to: r.modifiedCount } } });
    return res.json({ success: true, data: { action, status, matched: total, updated: r.modifiedCount } });
  }

  const docs = await Product.find(query).select('_id title').lean();
  const docIds = docs.map((d) => d._id);
  const [ordered, boxes, collections] = await Promise.all([
    OrderItem.distinct('productId', { productId: { $in: docIds } }),
    GiftBox.distinct('productIds', { productIds: { $in: docIds } }),
    CuratedCollection.distinct('productIds', { productIds: { $in: docIds } }),
  ]);
  const why = new Map();
  for (const id of collections) why.set(String(id), 'Used in a collection');
  for (const id of boxes) why.set(String(id), 'Used in a gift box');
  for (const id of ordered) why.set(String(id), 'Has been ordered — archive it instead');
  const deletable = docs.filter((d) => !why.has(String(d._id))).map((d) => d._id);
  const r = deletable.length ? await Product.deleteMany({ _id: { $in: deletable } }) : { deletedCount: 0 };
  const skipped = docs.filter((d) => why.has(String(d._id))).map((d) => ({ _id: d._id, title: d.title, reason: why.get(String(d._id)) }));
  audit(req, { action: 'products.bulkDelete', resource: 'products', summary: `Deleted ${r.deletedCount} product(s)${skipped.length ? `, kept ${skipped.length} in use` : ''}` });
  return res.json({ success: true, data: { action, matched: total, deleted: r.deletedCount, skipped } });
});

/** ISO reference list for the "add country" picker. */
const isoCountries = (_req, res) => res.json({ success: true, data: COUNTRIES.map(({ code, name, currency }) => ({ code, name, currency })) });

module.exports = {
  categories, countries, isoCountries, partners, products, productBulk, giftBoxes, coupons,
};
