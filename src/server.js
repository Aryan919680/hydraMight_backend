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

const app = express();

app.use(cors());
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

// customer auth first
app.use("/api/customer/auth", customerAuthRoutes);

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
