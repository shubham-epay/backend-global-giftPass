const { Banner, CuratedCollection, Blog, Faq, Product } = require('../../models');
const { crudController } = require('./crud.factory');
const { ensureAllExist } = require('../../services/reference.service');

const banners = crudController(Banner, {
  resource: 'banners', label: 'Banner',
  searchFields: ['title', 'subtitle'],
  filters: { status: 'string', placement: 'string' },
  sortable: ['title', 'sortOrder', 'startDate', 'endDate', 'createdAt'],
  defaultSort: 'sortOrder',
});

const collections = crudController(CuratedCollection, {
  resource: 'collections', label: 'Collection',
  searchFields: ['title', 'slug'],
  filters: { status: 'string', showOnHome: 'boolean' },
  sortable: ['title', 'sortOrder', 'createdAt'],
  defaultSort: 'sortOrder',
  populate: [{ path: 'productIds', select: 'title slug' }],
  hooks: {
    beforeCreate: async (_req, data) => ensureAllExist(Product, data.productIds, 'Product', 'productIds'),
    beforeUpdate: async (_req, _doc, data) => ensureAllExist(Product, data.productIds, 'Product', 'productIds'),
  },
});

const blogs = crudController(Blog, {
  resource: 'blogs', label: 'Blog post',
  searchFields: ['title', 'slug', 'authorName'],
  filters: { status: 'string', tag: { field: 'tags', type: 'string' } },
  sortable: ['title', 'publishedAt', 'createdAt', 'updatedAt'],
  listSelect: '-content',
});

const faqs = crudController(Faq, {
  resource: 'faqs', label: 'FAQ',
  searchFields: ['question', 'answer', 'group'],
  filters: { status: 'string', group: 'string' },
  sortable: ['group', 'sortOrder', 'createdAt'],
  defaultSort: 'sortOrder',
});

module.exports = { banners, collections, blogs, faqs };
