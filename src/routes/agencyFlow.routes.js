const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../config/db");

const {
  reserveStockistInventory,
  reserveAdminDistributionInventory,
  releaseAgencyOrderReservations,
  shipAgencyOrderReservations,
} = require("../services/agencySupply.service");

const pool = db.pool || db;
const router = express.Router();

const PAYMENT_METHODS = new Set([
  "upi",
  "card",
  "bank_transfer",
  "cash_on_delivery",
  "credit_terms",
]);

const text = (value) => String(value ?? "").trim();
const number = (value) => Number(value || 0);

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  return header.startsWith("Bearer ")
    ? header.slice(7)
    : null;
}

function orderNumber(prefix) {
  const day = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");

  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${day}-${suffix}`;
}

async function distributorAuth(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is required.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!["stockist", "agency"].includes(decoded.user_type)) {
      return res.status(403).json({
        success: false,
        message: "Distributor access only.",
      });
    }

    req.distributorUser = decoded;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
}

async function requireStockist(req, res, next) {
  const user = req.distributorUser;

  if (user.user_type !== "stockist" || !user.stockist_id) {
    return res.status(403).json({
      success: false,
      message: "Stockist access is required.",
    });
  }

  const stockistResult = await pool.query(
    `
    select id, business_name, status
    from public.stockists
    where id = $1
    limit 1
    `,
    [user.stockist_id]
  );

  if (
    stockistResult.rowCount === 0 ||
    String(stockistResult.rows[0].status).toLowerCase() !== "active"
  ) {
    return res.status(403).json({
      success: false,
      message: "Stockist account is inactive.",
    });
  }

  req.stockist = stockistResult.rows[0];
  next();
}

async function requireAgency(req, res, next) {
  const user = req.distributorUser;

  if (user.user_type !== "agency" || !user.agency_id) {
    return res.status(403).json({
      success: false,
      message: "Agency access is required.",
    });
  }

  const agencyResult = await pool.query(
    `
    select
      a.id,
      a.stockist_id,
      a.business_name,
      a.status,

      'stockist'::text as fulfillment_source,

      s.business_name as stockist_business_name,
      s.status as stockist_status

    from public.agencies a

    left join public.stockists s
      on s.id = a.stockist_id

    where a.id = $1
    limit 1
    `,
    [user.agency_id]
  );

  if (agencyResult.rowCount === 0) {
    return res.status(403).json({
      success: false,
      message: "Agency profile was not found.",
    });
  }

  const agency = agencyResult.rows[0];

  if (String(agency.status || "").toLowerCase() !== "active") {
    return res.status(403).json({
      success: false,
      message: "Agency account is inactive.",
    });
  }

  /*
    Assigned agency requires active assigned Stockist.
    Unassigned agency is allowed and can browse all Stockist catalogues.
  */
  if (
    agency.stockist_id &&
    String(agency.stockist_status || "").toLowerCase() !== "active"
  ) {
    return res.status(403).json({
      success: false,
      message: "Assigned stockist is inactive.",
    });
  }

  req.agency = agency;
  next();
}

router.use(distributorAuth);

/**
 * STOCKIST INVENTORY AVAILABLE FOR AGENCY LISTING
 */
router.get("/stockist/inventory", requireStockist, async (req, res) => {
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

        p.name as product_name,
        p.sku,
        p.brand,
        p.unit,
        p.quantity_value,
        p.quantity_unit,

        c.name as category_name,

        listing.id as listing_id,
        listing.agency_price,
        listing.min_order_qty,
        listing.status as listing_status

      from public.stockist_inventory si

      join public.products p
        on p.id = si.product_id

      left join public.categories c
        on c.id = p.category_id

      left join public.stockist_agency_catalog_listings listing
        on listing.stockist_id = si.stockist_id
       and listing.product_id = si.product_id

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
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load stockist inventory.",
    });
  }
});

/**
 * STOCKIST CREATE / UPDATE AGENCY CATALOG LISTING
 */
router.post("/stockist/listings", requireStockist, async (req, res) => {
  let client;

  try {
    const productId = text(req.body.product_id);
    const agencyPrice = Number(req.body.agency_price);
    const minOrderQty = Number(req.body.min_order_qty || 1);
    const status = text(req.body.status || "active").toLowerCase();

    if (!productId || !Number.isFinite(agencyPrice) || agencyPrice < 0) {
      return res.status(400).json({
        success: false,
        message: "product_id and a valid agency_price are required.",
      });
    }

    if (!Number.isInteger(minOrderQty) || minOrderQty <= 0) {
      return res.status(400).json({
        success: false,
        message: "min_order_qty must be a positive whole number.",
      });
    }

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be active or inactive.",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const inventoryResult = await client.query(
      `
      select
        id,
        coalesce(available_stock, 0) as available_stock
      from public.stockist_inventory
      where stockist_id = $1
        and product_id = $2
      for update
      `,
      [req.stockist.id, productId]
    );

    if (inventoryResult.rowCount === 0) {
      throw new Error("You do not own inventory for this product.");
    }

    if (Number(inventoryResult.rows[0].available_stock) < minOrderQty) {
      throw new Error(
        `Available inventory must be at least ${minOrderQty}.`
      );
    }

    const listingResult = await client.query(
      `
      insert into public.stockist_agency_catalog_listings (
        stockist_id,
        product_id,
        agency_price,
        min_order_qty,
        status,
        created_by,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, now(), now())

      on conflict (stockist_id, product_id)
      do update set
        agency_price = excluded.agency_price,
        min_order_qty = excluded.min_order_qty,
        status = excluded.status,
        updated_at = now()

      returning *
      `,
      [
        req.stockist.id,
        productId,
        agencyPrice,
        minOrderQty,
        status,
        req.distributorUser.id || null,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Agency catalog listing saved successfully.",
      data: listingResult.rows[0],
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to save catalog listing.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.patch(
  "/stockist/listings/:listingId",
  requireStockist,
  async (req, res) => {
    try {
      const agencyPrice = Number(req.body.agency_price);
      const minOrderQty = Number(req.body.min_order_qty);
      const status = text(req.body.status).toLowerCase();

      if (!Number.isFinite(agencyPrice) || agencyPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "agency_price must be zero or greater.",
        });
      }

      if (!Number.isInteger(minOrderQty) || minOrderQty <= 0) {
        return res.status(400).json({
          success: false,
          message: "min_order_qty must be a positive whole number.",
        });
      }

      if (!["active", "inactive"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "status must be active or inactive.",
        });
      }

      const result = await pool.query(
        `
        update public.stockist_agency_catalog_listings
        set
          agency_price = $1,
          min_order_qty = $2,
          status = $3,
          updated_at = now()
        where id = $4
          and stockist_id = $5
        returning *
        `,
        [
          agencyPrice,
          minOrderQty,
          status,
          req.params.listingId,
          req.stockist.id,
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Stockist catalog listing was not found.",
        });
      }

      return res.json({
        success: true,
        message: "Catalog listing updated successfully.",
        data: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to update catalog listing.",
      });
    }
  }
);

/**
 * AGENCY CATALOG
 * Assigned agency -> Stockist listings
 * Unassigned agency -> Admin distributor catalogue
 */
router.get("/agency/catalog", requireAgency, async (req, res) => {
  try {
    const search = text(req.query.search);
    const params = [];
    let searchSql = "";

    if (search) {
      params.push(`%${search}%`);

      searchSql = `
        and (
          p.name ilike $${params.length}
          or p.sku ilike $${params.length}
          or coalesce(p.brand, '') ilike $${params.length}
          or coalesce(c.name, '') ilike $${params.length}
          or coalesce(stockist.business_name, '') ilike $${params.length}
        )
      `;
    }

    /*
      Assigned agency:
      only assigned Stockist products.

      Unassigned agency:
      all active Stockist catalogue listings.
    */
    const assignedStockistId = req.agency.stockist_id || null;

    if (assignedStockistId) {
      params.push(assignedStockistId);
      const stockistIndex = params.length;

      const result = await pool.query(
        `
        select
          listing.id as listing_id,
          'stockist'::text as supplier_source,

          listing.stockist_id,
          stockist.business_name as supplier_name,

          listing.product_id,
          listing.agency_price as unit_price,
          listing.min_order_qty,
          listing.status as listing_status,

          coalesce(inventory.available_stock, 0) as available_stock,

          p.name as product_name,
          p.sku,
          p.brand,
          p.unit,
          p.quantity_value,
          p.quantity_unit,
          p.short_description,
          p.description,
          p.mrp,
          p.currency,

          c.name as category_name

        from public.stockist_agency_catalog_listings listing

        join public.stockist_inventory inventory
          on inventory.stockist_id = listing.stockist_id
         and inventory.product_id = listing.product_id

        join public.stockists stockist
          on stockist.id = listing.stockist_id

        join public.products p
          on p.id = listing.product_id

        left join public.categories c
          on c.id = p.category_id

        where listing.stockist_id = $${stockistIndex}
          and listing.status = 'active'
          and lower(stockist.status) = 'active'
          and coalesce(p.is_active, true) = true
          and coalesce(inventory.available_stock, 0)
            >= listing.min_order_qty
          ${searchSql}

        order by p.name asc, p.sku asc
        `,
        params
      );

      return res.json({
        success: true,
        data: {
          supplier_source: "stockist",
          supplier_name: req.agency.stockist_business_name,
          is_unassigned: false,
          items: result.rows,
        },
      });
    }

    const result = await pool.query(
      `
      select
        listing.id as listing_id,
        'stockist'::text as supplier_source,

        listing.stockist_id,
        stockist.business_name as supplier_name,

        listing.product_id,
        listing.agency_price as unit_price,
        listing.min_order_qty,
        listing.status as listing_status,

        coalesce(inventory.available_stock, 0) as available_stock,

        p.name as product_name,
        p.sku,
        p.brand,
        p.unit,
        p.quantity_value,
        p.quantity_unit,
        p.short_description,
        p.description,
        p.mrp,
        p.currency,

        c.name as category_name

      from public.stockist_agency_catalog_listings listing

      join public.stockist_inventory inventory
        on inventory.stockist_id = listing.stockist_id
       and inventory.product_id = listing.product_id

      join public.stockists stockist
        on stockist.id = listing.stockist_id

      join public.products p
        on p.id = listing.product_id

      left join public.categories c
        on c.id = p.category_id

      where listing.status = 'active'
        and lower(stockist.status) = 'active'
        and coalesce(p.is_active, true) = true
        and coalesce(inventory.available_stock, 0)
          >= listing.min_order_qty
        ${searchSql}

      order by
        stockist.business_name asc,
        p.name asc,
        p.sku asc
      `,
      params
    );

    return res.json({
      success: true,
      data: {
        supplier_source: "stockist",
        supplier_name: "Choose a Stockist",
        is_unassigned: true,
        items: result.rows,
      },
    });
  } catch (error) {
    console.error("GET AGENCY CATALOG ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load agency catalogue.",
    });
  }
});

/**
 * AGENCY PLACE ORDER
 */
router.post("/agency/orders", requireAgency, async (req, res) => {
  let client;

  try {
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];

    const paymentMethod = text(
      req.body.payment_method || "credit_terms"
    ).toLowerCase();

    const remarks = text(req.body.remarks) || null;
    const deliveryAddress = req.body.delivery_address || null;

    const requestedStockistId = text(req.body.stockist_id) || null;

    if (!PAYMENT_METHODS.has(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Please select a valid payment method.",
      });
    }

    if (!rawItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one item is required.",
      });
    }

    /*
      Assigned agency: only assigned stockist allowed.
      Unassigned agency: frontend must send selected stockist_id.
    */
    const stockistId =
      req.agency.stockist_id || requestedStockistId;

    if (!stockistId) {
      return res.status(400).json({
        success: false,
        message:
          "Please select products from one Stockist catalogue before placing an order.",
      });
    }

    if (
      req.agency.stockist_id &&
      requestedStockistId &&
      req.agency.stockist_id !== requestedStockistId
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Your agency is assigned to a different Stockist.",
      });
    }

    const stockistResult = await pool.query(
      `
      select id, business_name
      from public.stockists
      where id = $1
        and lower(status) = 'active'
      limit 1
      `,
      [stockistId]
    );

    if (stockistResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Selected Stockist is not active.",
      });
    }

    const mergedItems = new Map();

    for (const rawItem of rawItems) {
      const productId = text(rawItem.product_id);
      const listingId = text(rawItem.listing_id);
      const quantity = Number(rawItem.quantity);

      if (
        !productId ||
        !listingId ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Each item requires product_id, listing_id and a positive whole quantity.",
        });
      }

      const key = `${productId}:${listingId}`;
      const current = mergedItems.get(key);

      mergedItems.set(key, {
        product_id: productId,
        listing_id: listingId,
        quantity: Number(current?.quantity || 0) + quantity,
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const orderResult = await client.query(
      `
      insert into public.agency_supply_orders (
        order_number,
        agency_id,
        stockist_id,
        supplier_source,
        order_status,
        payment_method,
        payment_status,
        delivery_status,
        subtotal,
        total_amount,
        delivery_address,
        remarks,
        placed_at,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3,
        'stockist',
        'pending_stockist_approval',
        $4,
        'pending',
        'not_started',
        0,
        0,
        $5,
        $6,
        now(),
        now(),
        now()
      )
      returning *
      `,
      [
        orderNumber("AGO"),
        req.agency.id,
        stockistId,
        paymentMethod,
        deliveryAddress
          ? JSON.stringify(deliveryAddress)
          : null,
        remarks,
      ]
    );

    const order = orderResult.rows[0];

    const createdItems = [];
    let subtotal = 0;

    for (const item of mergedItems.values()) {
      const listingResult = await client.query(
        `
        select
          listing.id as listing_id,
          listing.product_id,
          listing.agency_price as unit_price,
          listing.min_order_qty,

          p.name as product_name,
          p.sku

        from public.stockist_agency_catalog_listings listing

        join public.products p
          on p.id = listing.product_id

        where listing.id = $1
          and listing.stockist_id = $2
          and listing.product_id = $3
          and listing.status = 'active'
        limit 1
        `,
        [
          item.listing_id,
          stockistId,
          item.product_id,
        ]
      );

      if (listingResult.rowCount === 0) {
        throw new Error(
          "A selected Stockist listing is unavailable."
        );
      }

      const product = listingResult.rows[0];

      if (item.quantity < Number(product.min_order_qty)) {
        throw new Error(
          `${product.product_name} minimum order quantity is ${product.min_order_qty}.`
        );
      }

      const unitPrice = number(product.unit_price);
      const lineTotal = unitPrice * item.quantity;

      subtotal += lineTotal;

      const orderItemResult = await client.query(
        `
        insert into public.agency_supply_order_items (
          agency_supply_order_id,
          stockist_agency_catalog_listing_id,
          product_id,
          sku,
          product_name,
          quantity,
          unit_price,
          total_amount,
          min_order_qty,
          created_at
        )
        values (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          now()
        )
        returning *
        `,
        [
          order.id,
          product.listing_id,
          product.product_id,
          product.sku,
          product.product_name,
          item.quantity,
          unitPrice,
          lineTotal,
          product.min_order_qty,
        ]
      );

      const orderItem = orderItemResult.rows[0];
      createdItems.push(orderItem);

      await reserveStockistInventory(client, {
        agencySupplyOrderId: order.id,
        agencySupplyOrderItemId: orderItem.id,
        stockistId,
        productId: product.product_id,
        quantity: item.quantity,
      });
    }

    const updatedOrderResult = await client.query(
      `
      update public.agency_supply_orders
      set
        subtotal = $1,
        total_amount = $1,
        updated_at = now()
      where id = $2
      returning *
      `,
      [subtotal, order.id]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message:
        "Agency order placed successfully. Selected Stockist will review it.",
      data: {
        order: updatedOrderResult.rows[0],
        items: createdItems,
      },
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("CREATE AGENCY ORDER ERROR:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Failed to place agency order.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * AGENCY ORDER HISTORY
 */
router.get("/agency/orders", requireAgency, async (req, res) => {
  try {
    const result = await pool.query(
      `
      select
        aso.*,

        coalesce(
          stockist.business_name,
          'HydraMight Admin'
        ) as supplier_name,

        count(asoi.id)::int as item_count,

        coalesce(
          sum(asoi.quantity),
          0
        )::int as total_quantity,

        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', asoi.id,
              'product_name', asoi.product_name,
              'sku', asoi.sku,
              'quantity', asoi.quantity,
              'unit_price', asoi.unit_price,
              'total_amount', asoi.total_amount
            )
            order by asoi.created_at asc
          ) filter (where asoi.id is not null),
          '[]'::jsonb
        ) as items

      from public.agency_supply_orders aso

      left join public.stockists stockist
        on stockist.id = aso.stockist_id

      left join public.agency_supply_order_items asoi
        on asoi.agency_supply_order_id = aso.id

      where aso.agency_id = $1

      group by aso.id, stockist.business_name
      order by aso.placed_at desc
      `,
      [req.agency.id]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load agency orders.",
    });
  }
});

/**
 * STOCKIST AGENCY ORDERS
 */
router.get(
  "/stockist/agency-orders",
  requireStockist,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        select
          aso.*,

          a.business_name as agency_business_name,
          a.contact_person as agency_contact_person,
          a.mobile as agency_mobile,
          a.email as agency_email,

          count(asoi.id)::int as item_count,

          coalesce(
            sum(asoi.quantity),
            0
          )::int as total_quantity,

          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id', asoi.id,
                'product_name', asoi.product_name,
                'sku', asoi.sku,
                'quantity', asoi.quantity,
                'unit_price', asoi.unit_price,
                'total_amount', asoi.total_amount
              )
              order by asoi.created_at asc
            ) filter (where asoi.id is not null),
            '[]'::jsonb
          ) as items

        from public.agency_supply_orders aso

        join public.agencies a
          on a.id = aso.agency_id

        left join public.agency_supply_order_items asoi
          on asoi.agency_supply_order_id = aso.id

        where aso.stockist_id = $1
          and aso.supplier_source = 'stockist'

        group by aso.id, a.id
        order by aso.placed_at desc
        `,
        [req.stockist.id]
      );

      return res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to load agency orders.",
      });
    }
  }
);

/**
 * STOCKIST APPROVE / SHIP AGENCY ORDER
 */
router.post(
  "/stockist/agency-orders/:orderId/approve",
  requireStockist,
  async (req, res) => {
    let client;

    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const orderResult = await client.query(
        `
        select *
        from public.agency_supply_orders
        where id = $1
          and stockist_id = $2
          and supplier_source = 'stockist'
        for update
        `,
        [req.params.orderId, req.stockist.id]
      );

      if (orderResult.rowCount === 0) {
        throw new Error("Agency order was not found.");
      }

      const order = orderResult.rows[0];

      if (order.order_status !== "pending_stockist_approval") {
        throw new Error(
          "Only pending agency orders can be approved."
        );
      }

      await shipAgencyOrderReservations(client, order.id);

      const updatedResult = await client.query(
        `
        update public.agency_supply_orders
        set
          order_status = 'shipped',
          delivery_status = 'shipped',
          approved_by = $1,
          approved_at = now(),
          shipped_at = now(),
          updated_at = now()
        where id = $2
        returning *
        `,
        [
          req.distributorUser.id || null,
          order.id,
        ]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Agency order approved and shipped.",
        data: updatedResult.rows[0],
      });
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to approve agency order.",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

/**
 * STOCKIST REJECT AGENCY ORDER
 */
router.post(
  "/stockist/agency-orders/:orderId/reject",
  requireStockist,
  async (req, res) => {
    let client;

    try {
      const reason =
        text(req.body.reason) || "Rejected by stockist";

      client = await pool.connect();
      await client.query("BEGIN");

      const orderResult = await client.query(
        `
        select *
        from public.agency_supply_orders
        where id = $1
          and stockist_id = $2
          and supplier_source = 'stockist'
        for update
        `,
        [req.params.orderId, req.stockist.id]
      );

      if (orderResult.rowCount === 0) {
        throw new Error("Agency order was not found.");
      }

      const order = orderResult.rows[0];

      if (order.order_status !== "pending_stockist_approval") {
        throw new Error(
          "Only pending agency orders can be rejected."
        );
      }

      await releaseAgencyOrderReservations(client, order.id);

      const updatedResult = await client.query(
        `
        update public.agency_supply_orders
        set
          order_status = 'rejected',
          delivery_status = 'rejected',
          rejected_by = $1,
          rejected_at = now(),
          rejection_reason = $2,
          updated_at = now()
        where id = $3
        returning *
        `,
        [
          req.distributorUser.id || null,
          reason,
          order.id,
        ]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Agency order rejected and stock released.",
        data: updatedResult.rows[0],
      });
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Failed to reject agency order.",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

/**
 * AGENCY GIFTS AND BENEFITS
 */
router.get("/agency/benefits", requireAgency, async (req, res) => {
  try {
    const result = await pool.query(
      `
      select
        id,
        title,
        benefit_type,
        short_description,
        description,
        benefit_value,
        image_url,
        terms_and_conditions,
        starts_at,
        ends_at,
        created_at
      from public.agency_gifts_benefits
      where is_active = true
        and (
          agency_id is null
          or agency_id = $1
        )
        and (starts_at is null or starts_at <= now())
        and (ends_at is null or ends_at >= now())
      order by
        case when agency_id = $1 then 0 else 1 end,
        created_at desc
      `,
      [req.agency.id]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load gifts and benefits.",
    });
  }
});

module.exports = router;