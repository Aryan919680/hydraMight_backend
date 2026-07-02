const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const db = require("../config/db");
const {
  shipPurchaseItemImmediately,
  receivePurchaseOrderAtStockist,
} = require("../services/stockistPurchase.service");

const pool = db.pool || db;
const router = express.Router();

const text = (value) => String(value ?? "").trim();

const PAYMENT_METHODS = [
  "upi",
  "card",
  "bank_transfer",
  "cash_on_delivery",
  "credit_terms",
];

function createOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `STK-${date}-${suffix}`;
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";

  return authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
}

async function requireStockist(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is required.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.user_type !== "stockist") {
      return res.status(403).json({
        success: false,
        message: "This API is available only to stockist users.",
      });
    }

    const stockistId = decoded.stockist_id || decoded.stockistId;

    if (!stockistId) {
      return res.status(401).json({
        success: false,
        message: "Invalid stockist token. stockist_id is missing.",
      });
    }

    const stockistResult = await pool.query(
      `
      select id, business_name, status
      from public.stockists
      where id = $1
      limit 1
      `,
      [stockistId]
    );

    if (stockistResult.rowCount === 0) {
      return res.status(403).json({
        success: false,
        message: "Stockist profile was not found.",
      });
    }

    const stockist = stockistResult.rows[0];
    const stockistStatus = String(stockist.status || "").toLowerCase();

    if (!["active", "approved"].includes(stockistStatus)) {
      return res.status(403).json({
        success: false,
        message: "Stockist account is not active.",
      });
    }

    req.stockist = stockist;
    req.stockistUser = decoded;

    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired stockist token.",
    });
  }
}

/**
 * GET /api/stockist/products
 * Shows every active admin-created global distributor product.
 */
router.get("/products", requireStockist, async (req, res) => {
  try {
    const search = text(req.query.search);
    const params = [];
    let searchSql = "";

    if (search) {
      params.push(`%${search}%`);
      const index = params.length;

      searchSql = `
        and (
          p.name ilike $${index}
          or p.sku ilike $${index}
          or coalesce(p.brand, '') ilike $${index}
          or coalesce(c.name, '') ilike $${index}
        )
      `;
    }

    const result = await pool.query(
      `
      select
        p.id as product_id,
        p.name as product_name,
        p.sku,
        p.brand,
        p.short_description,
        p.description,
        p.quantity_value,
        p.quantity_unit,
        p.unit,
        p.mrp,
        p.currency,

        c.name as category_name,
        mi.id as main_inventory_id,

        coalesce(distributor_stock.allocated_stock, 0)
          as distributor_allocated_stock,

        coalesce(distributor_stock.available_stock, 0)
          as distributor_available_stock,

        coalesce(moq_data.moq_pricing, '[]'::jsonb)
          as moq_pricing

      from public.products p

      left join public.categories c
        on c.id = p.category_id

      left join lateral (
        select main_inventory.id
        from public.main_inventory main_inventory
        where main_inventory.product_id = p.id
          and main_inventory.is_active = true
        order by main_inventory.updated_at desc nulls last
        limit 1
      ) mi on true

      left join lateral (
        select
          coalesce(sum(ia.allocated_stock), 0) as allocated_stock,
          coalesce(sum(ia.available_stock), 0) as available_stock
        from public.inventory_allocations ia
        join public.inventory_channels ic
          on ic.id = ia.channel_id
        where ia.main_inventory_id = mi.id
          and ia.is_active = true
          and lower(coalesce(ic.code, '')) in ('distributor', 'distribution')
      ) distributor_stock on true

      left join lateral (
        select jsonb_agg(
          jsonb_build_object(
            'id', dmp.id,
            'moq_quantity', dmp.moq_quantity,
            'selling_price', dmp.selling_price
          )
          order by dmp.moq_quantity asc
        ) as moq_pricing
        from public.distributor_product_moq_prices dmp
        where dmp.product_id = p.id
          and dmp.status = 'active'
      ) moq_data on true

      where p.ecom_channel = 'distributor'
        and coalesce(p.is_active, true) = true
        and coalesce(p.is_available_for_sale, true) = true
        ${searchSql}

      order by p.name asc, p.sku asc
      `,
      params
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET STOCKIST PRODUCTS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load stockist products.",
    });
  }
});

/**
 * POST /api/stockist/orders
 *
 * Creates a stockist purchase order and marks it shipped immediately.
 */
router.post("/orders", requireStockist, async (req, res) => {
  let client;

  try {
    const paymentMethod = text(req.body.payment_method).toLowerCase();
    const remarks = text(req.body.remarks) || null;
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];

    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Select a valid payment method.",
      });
    }

    if (rawItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one product is required.",
      });
    }

    const mergedItems = new Map();

    for (const item of rawItems) {
      const productId = text(item.product_id);
      const moqPriceId = text(item.moq_price_id);
      const lotCount = Number(item.lot_count);

      if (
        !productId ||
        !moqPriceId ||
        !Number.isInteger(lotCount) ||
        lotCount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Each item requires product_id, moq_price_id and a positive lot_count.",
        });
      }

      const key = `${productId}:${moqPriceId}`;
      const current = mergedItems.get(key);

      mergedItems.set(key, {
        product_id: productId,
        moq_price_id: moqPriceId,
        lot_count: Number(current?.lot_count || 0) + lotCount,
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const validatedItems = [];

    for (const item of mergedItems.values()) {
      const productResult = await client.query(
        `
        select
          p.id as product_id,
          p.name as product_name,
          p.sku,

          mi.id as main_inventory_id,

          dmp.id as moq_price_id,
          dmp.moq_quantity,
          dmp.cost_price,
          dmp.selling_price

        from public.products p

        join lateral (
          select main_inventory.id
          from public.main_inventory main_inventory
          where main_inventory.product_id = p.id
            and main_inventory.is_active = true
          order by main_inventory.updated_at desc nulls last
          limit 1
        ) mi on true

        join public.distributor_product_moq_prices dmp
          on dmp.product_id = p.id
          and dmp.id = $2
          and dmp.status = 'active'

        where p.id = $1
          and p.ecom_channel = 'distributor'
          and coalesce(p.is_active, true) = true
          and coalesce(p.is_available_for_sale, true) = true

        limit 1
        `,
        [item.product_id, item.moq_price_id]
      );

      if (productResult.rowCount === 0) {
        throw new Error(
          "A selected product or MOQ slab is unavailable. Refresh the catalog and try again."
        );
      }

      const product = productResult.rows[0];
      const quantity = Number(product.moq_quantity) * Number(item.lot_count);
      const lineTotal =
        Number(product.selling_price) * Number(item.lot_count);

      validatedItems.push({
        ...product,
        lot_count: Number(item.lot_count),
        quantity,
        line_total: lineTotal,
        unit_price:
          Number(product.selling_price) / Number(product.moq_quantity),
      });
    }

    const subtotal = validatedItems.reduce(
      (sum, item) => sum + Number(item.line_total),
      0
    );

    const orderResult = await client.query(
      `
      insert into public.stockist_purchase_orders (
        order_number,
        stockist_id,
        order_status,
        payment_method,
        payment_status,
        delivery_status,
        subtotal,
        total_amount,
        remarks,
        placed_at,
        shipped_at,
        created_at,
        updated_at
      )
      values (
        $1, $2,
        'shipped',
        $3,
        'pending',
        'shipped',
        $4,
        $4,
        $5,
        now(), now(), now(), now()
      )
      returning *
      `,
      [
        createOrderNumber(),
        req.stockist.id,
        paymentMethod,
        subtotal,
        remarks,
      ]
    );

    const order = orderResult.rows[0];
    const createdItems = [];

    for (const item of validatedItems) {
      const orderItemResult = await client.query(
        `
        insert into public.stockist_purchase_order_items (
          stockist_purchase_order_id,
          product_id,
          distributor_moq_price_id,
          sku,
          product_name,
          lot_count,
          quantity,
          selected_moq_quantity,
          selected_slab_price,
          cost_price,
          unit_price,
          total_amount,
          created_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, now()
        )
        returning *
        `,
        [
          order.id,
          item.product_id,
          item.moq_price_id,
          item.sku,
          item.product_name,
          item.lot_count,
          item.quantity,
          item.moq_quantity,
          item.selling_price,
          item.cost_price,
          item.unit_price,
          item.line_total,
        ]
      );

      const orderItem = orderItemResult.rows[0];
      createdItems.push(orderItem);

      await shipPurchaseItemImmediately(client, {
        stockistPurchaseOrderId: order.id,
        stockistPurchaseOrderItemId: orderItem.id,
        stockistId: req.stockist.id,
        productId: item.product_id,
        mainInventoryId: item.main_inventory_id,
        requestedQuantity: item.quantity,
        note: `Direct shipment for ${order.order_number}`,
        actorId: req.stockistUser.id || null,
      });
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message:
        "Order placed and shipped successfully. The quantity is now visible in your in-transit inventory.",
      data: {
        ...order,
        items: createdItems,
      },
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("CREATE STOCKIST PURCHASE ORDER ERROR:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to place stockist order.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * GET /api/stockist/orders
 */
router.get("/orders", requireStockist, async (req, res) => {
  try {
    const result = await pool.query(
      `
      select
        spo.id,
        spo.order_number,
        spo.order_status,
        spo.payment_method,
        spo.payment_status,
        spo.delivery_status,
        spo.subtotal,
        spo.total_amount,
        spo.remarks,
        spo.placed_at,
        spo.shipped_at,
        spo.delivered_at,

        count(spoi.id)::int as item_count,
        coalesce(sum(spoi.quantity), 0)::int as total_quantity,

        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', spoi.id,
              'product_id', spoi.product_id,
              'product_name', spoi.product_name,
              'sku', spoi.sku,
              'lot_count', spoi.lot_count,
              'quantity', spoi.quantity,
              'selected_moq_quantity', spoi.selected_moq_quantity,
              'selected_slab_price', spoi.selected_slab_price,
              'total_amount', spoi.total_amount
            )
            order by spoi.created_at asc
          ) filter (where spoi.id is not null),
          '[]'::jsonb
        ) as items

      from public.stockist_purchase_orders spo

      left join public.stockist_purchase_order_items spoi
        on spoi.stockist_purchase_order_id = spo.id

      where spo.stockist_id = $1

      group by spo.id
      order by spo.placed_at desc
      `,
      [req.stockist.id]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET STOCKIST PURCHASE ORDERS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load stockist orders.",
    });
  }
});

/**
 * POST /api/stockist/orders/:orderId/receive
 */
router.post("/orders/:orderId/receive", requireStockist, async (req, res) => {
  let client;

  try {
    const note = text(req.body.note) || "Received by stockist";

    client = await pool.connect();
    await client.query("BEGIN");

    const orderResult = await client.query(
      `
      select *
      from public.stockist_purchase_orders
      where id = $1
        and stockist_id = $2
      for update
      `,
      [req.params.orderId, req.stockist.id]
    );

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Stockist purchase order was not found.",
      });
    }

    const order = orderResult.rows[0];

    if (order.order_status !== "shipped") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Only shipped orders can be received.",
      });
    }

    await receivePurchaseOrderAtStockist(client, {
      stockistPurchaseOrderId: order.id,
      stockistId: req.stockist.id,
      note,
      actorId: req.stockistUser.id || null,
    });

    const updatedResult = await client.query(
      `
      update public.stockist_purchase_orders
      set
        order_status = 'delivered',
        delivery_status = 'delivered',
        delivered_at = now(),
        updated_at = now()
      where id = $1
      returning *
      `,
      [order.id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        "Stock received successfully. It is now available in your stockist inventory.",
      data: updatedResult.rows[0],
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("RECEIVE STOCKIST PURCHASE ORDER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to receive stock.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * GET /api/stockist/inventory
 */
router.get("/inventory", requireStockist, async (req, res) => {
  try {
    const result = await pool.query(
      `
      select
        si.id as stockist_inventory_id,
        si.product_id,
        si.total_stock,
        si.reserved_stock,
        si.available_stock,
        si.in_transit_stock,
        si.last_received_at,
        si.updated_at,

        p.name as product_name,
        p.sku,
        p.brand,
        p.quantity_value,
        p.quantity_unit,
        p.unit,

        c.name as category_name

      from public.stockist_inventory si

      join public.products p
        on p.id = si.product_id

      left join public.categories c
        on c.id = p.category_id

      where si.stockist_id = $1
      order by p.name asc, p.sku asc
      `,
      [req.stockist.id]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET STOCKIST INVENTORY ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load stockist inventory.",
    });
  }
});

module.exports = router;