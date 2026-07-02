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
const distributorCatalogRoutes = require("./routes/distributorCatalog.routes");
const distributorOrderRoutes = require("./routes/distributorOrder.routes");
const adminDistributorProductRoutes = require("./routes/admin.distributor-product.routes");
const adminOrderRoutes = require("./routes/admin.orders.routes");
const stockistPurchaseRoutes = require("./routes/stockist.purchase.routes");

const app = express();

/**
 * FORCE OPEN CORS - TEMP
 */
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";

  res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).send();
  }

  next();
});

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Ecom ERP backend running",
  });
});

app.use("/api/auth", authRoutes);

app.use("/api/admin/categories", adminCategoryRoutes);
app.use("/api/admin/products", adminProductRoutes);
app.use("/api/admin/inventory", adminInventoryRoutes);
app.use("/api/admin/locations", adminLocationRoutes);
app.use("/api/admin/main-inventory", adminMainInventoryRoutes);
app.use("/api/admin/inventory-allocations", adminInventoryAllocationRoutes);
app.use("/api/admin/commercial-signups", adminCommercialSignupRoutes);
app.use("/api/admin/distributors", adminDistributorRoutes);
app.use("/api/admin/orders", adminOrderRoutes);
app.use("/api/admin/distributor-products", adminDistributorProductRoutes);
app.use("/api/customer/auth", customerAuthRoutes);
app.use("/api/customer/commercial", customerCommercialAuthRoutes);

app.use("/api/distributor/auth", distributorAuthRoutes);
app.use("/api/distributor/agency-requests", agencySignupRequestRoutes);
app.use("/api/distributor/catalog", distributorCatalogRoutes);
app.use("/api/distributor/orders", distributorOrderRoutes);

app.use("/api/customer/orders", customerSalesOrderRoutes);
app.use("/api/customer", customerProductRoutes);

app.use("/api/stockist", stockistPurchaseRoutes);
app.use("/uploads", express.static("uploads"));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
    path: req.originalUrl,
  });
});

app.use((err, req, res, next) => {
  console.error("Server error:", err);

  const origin = req.headers.origin || "*";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Credentials", "true");

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});