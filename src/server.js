const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth.routes');
const adminCategoryRoutes = require('./routes/admin.category.routes');
const adminProductRoutes = require('./routes/admin.product.routes');
const customerProductRoutes = require('./routes/customer.product.routes');
const adminInventoryRoutes = require('./routes/admin.inventory.routes');
const adminLocationRoutes = require('./routes/admin.location.routes');
const adminMainInventoryRoutes = require("./routes/admin.main-inventory.routes");
const customerAuthRoutes = require("./routes/customer.auth.routes");
const adminInventoryAllocationRoutes = require("./routes/admin.inventory-allocation.routes");
const customerSalesOrderRoutes = require("./routes/customer.sales-order.routes");
const customerCommercialAuthRoutes = require("./routes/customer.commercial-auth.routes");
const adminCommercialSignupRoutes = require("./routes/admin.commercial-signup.routes");
const adminDistributorRoutes = require("./routes/adminDistributor.routes");
const distributorAuthRoutes = require("./routes/distributorAuth.routes");
const agencySignupRequestRoutes = require("./routes/agencySignupRequest.routes");

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  "http://localhost:8080",
  "https://hydra-might-admin-frontend.vercel.app",
  "https://hydramight-distributor-ui.vercel.app"
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow Postman, curl, mobile apps, server-to-server calls
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("CORS BLOCKED ORIGIN:", origin);

    return callback(new Error(`CORS not allowed for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Origin",
    "X-Requested-With"
  ],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Ecom ERP backend running' });
});

app.use('/api/auth', authRoutes);

app.use('/api/admin/categories', adminCategoryRoutes);
app.use('/api/admin/products', adminProductRoutes);
app.use('/api/admin/inventory', adminInventoryRoutes);
app.use('/api/admin/locations', adminLocationRoutes);
app.use('/api/admin/main-inventory', adminMainInventoryRoutes);
app.use('/api/admin/inventory-allocations', adminInventoryAllocationRoutes);
app.use("/api/admin/commercial-signups", adminCommercialSignupRoutes);
app.use("/api/admin/distributors", adminDistributorRoutes);
// customer auth first
app.use("/api/customer/auth", customerAuthRoutes);
app.use("/api/customer/commercial", customerCommercialAuthRoutes);
app.use("/api/distributor/auth", distributorAuthRoutes);
app.use("/api/distributor/agency-requests", agencySignupRequestRoutes);
// customer product/public routes after auth
app.use("/api/customer", customerProductRoutes);
app.use("/api/customer/orders", customerSalesOrderRoutes);
app.use('/uploads', express.static('uploads'));
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'API route not found' });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
