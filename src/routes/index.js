const express = require('express');
const mongoose = require('mongoose');
const adminRoutes = require('./admin');
const customerRoutes = require('./customer');

const router = express.Router();

router.get('/health', (_req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ success: dbUp, data: { status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down', uptime: Math.round(process.uptime()) } });
});

router.use('/admin', adminRoutes);   // /api/admin/*  - admin panel
router.use('/', customerRoutes);      // /api/*        - customer storefront
// Internal routers (/api/payment/webhook, /api/vouchers/*) mount here next.

module.exports = router;
