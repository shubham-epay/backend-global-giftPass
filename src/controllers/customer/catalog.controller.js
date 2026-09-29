const {
  Banner, Category, Product, GiftBox, CuratedCollection, Review,
} = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { escapeRegex } = require('../../utils/helpers');
const { PRODUCT_CARD_FIELDS, GIFT_BOX_CARD_FIELDS } = require('../../services/pricing.service');

const PARTNER_PUBLIC = 'name city country address website logoUrl coverImageUrl galleryUrls workingHours description';
const CATEGORY_PUBLIC = 'name slug description iconUrl bannerUrl parentCategoryId sortOrder seoTitle seoDescription';

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  price_asc: { salePrice: 1, _id: 1 },
  price_desc: { salePrice: -1, _id: -1 },
  popular: { soldCount: -1, _id: -1 },
  rating: { ratingAvg: -1, ratingCount: -1, _id: -1 },
  title: { title: 1, _id: 1 },
};

const publicCache = (res, seconds = 60) => res.set('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=${seconds * 5}`);

const activeBannerFilter = (placement) => {
  const now = new Date();
  return {
    status: 'ACTIVE',
    ...(placement && { placement }),
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
    ],
  };
};

/**
 * Storefront shape of a banner: a heading, a line of text and an optional button laid over the image.
 * The raw fields are kept alongside for convenience.
 */
const publicBanner = (b) => ({
  _id: b._id,
  placement: b.placement,
  sortOrder: b.sortOrder,
  heading: b.title,
  text: b.subtitle || null,
  button: b.buttonText && b.buttonLink
    ? { text: b.buttonText, link: b.buttonLink, color: b.buttonColor || '#E0435A', openInNewTab: Boolean(b.openInNewTab) }
    : null,
  image: { desktop: b.imageUrl, mobile: b.mobileImageUrl || b.imageUrl, alt: b.imageAlt || b.title },
  textPosition: b.textPosition || 'LEFT',
  textTheme: b.textTheme || 'DARK',
  startDate: b.startDate,
  endDate: b.endDate,
});

const cards = (filter, { sort = SORTS.newest, limit = 12, skip = 0 } = {}) => Product.find({ status: 'ACTIVE', ...filter })
  .select(PRODUCT_CARD_FIELDS)
  .populate('categoryId', 'name slug')
  .populate('partnerId', 'name city')
  .sort(sort).skip(skip).limit(limit).lean();

/** Shared product-list filter from query string (city, price range, merchandising flags). */
function listFilter(query) {
  const f = {};
  if (query.city) f.city = new RegExp(`^${escapeRegex(query.city)}$`, 'i');
  if (query.minPrice != null || query.maxPrice != null) {
    f.salePrice = { ...(query.minPrice != null && { $gte: query.minPrice }), ...(query.maxPrice != null && { $lte: query.maxPrice }) };
  }
  for (const flag of ['featured', 'bestSeller', 'flashSale']) if (query[flag]) f[flag] = query[flag] === 'true';
  return f;
}

async function paginated(res, filter, query, extra = {}) {
  const { page, limit, sort } = query;
  const full = { status: 'ACTIVE', ...filter };
  const [items, total] = await Promise.all([
    cards(full, { sort: SORTS[sort] || SORTS.newest, limit, skip: (page - 1) * limit }),
    Product.countDocuments(full),
  ]);
  res.json({ success: true, data: { ...extra, items }, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
}

/** All ids in the subtree rooted at `rootId` (inclusive), walking at most 5 levels. */
async function descendantIds(rootId) {
  const ids = [rootId];
  let frontier = [rootId];
  for (let depth = 0; depth < 5 && frontier.length; depth += 1) {
    // eslint-disable-next-line no-await-in-loop
    const children = await Category.find({ parentCategoryId: { $in: frontier }, status: 'ACTIVE' }).select('_id').lean();
    frontier = children.map((c) => c._id);
    ids.push(...frontier);
  }
  return ids;
}

// ---------------- Homepage ----------------
const home = asyncHandler(async (_req, res) => {
  const [banners, categories, featured, bestSellers, flashSale, newArrivals, collections, giftBoxes] = await Promise.all([
    Banner.find(activeBannerFilter()).select('-createdBy -updatedBy').sort({ sortOrder: 1, createdAt: -1 }).lean(),
    Category.find({ status: 'ACTIVE', parentCategoryId: null }).select(CATEGORY_PUBLIC).sort({ sortOrder: 1, name: 1 }).lean(),
    cards({ featured: true }, { limit: 12 }),
    cards({ bestSeller: true }, { sort: SORTS.popular, limit: 12 }),
    cards({ flashSale: true }, { limit: 12 }),
    cards({}, { limit: 12 }),
    CuratedCollection.find({ status: 'ACTIVE', showOnHome: true }).select('-createdBy -updatedBy').sort({ sortOrder: 1 }).limit(6)
      .populate({ path: 'productIds', match: { status: 'ACTIVE' }, select: PRODUCT_CARD_FIELDS, options: { limit: 12 } })
      .lean(),
    GiftBox.find({ status: 'ACTIVE' }).select(GIFT_BOX_CARD_FIELDS).sort({ createdAt: -1 }).limit(8).lean(),
  ]);
  publicCache(res);
  res.json({
    success: true,
    data: {
      banners: {
        hero: banners.filter((b) => b.placement === 'HOME_HERO').map(publicBanner),
        secondary: banners.filter((b) => b.placement === 'HOME_SECONDARY').map(publicBanner),
      },
      categories,
      featured,
      bestSellers,
      flashSale,
      newArrivals,
      collections: collections.map(({ productIds, ...c }) => ({ ...c, products: productIds || [] })),
      giftBoxes,
    },
  });
});

const banners = asyncHandler(async (req, res) => {
  const items = await Banner.find(activeBannerFilter(req.query.placement)).select('-createdBy -updatedBy').sort({ sortOrder: 1, createdAt: -1 }).lean();
  publicCache(res);
  res.json({ success: true, data: items.map(publicBanner) });
});

const featuredProducts = asyncHandler(async (req, res) => {
  const items = await cards({ featured: true }, { limit: req.query.limit });
  publicCache(res);
  res.json({ success: true, data: items });
});

// ---------------- Categories ----------------
const categories = asyncHandler(async (_req, res) => {
  const [all, counts] = await Promise.all([
    Category.find({ status: 'ACTIVE' }).select(CATEGORY_PUBLIC).sort({ sortOrder: 1, name: 1 }).lean(),
    Product.aggregate([{ $match: { status: 'ACTIVE' } }, { $group: { _id: '$categoryId', n: { $sum: 1 } } }]),
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.n]));
  const byParent = new Map();
  for (const c of all) {
    c.productCount = countBy.get(String(c._id)) || 0;
    const key = c.parentCategoryId ? String(c.parentCategoryId) : 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }
  const build = (key, depth = 0) => (depth > 5 ? [] : (byParent.get(key) || []).map((c) => ({ ...c, children: build(String(c._id), depth + 1) })));
  publicCache(res, 300);
  res.json({ success: true, data: build('root') });
});

const categoryProducts = asyncHandler(async (req, res) => {
  const category = await Category.findOne({ slug: req.params.slug, status: 'ACTIVE' }).select(CATEGORY_PUBLIC).lean();
  if (!category) throw ApiError.notFound('Category');
  const [ids, children] = await Promise.all([
    descendantIds(category._id),
    Category.find({ parentCategoryId: category._id, status: 'ACTIVE' }).select('name slug iconUrl').sort({ sortOrder: 1, name: 1 }).lean(),
  ]);
  publicCache(res);
  await paginated(res, { ...listFilter(req.query), categoryId: { $in: ids } }, req.query, { category: { ...category, children } });
});

// ---------------- All products (deals / flash sale listings) ----------------
const products = asyncHandler(async (req, res) => {
  publicCache(res);
  await paginated(res, listFilter(req.query), req.query);
});

// ---------------- Product ----------------
const productDetail = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug, status: 'ACTIVE' })
    .select('-supplierReference -apiDeliveryId -createdBy -updatedBy -soldCount')
    .populate('categoryId', 'name slug parentCategoryId')
    .populate('partnerId', PARTNER_PUBLIC)
    .lean();
  if (!product) throw ApiError.notFound('Product');

  const [reviews, related] = await Promise.all([
    Review.find({ productId: product._id, status: 'APPROVED' }).select('rating title comment createdAt userId')
      .populate('userId', 'name').sort({ createdAt: -1 }).limit(10).lean(),
    cards({ categoryId: product.categoryId?._id, _id: { $ne: product._id } }, { sort: SORTS.popular, limit: 8 }),
  ]);
  publicCache(res);
  res.json({
    success: true,
    data: {
      ...product,
      reviews: reviews.map((r) => ({ ...r, userId: undefined, author: r.userId?.name?.split(' ')[0] || 'Customer' })),
      related,
    },
  });
});

// ---------------- Search ----------------
const search = asyncHandler(async (req, res) => {
  const rx = new RegExp(escapeRegex(req.query.q), 'i');
  const matchingCategories = await Category.find({ status: 'ACTIVE', name: rx }).select('name slug iconUrl').limit(5).lean();
  const filter = {
    ...listFilter(req.query),
    $or: [{ title: rx }, { shortDescription: rx }, { city: rx }, { categoryId: { $in: matchingCategories.map((c) => c._id) } }],
  };
  await paginated(res, filter, req.query, { query: req.query.q, categories: matchingCategories });
});

module.exports = {
  home, banners, featuredProducts, categories, categoryProducts, products, productDetail, search,
};
