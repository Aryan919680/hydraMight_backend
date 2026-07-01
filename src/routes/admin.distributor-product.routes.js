const express = require("express");
const db = require("../config/db");
const { authenticate, authorize } = require("../middleware/auth.middleware");

const pool = db.pool || db;
const router = express.Router();

router.use(authenticate, authorize("admin", "operator"));

const text = (value) => String(value ?? "").trim();
const normalizeSku = (value) => text(value).toUpperCase();
const getAdminId = (req) => req.user?.id || req.admin?.id || null;

const toInteger = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
};

const toMoney = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const slugify = (value) =>
  text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

function validateMoqPricing(moqPricing) {
  if (!Array.isArray(moqPricing) || moqPricing.length === 0) {
    return "At least one MOQ pricing slab is required.";
  }

  const seenMoq = new Set();

  for (const slab of moqPricing) {
    const moqQuantity = toInteger(slab.moq_quantity);
    const costPrice = toMoney(slab.cost_price, NaN);
    const sellingPrice = toMoney(slab.selling_price, NaN);

    if (moqQuantity <= 0) {
      return "MOQ quantity must be a positive whole number.";
    }

    if (!Number.isFinite(costPrice) || costPrice < 0) {
      return "Cost price must be zero or greater.";
    }

    if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
      return "Selling price must be zero or greater.";
    }

    if (sellingPrice < costPrice) {
      return `Selling price cannot be lower than cost price for MOQ ${moqQuantity}.`;
    }

    if (seenMoq.has(moqQuantity)) {
      return `Duplicate MOQ slab found: ${moqQuantity}.`;
    }

    seenMoq.add(moqQuantity);
  }

  return null;
}

function normalizeMoqPricing(moqPricing) {
  return moqPricing
    .map((slab) => ({
      moq_quantity: toInteger(slab.moq_quantity),
      cost_price: toMoney(slab.cost_price),
      selling_price: toMoney(slab.selling_price),
    }))
    .sort((a, b) => a.moq_quantity - b.moq_quantity);
}

async function saveMoqPricing(client, productId, moqPricing, userId) {
  await client.query(
    `
    update public.distributor_product_moq_prices
    set
      status = 'inactive',
      updated_at = now()
    where product_id = $1
    `,
    [productId]
  );

  const savedSlabs = [];

  for (const slab of moqPricing) {
    const result = await client.query(
      `
      insert into public.distributor_product_moq_prices (
        product_id,
        moq_quantity,
        cost_price,
        selling_price,
        status,
        created_by,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, 'active', $5, now(), now())
      on conflict (product_id, moq_quantity)
      do update set
        cost_price = excluded.cost_price,
        selling_price = excluded.selling_price,
        status = 'active',
        updated_at = now()
      returning *
      `,
      [
        productId,
        slab.moq_quantity,
        slab.cost_price,
        slab.selling_price,
        userId,
      ]
    );

    savedSlabs.push(result.rows[0]);
  }

  return savedSlabs.sort(
    (a, b) => Number(a.moq_quantity) - Number(b.moq_quantity)
  );
}

function productListQuery() {
  return `
    select
      p.id as product_id,
      p.category_id,
      p.name as product_name,
      p.slug,
      p.sku,
      p.short_description,
      p.description,
      p.brand,
      p.quantity_value,
      p.quantity_unit,
      p.unit,
      p.weight,
      p.mrp,
      p.selling_price as default_selling_price,
      p.currency,
      p.is_active as product_active,
      p.is_available_for_sale,
      p.inventory_link_status,
      p.created_at,
      p.updated_at,

      c.name as category_name,

      mi.id as main_inventory_id,
      mi.item_name as inventory_item_name,
      mi.total_stock as main_total_stock,
      mi.reserved_stock as main_reserved_stock,
      mi.available_stock as main_available_stock,
      mi.product_link_status,

      coalesce(distributor_stock.allocated_stock, 0)
        as distributor_allocated_stock,

      coalesce(distributor_stock.reserved_stock, 0)
        as distributor_reserved_stock,

      coalesce(distributor_stock.available_stock, 0)
        as distributor_available_stock,

      coalesce(moq_pricing.slabs, '[]'::jsonb)
        as moq_pricing

    from public.products p

    left join public.categories c
      on c.id = p.category_id

    left join lateral (
      select
        main_inventory.id,
        main_inventory.item_name,
        main_inventory.total_stock,
        main_inventory.reserved_stock,
        main_inventory.available_stock,
        main_inventory.product_link_status
      from public.main_inventory main_inventory
      where main_inventory.product_id = p.id
        and main_inventory.is_active = true
      order by main_inventory.updated_at desc
      limit 1
    ) mi on true

    left join lateral (
      select
        coalesce(sum(ia.allocated_stock), 0) as allocated_stock,
        coalesce(sum(ia.reserved_stock), 0) as reserved_stock,
        coalesce(sum(ia.available_stock), 0) as available_stock
      from public.inventory_allocations ia
      join public.inventory_channels ic
        on ic.id = ia.channel_id
      where ia.main_inventory_id = mi.id
        and ia.is_active = true
        and ic.code = 'distribution'
    ) distributor_stock on true

    left join lateral (
      select jsonb_agg(
        jsonb_build_object(
          'id', dmp.id,
          'moq_quantity', dmp.moq_quantity,
          'cost_price', dmp.cost_price,
          'selling_price', dmp.selling_price,
          'status', dmp.status
        )
        order by dmp.moq_quantity
      ) as slabs
      from public.distributor_product_moq_prices dmp
      where dmp.product_id = p.id
        and dmp.status = 'active'
    ) moq_pricing on true

    where p.ecom_channel = 'distributor'
  `;
}

/**
 * GET /api/admin/distributor-products/unmapped-skus
 */
router.get("/unmapped-skus", async (req, res) => {
  try {
    const search = text(req.query.search);
    const limit = Math.min(Math.max(toInteger(req.query.limit, 100), 1), 500);
    const offset = Math.max(toInteger(req.query.offset, 0), 0);

    const params = [];

    const conditions = [
      "mi.is_active = true",
      "nullif(trim(mi.sku), '') is not null",
      "mi.product_id is null",
    ];

    if (search) {
      params.push(`%${search}%`);

      conditions.push(`
        (
          mi.sku ilike $${params.length}
          or coalesce(mi.item_name, '') ilike $${params.length}
        )
      `);
    }

    const whereSql = conditions.join(" and ");

    const countResult = await pool.query(
      `
      select count(*)::int as total
      from public.main_inventory mi
      where ${whereSql}
      `,
      params
    );

    params.push(limit);
    const limitIndex = params.length;

    params.push(offset);
    const offsetIndex = params.length;

    const result = await pool.query(
      `
      select
        mi.id as main_inventory_id,
        mi.sku,
        mi.item_name,
        mi.total_stock,
        mi.reserved_stock,
        mi.available_stock,
        mi.min_stock_level,
        mi.product_id,
        mi.product_link_status,
        mi.is_active,
        mi.updated_at
      from public.main_inventory mi
      where ${whereSql}
      order by mi.updated_at desc
      limit $${limitIndex}
      offset $${offsetIndex}
      `,
      params
    );

    return res.json({
      success: true,
      pagination: {
        total: countResult.rows[0]?.total || 0,
        limit,
        offset,
      },
      data: result.rows,
    });
  } catch (error) {
    console.error("GET UNMAPPED DISTRIBUTOR SKUS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch unmapped inventory SKUs",
    });
  }
});

/**
 * POST /api/admin/distributor-products
 *
 * No stockist_id.
 * Product is global and visible to all stockists/agencies.
 */
router.post("/", async (req, res) => {
  let client;

  try {
    const {
      category_id,
      name,
      sku,
      short_description = null,
      description = null,
      brand = null,
      quantity_value = 1,
      quantity_unit = "unit",
      unit = "units",
      weight = null,
      mrp = 0,
      currency = "INR",
      is_featured = false,
      is_available_for_sale = true,
      moq_pricing,
    } = req.body;

    const productName = text(name);
    const productSku = normalizeSku(sku);
    const validationError = validateMoqPricing(moq_pricing);

    if (!category_id || !productName || !productSku) {
      return res.status(400).json({
        success: false,
        message: "category_id, name and sku are required.",
      });
    }

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const pricing = normalizeMoqPricing(moq_pricing);

    client = await pool.connect();
    await client.query("BEGIN");

    const categoryResult = await client.query(
      `
      select id
      from public.categories
      where id = $1
      limit 1
      `,
      [category_id]
    );

    if (categoryResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Category not found.",
      });
    }

    const existingProduct = await client.query(
      `
      select id, name, sku
      from public.products
      where upper(trim(sku)) = upper(trim($1))
      limit 1
      `,
      [productSku]
    );

    if (existingProduct.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message:
          "SKU already exists. Product name may repeat, but SKU must be unique.",
        data: existingProduct.rows[0],
      });
    }

    const inventoryResult = await client.query(
      `
      select
        id,
        sku,
        item_name,
        product_id
      from public.main_inventory
      where upper(trim(sku)) = upper(trim($1))
        and is_active = true
      limit 1
      for update
      `,
      [productSku]
    );

    if (inventoryResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message:
          "Active main inventory SKU not found. Add/import inventory SKU before creating distributor product.",
      });
    }

    const mainInventory = inventoryResult.rows[0];

    if (mainInventory.product_id) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "This inventory SKU is already linked to another product.",
      });
    }

    const productResult = await client.query(
      `
      insert into public.products (
        category_id,
        name,
        slug,
        sku,
        short_description,
        description,
        brand,
        ecom_channel,
        portal_type,
        quantity_value,
        quantity_unit,
        unit,
        weight,
        mrp,
        selling_price,
        currency,
        is_featured,
        is_available_for_sale,
        inventory_link_status,
        is_active,
        created_by,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        'distributor', 'distributor',
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16,
        'linked', true, $17, now(), now()
      )
      returning *
      `,
      [
        category_id,
        productName,
        slugify(`${productName}-${productSku}`),
        productSku,
        text(short_description) || null,
        text(description) || null,
        text(brand) || null,
        toMoney(quantity_value, 1),
        text(quantity_unit) || "unit",
        text(unit) || "units",
        weight === null || weight === "" ? null : toMoney(weight),
        toMoney(mrp),
        pricing[0].selling_price,
        text(currency) || "INR",
        Boolean(is_featured),
        is_available_for_sale !== false,
        getAdminId(req),
      ]
    );

    const product = productResult.rows[0];

    await client.query(
      `
      update public.main_inventory
      set
        product_id = $1,
        product_link_status = 'linked',
        updated_at = now()
      where id = $2
      `,
      [product.id, mainInventory.id]
    );

    const savedPricing = await saveMoqPricing(
      client,
      product.id,
      pricing,
      getAdminId(req)
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message:
        "Global distributor product created successfully. Allocate stock to the distribution channel to make it orderable.",
      data: {
        product,
        main_inventory: {
          id: mainInventory.id,
          sku: mainInventory.sku,
          item_name: mainInventory.item_name,
          product_id: product.id,
          product_link_status: "linked",
        },
        moq_pricing: savedPricing,
      },
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("CREATE DISTRIBUTOR PRODUCT ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create distributor product.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * GET /api/admin/distributor-products
 */
router.get("/", async (req, res) => {
  try {
    const search = text(req.query.search);
    const status = text(req.query.status || "active").toLowerCase();
    const limit = Math.min(Math.max(toInteger(req.query.limit, 100), 1), 500);
    const offset = Math.max(toInteger(req.query.offset, 0), 0);

    if (!["active", "inactive", "all"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be active, inactive or all.",
      });
    }

    const params = [];
    const conditions = [];

    if (status !== "all") {
      params.push(status === "active");
      conditions.push(`product_list.product_active = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);

      conditions.push(`
        (
          product_list.product_name ilike $${params.length}
          or product_list.sku ilike $${params.length}
          or coalesce(product_list.brand, '') ilike $${params.length}
          or coalesce(product_list.category_name, '') ilike $${params.length}
        )
      `);
    }

    const whereSql = conditions.length
      ? `where ${conditions.join(" and ")}`
      : "";

    const countResult = await pool.query(
      `
      select count(*)::int as total
      from (${productListQuery()}) product_list
      ${whereSql}
      `,
      params
    );

    params.push(limit);
    const limitIndex = params.length;

    params.push(offset);
    const offsetIndex = params.length;

    const result = await pool.query(
      `
      select *
      from (${productListQuery()}) product_list
      ${whereSql}
      order by product_list.created_at desc
      limit $${limitIndex}
      offset $${offsetIndex}
      `,
      params
    );

    return res.json({
      success: true,
      pagination: {
        total: countResult.rows[0]?.total || 0,
        limit,
        offset,
      },
      data: result.rows,
    });
  } catch (error) {
    console.error("GET DISTRIBUTOR PRODUCTS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch distributor products.",
    });
  }
});

/**
 * GET /api/admin/distributor-products/:productId
 */
router.get("/:productId", async (req, res) => {
  try {
    const result = await pool.query(
      `
      select *
      from (${productListQuery()}) product_list
      where product_list.product_id = $1
      limit 1
      `,
      [req.params.productId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Distributor product not found.",
      });
    }

    return res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("GET DISTRIBUTOR PRODUCT DETAIL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch distributor product.",
    });
  }
});

/**
 * PUT /api/admin/distributor-products/:productId/moq-pricing
 */
router.put("/:productId/moq-pricing", async (req, res) => {
  let client;

  try {
    const validationError = validateMoqPricing(req.body.moq_pricing);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const pricing = normalizeMoqPricing(req.body.moq_pricing);

    client = await pool.connect();
    await client.query("BEGIN");

    const productResult = await client.query(
      `
      select id, name, sku
      from public.products
      where id = $1
        and ecom_channel = 'distributor'
      for update
      `,
      [req.params.productId]
    );

    if (productResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Distributor product not found.",
      });
    }

    const savedPricing = await saveMoqPricing(
      client,
      req.params.productId,
      pricing,
      getAdminId(req)
    );

    await client.query(
      `
      update public.products
      set
        selling_price = $1,
        updated_at = now()
      where id = $2
      `,
      [pricing[0].selling_price, req.params.productId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Global MOQ pricing updated successfully.",
      data: {
        product: productResult.rows[0],
        moq_pricing: savedPricing,
      },
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("UPDATE DISTRIBUTOR MOQ PRICING ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update MOQ pricing.",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;