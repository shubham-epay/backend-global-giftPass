const { Order, OrderItem, Voucher, Product, User, Coupon } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const { REVENUE_ORDER_STATUSES } = require('../../constants/enums');
const { round2 } = require('../../utils/helpers');

const TZ = 'Asia/Dubai';
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const summary = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 864e5);
  const revenueMatch = { orderStatus: { $in: REVENUE_ORDER_STATUSES }, createdAt: { $gte: since } };

  const [totals, ordersByStatus, vouchersByStatus, salesByDayRaw, recentOrders, topProducts,
    activeProducts, customers, activeCoupons, expiringVouchers] = await Promise.all([
    Order.aggregate([{ $match: revenueMatch }, { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 }, aov: { $avg: '$total' } } }]),
    Order.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$orderStatus', count: { $sum: 1 } } }]),
    Voucher.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: revenueMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Order.find().sort({ createdAt: -1 }).limit(8).select('orderNumber customer total currency orderStatus paymentStatus createdAt').lean(),
    OrderItem.aggregate([
      { $match: { itemType: 'PRODUCT', createdAt: { $gte: since } } },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order', pipeline: [{ $project: { orderStatus: 1 } }] } },
      { $unwind: '$order' },
      { $match: { 'order.orderStatus': { $in: REVENUE_ORDER_STATUSES } } },
      { $group: { _id: '$productId', title: { $first: '$titleSnapshot' }, units: { $sum: '$quantity' }, revenue: { $sum: '$lineTotal' } } },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    Product.countDocuments({ status: 'ACTIVE' }),
    User.countDocuments({ type: 'CUSTOMER' }),
    Coupon.countDocuments({ status: 'ACTIVE', validFrom: { $lte: new Date() }, validTill: { $gte: new Date() } }),
    Voucher.countDocuments({ status: 'ACTIVE', expiryDate: { $gte: new Date(), $lte: new Date(Date.now() + 30 * 864e5) } }),
  ]);

  // Fill gaps so the chart has one point per day.
  const byDay = Object.fromEntries(salesByDayRaw.map((d) => [d._id, d]));
  const salesByDay = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(new Date(Date.now() - i * 864e5));
    salesByDay.push({ date: key, revenue: round2(byDay[key]?.revenue || 0), orders: byDay[key]?.orders || 0 });
  }

  const t = totals[0] || { revenue: 0, orders: 0, aov: 0 };
  res.json({
    success: true,
    data: {
      rangeDays: days,
      currency: 'AED',
      totals: {
        revenue: round2(t.revenue), paidOrders: t.orders, averageOrderValue: round2(t.aov || 0),
        activeProducts, customers, activeCoupons, vouchersExpiringIn30Days: expiringVouchers,
      },
      ordersByStatus: Object.fromEntries(ordersByStatus.map((s) => [s._id, s.count])),
      vouchersByStatus: Object.fromEntries(vouchersByStatus.map((s) => [s._id, s.count])),
      salesByDay,
      recentOrders,
      topProducts: topProducts.map((p) => ({ ...p, revenue: round2(p.revenue) })),
    },
  });
});

module.exports = { summary };
