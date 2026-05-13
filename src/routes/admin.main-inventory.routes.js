const express = require("express");
const multer = require("multer");
const csvParser = require("csv-parser");
const { Readable } = require("stream");
const db = require("../config/db");
const { authenticate, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(authenticate, authorize("admin", "operator"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

const clean = (value) => String(value || "").trim();

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const getStockStatus = (availableStock, minStock) => ({
  isOutOfStock: availableStock <= 0,
  isLowStock: availableStock > 0 && availableStock <= minStock,
});

async function findProductBySku(client, sku) {
  const result = await client.query(
    `select id, sku, name
     from products
     where sku = $1
     limit 1`,
    [sku]
  );

  return result.rows[0] || null;
}

async function insertTransaction(client, payload) {
  await client.query(
    `insert into main_inventory_transactions
     (
      main_inventory_id,
      product_id,
      sku,
      transaction_type,
      quantity,
      old_total_stock,
      new_total_stock,
      old_reserved_stock,
      new_reserved_stock,
      old_allocated_stock,
      new_allocated_stock,
      old_available_stock,
      new_available_stock,
      remarks,
      created_by
     )
     values
     ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      payload.main_inventory_id,
      payload.product_id || null,
      payload.sku,
      payload.transaction_type,
      payload.quantity,
      payload.old_total_stock,
      payload.new_total_stock,
      payload.old_reserved_stock,
      payload.new_reserved_stock,
      payload.old_allocated_stock,
      payload.new_allocated_stock,
      payload.old_available_stock,
      payload.new_available_stock,
      payload.remarks || null,
      payload.created_by,
    ]
  );
}

async function upsertInventoryBySku(client, row, userId, transactionType = "bulk_upload") {
  const sku = clean(row.sku).toUpperCase();

  if (!sku) {
    throw new Error("sku is required");
  }

  const itemName = clean(row.item_name || row.product_name || row.name);
  const remarks = clean(row.remarks);

  const totalStock = toNumber(row.total_stock, 0);
  const reservedStock = toNumber(row.reserved_stock, 0);
  const minStock = toNumber(row.min_stock_level, 0);

  if (totalStock < 0 || reservedStock < 0 || minStock < 0) {
    throw new Error(`Stock values cannot be negative for SKU ${sku}`);
  }

  if (reservedStock > totalStock) {
    throw new Error(`reserved_stock cannot be greater than total_stock for SKU ${sku}`);
  }

  const product = await findProductBySku(client, sku);

  const existingResult = await client.query(
    `select *
     from main_inventory
     where sku = $1
     limit 1`,
    [sku]
  );

  const existing = existingResult.rows[0];

  const oldTotalStock = existing ? Number(existing.total_stock || 0) : 0;
  const oldReservedStock = existing ? Number(existing.reserved_stock || 0) : 0;
  const oldAllocatedStock = existing ? Number(existing.allocated_stock || 0) : 0;
  const oldAvailableStock = existing ? Number(existing.available_stock || 0) : 0;

  if (oldAllocatedStock + reservedStock > totalStock) {
    throw new Error(
      `total_stock cannot be less than allocated_stock + reserved_stock for SKU ${sku}`
    );
  }

  const nextAvailableStock = totalStock - reservedStock - oldAllocatedStock;
  const status = getStockStatus(nextAvailableStock, minStock);

  const result = await client.query(
    `insert into main_inventory
     (
      product_id,
      sku,
      item_name,
      total_stock,
      reserved_stock,
      allocated_stock,
      min_stock_level,
      is_out_of_stock,
      is_low_stock,
      product_link_status,
      is_active,
      remarks,
      created_by,
      updated_by,
      created_at,
      updated_at
     )
     values
     (
      $1,$2,$3,$4,$5,0,$6,$7,$8,$9,true,$10,$11,$11,now(),now()
     )
     on conflict (sku)
     do update set
      product_id = coalesce(main_inventory.product_id, excluded.product_id),
      item_name = coalesce(nullif(excluded.item_name, ''), main_inventory.item_name),
      total_stock = excluded.total_stock,
      reserved_stock = excluded.reserved_stock,
      min_stock_level = excluded.min_stock_level,
      is_out_of_stock = excluded.is_out_of_stock,
      is_low_stock = excluded.is_low_stock,
      product_link_status =
        case
          when coalesce(main_inventory.product_id, excluded.product_id) is null then 'pending'
          else 'linked'
        end,
      is_active = true,
      remarks = excluded.remarks,
      updated_by = excluded.updated_by,
      updated_at = now()
     returning *`,
    [
      product ? product.id : null,
      sku,
      itemName || (product ? product.name : null),
      totalStock,
      reservedStock,
      minStock,
      status.isOutOfStock,
      status.isLowStock,
      product ? "linked" : "pending",
      remarks || "Main inventory updated",
      userId,
    ]
  );

  const inventory = result.rows[0];

  const quantityChanged =
    Math.abs(totalStock - oldTotalStock) ||
    Math.abs(reservedStock - oldReservedStock);

  if (quantityChanged > 0) {
    await insertTransaction(client, {
      main_inventory_id: inventory.id,
      product_id: inventory.product_id,
      sku: inventory.sku,
      transaction_type: transactionType,
      quantity: quantityChanged,
      old_total_stock: oldTotalStock,
      new_total_stock: Number(inventory.total_stock),
      old_reserved_stock: oldReservedStock,
      new_reserved_stock: Number(inventory.reserved_stock),
      old_allocated_stock: oldAllocatedStock,
      new_allocated_stock: Number(inventory.allocated_stock),
      old_available_stock: oldAvailableStock,
      new_available_stock: Number(inventory.available_stock),
      remarks: remarks || "Main inventory stock updated",
      created_by: userId,
    });
  }

  return inventory;
}

/**
 * GET all main inventory
 */
router.get("/", async (req, res) => {
  try {
    const { search, status, link_status } = req.query;

    const params = [];
    const conditions = ["mi.is_active = true"];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(mi.sku ilike $${params.length} or mi.item_name ilike $${params.length})`
      );
    }

    if (status === "out_of_stock") {
      conditions.push("mi.is_out_of_stock = true");
    }

    if (status === "low_stock") {
      conditions.push("mi.is_low_stock = true");
    }

    if (link_status) {
      params.push(link_status);
      conditions.push(`mi.product_link_status = $${params.length}`);
    }

    const result = await db.query(
      `select
        mi.id,
        mi.product_id,
        mi.sku,
        mi.item_name,
        mi.total_stock,
        mi.reserved_stock,
        mi.allocated_stock,
        mi.available_stock,
        mi.min_stock_level,
        mi.is_out_of_stock,
        mi.is_low_stock,
        mi.product_link_status,
        mi.remarks,
        mi.created_at,
        mi.updated_at,

        p.name as product_name,
        p.slug as product_slug,
        p.portal_type,
        p.quantity_value,
        p.quantity_unit,
        p.brand,
        p.unit

       from main_inventory mi

       left join products p
         on p.id = mi.product_id

       where ${conditions.join(" and ")}

       order by mi.updated_at desc`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get main inventory error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch main inventory",
    });
  }
});

/**
 * GET one main inventory record
 */
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `select
        mi.*,
        p.name as product_name,
        p.slug as product_slug,
        p.portal_type,
        p.quantity_value,
        p.quantity_unit,
        p.brand,
        p.unit
       from main_inventory mi
       left join products p
         on p.id = mi.product_id
       where mi.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Main inventory not found",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Get main inventory detail error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch main inventory",
    });
  }
});

/**
 * CREATE / UPSERT main inventory by SKU
 */
router.post("/", async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const inventory = await upsertInventoryBySku(
      client,
      req.body,
      req.user.id,
      "stock_in"
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Main inventory saved successfully",
      data: inventory,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create main inventory error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to save main inventory",
    });
  } finally {
    client.release();
  }
});

/**
 * UPDATE main inventory by ID
 */
router.put("/:id", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      item_name,
      total_stock,
      reserved_stock = 0,
      min_stock_level = 0,
      remarks,
    } = req.body;

    if (total_stock === undefined) {
      return res.status(400).json({
        success: false,
        message: "total_stock is required",
      });
    }

    const nextTotalStock = toNumber(total_stock, 0);
    const nextReservedStock = toNumber(reserved_stock, 0);
    const nextMinStock = toNumber(min_stock_level, 0);

    if (nextTotalStock < 0 || nextReservedStock < 0 || nextMinStock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock values cannot be negative",
      });
    }

    await client.query("BEGIN");

    const currentResult = await client.query(
      `select *
       from main_inventory
       where id = $1
       and is_active = true
       limit 1`,
      [req.params.id]
    );

    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Main inventory not found",
      });
    }

    const current = currentResult.rows[0];

    if (Number(current.allocated_stock) + nextReservedStock > nextTotalStock) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "total_stock cannot be less than allocated_stock + reserved_stock",
      });
    }

    const nextAvailableStock =
      nextTotalStock - nextReservedStock - Number(current.allocated_stock || 0);

    const status = getStockStatus(nextAvailableStock, nextMinStock);

    const result = await client.query(
      `update main_inventory
       set
        item_name = coalesce($1, item_name),
        total_stock = $2,
        reserved_stock = $3,
        min_stock_level = $4,
        is_out_of_stock = $5,
        is_low_stock = $6,
        remarks = $7,
        updated_by = $8,
        updated_at = now()
       where id = $9
       returning *`,
      [
        item_name || null,
        nextTotalStock,
        nextReservedStock,
        nextMinStock,
        status.isOutOfStock,
        status.isLowStock,
        remarks || "Main inventory adjusted",
        req.user.id,
        req.params.id,
      ]
    );

    const updated = result.rows[0];

    const quantityChanged =
      Math.abs(nextTotalStock - Number(current.total_stock || 0)) ||
      Math.abs(nextReservedStock - Number(current.reserved_stock || 0));

    if (quantityChanged > 0) {
      await insertTransaction(client, {
        main_inventory_id: updated.id,
        product_id: updated.product_id,
        sku: updated.sku,
        transaction_type: "adjustment",
        quantity: quantityChanged,
        old_total_stock: Number(current.total_stock || 0),
        new_total_stock: Number(updated.total_stock || 0),
        old_reserved_stock: Number(current.reserved_stock || 0),
        new_reserved_stock: Number(updated.reserved_stock || 0),
        old_allocated_stock: Number(current.allocated_stock || 0),
        new_allocated_stock: Number(updated.allocated_stock || 0),
        old_available_stock: Number(current.available_stock || 0),
        new_available_stock: Number(updated.available_stock || 0),
        remarks: remarks || "Main inventory adjusted",
        created_by: req.user.id,
      });
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Main inventory updated successfully",
      data: updated,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Update main inventory error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to update main inventory",
    });
  } finally {
    client.release();
  }
});

/**
 * DELETE / deactivate inventory
 */
router.delete("/:id", async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const currentResult = await client.query(
      `select *
       from main_inventory
       where id = $1
       limit 1`,
      [req.params.id]
    );

    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Main inventory not found",
      });
    }

    const current = currentResult.rows[0];

    if (Number(current.allocated_stock || 0) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Cannot delete inventory because stock is allocated. Deallocate first.",
      });
    }

    const result = await client.query(
      `update main_inventory
       set
        is_active = false,
        total_stock = 0,
        reserved_stock = 0,
        is_out_of_stock = true,
        is_low_stock = false,
        remarks = 'Main inventory deactivated',
        updated_by = $1,
        updated_at = now()
       where id = $2
       returning *`,
      [req.user.id, req.params.id]
    );

    if (Number(current.total_stock || 0) > 0) {
      await insertTransaction(client, {
        main_inventory_id: current.id,
        product_id: current.product_id,
        sku: current.sku,
        transaction_type: "deactivate",
        quantity: Number(current.total_stock || 0),
        old_total_stock: Number(current.total_stock || 0),
        new_total_stock: 0,
        old_reserved_stock: Number(current.reserved_stock || 0),
        new_reserved_stock: 0,
        old_allocated_stock: Number(current.allocated_stock || 0),
        new_allocated_stock: 0,
        old_available_stock: Number(current.available_stock || 0),
        new_available_stock: 0,
        remarks: "Main inventory deactivated",
        created_by: req.user.id,
      });
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Main inventory deactivated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete main inventory error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete main inventory",
    });
  } finally {
    client.release();
  }
});

/**
 * GET transactions
 */
router.get("/:id/transactions", async (req, res) => {
  try {
    const result = await db.query(
      `select
        mit.*,
        up.full_name as created_by_name
       from main_inventory_transactions mit
       left join user_profiles up
         on up.id = mit.created_by
       where mit.main_inventory_id = $1
       order by mit.created_at desc`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get main inventory transactions error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch transactions",
    });
  }
});

/**
 * Link product after product is created in future.
 */
router.post("/link-products", async (req, res) => {
  try {
    const result = await db.query(
      `update main_inventory mi
       set
        product_id = p.id,
        product_link_status = 'linked',
        updated_at = now()
       from products p
       where upper(p.sku) = upper(mi.sku)
       and mi.product_id is null
       and mi.is_active = true
       returning mi.*`,
      []
    );

    res.json({
      success: true,
      message: "Inventory linked with products where SKU matched",
      linked_count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("Link inventory products error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to link inventory with products",
    });
  }
});

/**
 * BULK UPLOAD MAIN INVENTORY
 *
 * CSV columns:
 * sku,total_stock,reserved_stock,min_stock_level,remarks
 *
 * Optional:
 * item_name
 */
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  const client = await db.pool.connect();

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }

    const rows = [];

    await new Promise((resolve, reject) => {
      Readable.from(req.file.buffer)
        .pipe(csvParser())
        .on("data", (row) => rows.push(row))
        .on("end", resolve)
        .on("error", reject);
    });

    const results = [];

    await client.query("BEGIN");

    for (let index = 0; index < rows.length; index++) {
      try {
        const inventory = await upsertInventoryBySku(
          client,
          rows[index],
          req.user.id,
          "bulk_upload"
        );

        results.push({
          row: index + 1,
          success: true,
          sku: inventory.sku,
          item_name: inventory.item_name,
          total_stock: inventory.total_stock,
          reserved_stock: inventory.reserved_stock,
          allocated_stock: inventory.allocated_stock,
          available_stock: inventory.available_stock,
          min_stock_level: inventory.min_stock_level,
          product_link_status: inventory.product_link_status,
          product_id: inventory.product_id,
        });
      } catch (rowError) {
        results.push({
          row: index + 1,
          success: false,
          sku: rows[index]?.sku,
          message: rowError.message,
        });
      }
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Main inventory bulk upload processed",
      total_rows: rows.length,
      processed: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Bulk upload main inventory error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Bulk upload failed",
    });
  } finally {
    client.release();
  }
});

module.exports = router;