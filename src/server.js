const express = require("express");
const cors = require("cors");
require("dotenv").config();

const authRoutes = require("./routes/auth.routes");
const adminCategoryRoutes = require("./routes/admin.category.routes");
const adminProductRoutes = require("./routes/admin.product.routes");
const customerProductRoutes = require("./routes/customer.product.routes");
const adminInventoryRoutes = require("./routes/admin.inventory.routes");
const adminLocationRoutes = require("./routes/admin.location.routes");
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

/**
 * TEMP OPEN CORS
 * Allows all origins for now.
 * Use restricted origins again before final production release.
 */
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: "*",
    optionsSuccessStatus: 204,
  })
);

app.options("*", cors());

app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Ecom ERP backend running",
  });
});

/**
 * Auth
 */
app.use("/api/auth", authRoutes);

/**
 * Admin routes
 */
app.use("/api/admin/categories", adminCategoryRoutes);
app.use("/api/admin/products", adminProductRoutes);
app.use("/api/admin/inventory", adminInventoryRoutes);
app.use("/api/admin/locations", adminLocationRoutes);
app.use("/api/admin/main-inventory", adminMainInventoryRoutes);
app.use("/api/admin/inventory-allocations", adminInventoryAllocationRoutes);
app.use("/api/admin/commercial-signups", adminCommercialSignupRoutes);
app.use("/api/admin/distributors", adminDistributorRoutes);

/**
 * Customer / commercial / distributor auth routes
 */
app.use("/api/customer/auth", customerAuthRoutes);
app.use("/api/customer/commercial", customerCommercialAuthRoutes);
app.use("/api/distributor/auth", distributorAuthRoutes);
app.use("/api/distributor/agency-requests", agencySignupRequestRoutes);

/**
 * Customer public/product/order routes
 */
app.use("/api/customer/orders", customerSalesOrderRoutes);
app.use("/api/customer", customerProductRoutes);

/**
 * Static uploads
 */
app.use("/uploads", express.static("uploads"));

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
    path: req.originalUrl,
  });
});

/**
 * Error handler
 */
app.use((err, req, res, next) => {
  console.error("Server error:", err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});