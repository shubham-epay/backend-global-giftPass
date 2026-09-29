const { Category, Partner, Product, GiftBox, Coupon, OrderItem, CuratedCollection } = require('../../models');
const ApiError = require('../../utils/ApiError');
const { crudController } = require('./crud.factory');
const { ensureAllExist } = require('../../services/reference.service');

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
};
const products = crudController(Product, {
  resource: 'products', label: 'Product',
  searchFields: ['title', 'slug', 'city', 'supplierReference'],
  filters: {
    status: 'string', categoryId: 'objectId', partnerId: 'objectId', city: 'string',
    featured: 'boolean', bestSeller: 'boolean', flashSale: 'boolean',
  },
  sortable: ['title', 'price', 'salePrice', 'createdAt', 'updatedAt', 'status', 'soldCount'],
  populate: [{ path: 'categoryId', select: 'name slug' }, { path: 'partnerId', select: 'name city' }],
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

module.exports = { categories, partners, products, giftBoxes, coupons };
