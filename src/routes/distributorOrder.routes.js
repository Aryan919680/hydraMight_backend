const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const pool = db.pool || db;
const router = express.Router();

function generateDistributorOrderNumber() {
  return `DO-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

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

router.use(distributorAuth);

/**
 * POST /api/distributor/orders
 * Stockist places order to manufacturer.
 * Agency places order to assigned stockist.
 * Body: { items: [{ product_id, quantity }], delivery_address, remarks }
 */
router.post("/", async (req, res) => {
  let client;

  try {
    client = await pool.connect();

    const user = req.distributorUser;
    const { items, delivery_address, remarks } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one item is required",
      });
    }

    await client.query("BEGIN");

    let stockistId = user.stockist_id;
    let agencyId = null;
    let orderType = "stockist";
    let orderStatus = "pending_admin_approval";

    if (user.user_type === "agency") {
      orderType = "agency";
      agencyId = user.agency_id;
      orderStatus = "pending_stockist_approval";

      const agencyResult = await client.query(
        `select id, stockist_id, status
         from public.agencies
         where id = $1
         limit 1`,
        [agencyId]
      );

      if (agencyResult.rowCount === 0) {
        throw new Error("Agency profile not found");
      }

      const agency = agencyResult.rows[0];

      if (agency.status !== "active") {
        throw new Error("Agency account is inactive");
      }

      stockistId = agency.stockist_id;
    }

    if (!stockistId) {
      throw new Error("Stockist profile not found");
    }

    const stockistResult = await client.query(
      `select id, status
       from public.stockists
       where id = $1
       limit 1`,
      [stockistId]
    );

    if (stockistResult.rowCount === 0) {
      throw new Error("Stockist not found");
    }

    if (stockistResult.rows[0].status !== "active") {
      throw new Error("Stockist is inactive");
    }

    const orderNumber = generateDistributorOrderNumber();

    const orderResult = await client.query(
      `insert into public.distributor_orders (
        order_number,
        order_type,
        stockist_id,
        agency_id,
        user_profile_id,
        order_status,
        payment_status,
        subtotal,
        total_amount,
        delivery_address,
        remarks,
        placed_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,'pending',0,0,$7,$8,now(),now()
      ) returning *`,
      [
        orderNumber,
        orderType,
        stockistId,
        agencyId,
        user.id,
        orderStatus,
        delivery_address || null,
        remarks || null,
      ]
    );

    const order = orderResult.rows[0];
    const createdItems = [];
    let subtotal = 0;

    for (const item of items) {
      const productId = item.product_id || item.id;
      const quantity = Number(item.quantity || 0);

      if (!productId || quantity <= 0) {
        throw new Error("Each item must have product_id and quantity > 0");
      }

      let pricingResult;

      if (user.user_type === "stockist") {
        pricingResult = await client.query(
          `select
             spa.product_id,
             spa.stockist_price as unit_price,
             spa.min_order_qty,
             p.name as product_name,
             p.sku,
             p.mrp
           from public.stockist_product_assignments spa
           join public.products p on p.id = spa.product_id
           where spa.stockist_id = $1
             and spa.product_id = $2
             and spa.status = 'active'
             and coalesce(p.is_active, true) = true
           limit 1`,
          [stockistId, productId]
        );
      } else {
        pricingResult = await client.query(
          `select
             spa.product_id,
             coalesce(app.agency_price, spa.stockist_price) as unit_price,
             spa.min_order_qty,
             p.name as product_name,
             p.sku,
             p.mrp
           from public.stockist_product_assignments spa
           join public.products p on p.id = spa.product_id
           left join public.agency_product_pricing app
             on app.agency_id = $3
            and app.product_id = spa.product_id
            and app.status = 'active'
           where spa.stockist_id = $1
             and spa.product_id = $2
             and spa.status = 'active'
             and coalesce(p.is_active, true) = true
           limit 1`,
          [stockistId, productId, agencyId]
        );
      }

      if (pricingResult.rowCount === 0) {
        throw new Error(`Product is not available in distributor catalog: ${productId}`);
      }

      const product = pricingResult.rows[0];
      const minOrderQty = Number(product.min_order_qty || 1);

      if (quantity < minOrderQty) {
        throw new Error(`${product.product_name} minimum order quantity is ${minOrderQty}`);
      }

      const unitPrice = Number(product.unit_price || 0);
      const mrp = Number(product.mrp || 0);
      const totalPrice = unitPrice * quantity;
      subtotal += totalPrice;

      const orderItemResult = await client.query(
        `insert into public.distributor_order_items (
          order_id,
          product_id,
          sku,
          product_name,
          quantity,
          unit_price,
          mrp,
          total_price,
          created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
        returning *`,
        [
          order.id,
          product.product_id,
          product.sku,
          product.product_name,
          quantity,
          unitPrice,
          mrp,
          totalPrice,
        ]
      );

      createdItems.push(orderItemResult.rows[0]);
    }

    const updatedOrderResult = await client.query(
      `update public.distributor_orders
       set subtotal = $1,
           total_amount = $1,
           updated_at = now()
       where id = $2
       returning *`,
      [subtotal, order.id]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Distributor order created successfully",
      data: {
        order: updatedOrderResult.rows[0],
        items: createdItems,
      },
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("CREATE DISTRIBUTOR ORDER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create distributor order",
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * GET /api/distributor/orders
 */
router.get("/", async (req, res) => {
  try {
    const user = req.distributorUser;
    const { limit = 20, offset = 0 } = req.query;

    const params = [];
    const where = [];

    if (user.user_type === "stockist") {
      params.push(user.stockist_id);
      where.push(`o.stockist_id = $${params.length}`);
    } else {
      params.push(user.agency_id);
      where.push(`o.agency_id = $${params.length}`);
    }

    params.push(Number(limit));
    const limitIndex = params.length;

    params.push(Number(offset));
    const offsetIndex = params.length;

    const result = await pool.query(
      `select
         o.*,
         s.business_name as stockist_business_name,
         a.business_name as agency_business_name,
         coalesce(
           (
             select json_agg(
               json_build_object(
                 'id', i.id,
                 'product_id', i.product_id,
                 'sku', i.sku,
                 'product_name', i.product_name,
                 'quantity', i.quantity,
                 'unit_price', i.unit_price,
                 'mrp', i.mrp,
                 'total_price', i.total_price
               )
               order by i.created_at asc
             )
             from public.distributor_order_items i
             where i.order_id = o.id
           ),
           '[]'::json
         ) as items
       from public.distributor_orders o
       join public.stockists s on s.id = o.stockist_id
       left join public.agencies a on a.id = o.agency_id
       where ${where.join(" and ")}
       order by o.placed_at desc
       limit $${limitIndex}
       offset $${offsetIndex}`,
      params
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET DISTRIBUTOR ORDERS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch distributor orders",
      error: error.message,
    });
  }
});

/**
 * GET /api/distributor/orders/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const user = req.distributorUser;

    const params = [req.params.id];
    let ownershipSql = "";

    if (user.user_type === "stockist") {
      params.push(user.stockist_id);
      ownershipSql = "and o.stockist_id = $2";
    } else {
      params.push(user.agency_id);
      ownershipSql = "and o.agency_id = $2";
    }

    const orderResult = await pool.query(
      `select
         o.*,
         s.business_name as stockist_business_name,
         a.business_name as agency_business_name
       from public.distributor_orders o
       join public.stockists s on s.id = o.stockist_id
       left join public.agencies a on a.id = o.agency_id
       where o.id = $1
       ${ownershipSql}
       limit 1`,
      params
    );

    if (orderResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const itemsResult = await pool.query(
      `select *
       from public.distributor_order_items
       where order_id = $1
       order by created_at asc`,
      [req.params.id]
    );

    return res.json({
      success: true,
      data: {
        ...orderResult.rows[0],
        items: itemsResult.rows,
      },
    });
  } catch (error) {
    console.error("GET DISTRIBUTOR ORDER DETAIL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch distributor order detail",
      error: error.message,
    });
  }
});

/**
 * POST /api/distributor/orders/:id/approve
 * Stockist approves agency order.
 */
router.post("/:id/approve", async (req, res) => {
  try {
    const user = req.distributorUser;

    if (user.user_type !== "stockist") {
      return res.status(403).json({
        success: false,
        message: "Only stockist can approve agency orders",
      });
    }

    const result = await pool.query(
      `update public.distributor_orders
       set order_status = 'approved',
           approved_by = $1,
           approved_at = now(),
           updated_at = now()
       where id = $2
         and stockist_id = $3
         and order_type = 'agency'
         and order_status = 'pending_stockist_approval'
       returning *`,
      [user.id, req.params.id, user.stockist_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending agency order not found",
      });
    }

    return res.json({
      success: true,
      message: "Agency order approved successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("APPROVE DISTRIBUTOR ORDER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve distributor order",
      error: error.message,
    });
  }
});

module.exports = router;
