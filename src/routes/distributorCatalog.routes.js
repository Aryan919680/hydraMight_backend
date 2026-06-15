const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const pool = db.pool || db;
const router = express.Router();

function distributorAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Token missing",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!["stockist", "agency"].includes(decoded.user_type)) {
      return res.status(403).json({
        success: false,
        message: "Distributor access only",
      });
    }

    req.distributorUser = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

/**
 * GET /api/distributor/catalog
 * Stockist sees assigned products with stockist price.
 * Agency sees stockist products with agency price override if configured.
 */
router.get("/", distributorAuth, async (req, res) => {
  try {
    const user = req.distributorUser;

    if (user.user_type === "stockist") {
      const result = await pool.query(
        `
        select
          spa.id as assignment_id,
          spa.stockist_id,
          spa.product_id,
          spa.stockist_price as price,
          spa.stockist_price,
          null::numeric as agency_price,
          spa.min_order_qty,
          spa.status as assignment_status,

          p.name as product_name,
          p.slug as product_slug,
          p.sku,
          p.brand,
          p.unit,
          p.quantity_value,
          p.quantity_unit,
          p.short_description,
          p.description,
          p.mrp,
          p.selling_price as base_selling_price,
          p.currency,
          p.is_active as product_active,

          c.name as category_name
        from public.stockist_product_assignments spa
        join public.products p on p.id = spa.product_id
        left join public.categories c on c.id = p.category_id
        where spa.stockist_id = $1
          and spa.status = 'active'
          and coalesce(p.is_active, true) = true
        order by p.name asc
        `,
        [user.stockist_id]
      );

      return res.json({
        success: true,
        role: "stockist",
        data: result.rows,
      });
    }

    if (user.user_type === "agency") {
      const result = await pool.query(
        `
        select
          spa.id as assignment_id,
          spa.stockist_id,
          spa.product_id,
          coalesce(app.agency_price, spa.stockist_price) as price,
          spa.stockist_price,
          app.agency_price,
          spa.min_order_qty,
          spa.status as assignment_status,

          p.name as product_name,
          p.slug as product_slug,
          p.sku,
          p.brand,
          p.unit,
          p.quantity_value,
          p.quantity_unit,
          p.short_description,
          p.description,
          p.mrp,
          p.selling_price as base_selling_price,
          p.currency,
          p.is_active as product_active,

          c.name as category_name
        from public.agencies a
        join public.stockist_product_assignments spa
          on spa.stockist_id = a.stockist_id
         and spa.status = 'active'
        join public.products p on p.id = spa.product_id
        left join public.categories c on c.id = p.category_id
        left join public.agency_product_pricing app
          on app.agency_id = a.id
         and app.product_id = spa.product_id
         and app.status = 'active'
        where a.id = $1
          and a.status = 'active'
          and coalesce(p.is_active, true) = true
        order by p.name asc
        `,
        [user.agency_id]
      );

      return res.json({
        success: true,
        role: "agency",
        data: result.rows,
      });
    }

    return res.status(403).json({
      success: false,
      message: "Invalid distributor role",
    });
  } catch (error) {
    console.error("DISTRIBUTOR CATALOG ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch distributor catalog",
      error: error.message,
    });
  }
});

module.exports = router;
