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
    fileSize: 5 * 1024 * 1024,
  },
});

/**
 * MAIN INVENTORY
 * Product-level parent inventory.
 */
router.get("/main", async (req, res) => {
  try {
    const result = await db.query(
      `select
        mi.id,
        mi.product_id,

        p.name as product_name,
        p.sku,
        p.portal_type,
        p.quantity_value,
        p.quantity_unit,

        mi.total_stock,
        mi.available_stock,
        mi.reserved_stock,
        mi.min_stock_level,
        mi.is_out_of_stock,
        mi.updated_at

       from main_inventory mi
       join products p on p.id = mi.product_id

       order by mi.updated_at desc`,
      []
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
 * LOCATION-WISE INVENTORY
 * Optional filter by location_id.
 */
router.get("/location", async (req, res) => {
  try {
    const { location_id } = req.query;

    const params = [];
    let locationFilter = "";

    if (location_id) {
      params.push(location_id);
      locationFilter = `and li.location_id = $${params.length}`;
    }

    const result = await db.query(
      `select
        li.id,
        li.product_id,

        p.name as product_name,
        p.sku,
        p.portal_type,
        p.quantity_value,
        p.quantity_unit,

        li.location_id,
        sl.name as location_name,
        sl.city,
        sl.state,
        sl.pincode,

        li.available_stock,
        li.reserved_stock,
        li.min_stock_level,
        li.is_out_of_stock,
        li.is_active,
        li.updated_at

       from location_inventory li

       join products p
         on p.id = li.product_id

       left join service_locations sl
         on sl.id = li.location_id

       where coalesce(li.is_active, true) = true
       ${locationFilter}

       order by sl.name asc, p.name asc`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get location inventory error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch location inventory",
    });
  }
});

/**
 * BACKWARD COMPATIBILITY
 * GET /api/admin/inventory
 */
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `select
        li.id,
        li.product_id,

        p.name as product_name,
        p.sku,
        p.portal_type,
        p.quantity_value,
        p.quantity_unit,

        li.location_id,
        sl.name as location_name,
        sl.city,
        sl.state,
        sl.pincode,

        li.available_stock,
        li.reserved_stock,
        li.min_stock_level,
        li.is_out_of_stock,
        li.is_active,
        li.updated_at

       from location_inventory li

       join products p
         on p.id = li.product_id

       left join service_locations sl
         on sl.id = li.location_id

       where coalesce(li.is_active, true) = true

       order by li.updated_at desc`,
      []
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get inventory error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch inventory",
    });
  }
});

/**
 * GET inventory for one product across all locations.
 */
router.get("/product/:productId", async (req, res) => {
  try {
    const result = await db.query(
      `select
        li.*,

        p.name as product_name,
        p.sku,
        p.portal_type,
        p.quantity_value,
        p.quantity_unit,

        sl.name as location_name,
        sl.city,
        sl.state,
        sl.pincode

       from location_inventory li

       join products p
         on p.id = li.product_id

       left join service_locations sl
         on sl.id = li.location_id

       where li.product_id = $1
       and coalesce(li.is_active, true) = true

       order by sl.name asc`,
      [req.params.productId]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get product inventory error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch product inventory",
    });
  }
});

/**
 * ADD OR UPDATE LOCATION INVENTORY
 */
router.post("/location", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      product_id,
      location_id,
      available_stock,
      reserved_stock = 0,
      min_stock_level = 0,
      remarks,
    } = req.body;

    if (!product_id || !location_id || available_stock === undefined) {
      return res.status(400).json({
        success: false,
        message: "product_id, location_id and available_stock are required",
      });
    }

    const stock = Number(available_stock);
    const reserved = Number(reserved_stock);
    const minStock = Number(min_stock_level);

    if (stock < 0 || reserved < 0 || minStock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock values cannot be negative",
      });
    }

    await client.query("BEGIN");

    const existingResult = await client.query(
      `select *
       from location_inventory
       where product_id = $1
       and location_id = $2
       limit 1`,
      [product_id, location_id]
    );

    const oldStock =
      existingResult.rows.length > 0
        ? Number(existingResult.rows[0].available_stock || 0)
        : 0;

    const result = await client.query(
      `insert into location_inventory
       (
        product_id,
        location_id,
        available_stock,
        reserved_stock,
        min_stock_level,
        is_out_of_stock,
        is_active,
        updated_at
       )
       values ($1,$2,$3,$4,$5,$6,true,now())
       on conflict (product_id, location_id)
       do update set
        available_stock = excluded.available_stock,
        reserved_stock = excluded.reserved_stock,
        min_stock_level = excluded.min_stock_level,
        is_out_of_stock = excluded.is_out_of_stock,
        is_active = true,
        updated_at = now()
       returning *`,
      [product_id, location_id, stock, reserved, minStock, stock <= 0]
    );

    const diff = stock - oldStock;

    if (diff !== 0) {
      await client.query(
        `insert into inventory_transactions
         (
          product_id,
          location_id,
          transaction_type,
          quantity,
          reference_type,
          remarks,
          created_by
         )
         values ($1,$2,$3,$4,'manual',$5,$6)`,
        [
          product_id,
          location_id,
          diff > 0 ? "stock_in" : "stock_out",
          Math.abs(diff),
          remarks || "Location inventory updated",
          req.user.id,
        ]
      );
    }

    await client.query(`select sync_main_inventory($1)`, [product_id]);

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Location inventory saved and main inventory synced",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Save location inventory error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to save location inventory",
    });
  } finally {
    client.release();
  }
});

/**
 * UPDATE LOCATION INVENTORY BY ID
 */
router.put("/:id", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const { available_stock, reserved_stock, min_stock_level, remarks } = req.body;

    await client.query("BEGIN");

    const currentResult = await client.query(
      `select *
       from location_inventory
       where id = $1
       and coalesce(is_active, true) = true`,
      [req.params.id]
    );

    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Inventory not found",
      });
    }

    const current = currentResult.rows[0];

    const nextAvailable =
      available_stock !== undefined
        ? Number(available_stock)
        : Number(current.available_stock);

    const nextReserved =
      reserved_stock !== undefined
        ? Number(reserved_stock)
        : Number(current.reserved_stock);

    const nextMin =
      min_stock_level !== undefined
        ? Number(min_stock_level)
        : Number(current.min_stock_level);

    if (nextAvailable < 0 || nextReserved < 0 || nextMin < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Stock values cannot be negative",
      });
    }

    const result = await client.query(
      `update location_inventory
       set available_stock = $1,
           reserved_stock = $2,
           min_stock_level = $3,
           is_out_of_stock = $4,
           updated_at = now()
       where id = $5
       returning *`,
      [nextAvailable, nextReserved, nextMin, nextAvailable <= 0, req.params.id]
    );

    const diff = nextAvailable - Number(current.available_stock);

    if (diff !== 0) {
      await client.query(
        `insert into inventory_transactions
         (
          product_id,
          location_id,
          transaction_type,
          quantity,
          reference_type,
          remarks,
          created_by
         )
         values ($1,$2,$3,$4,'manual',$5,$6)`,
        [
          current.product_id,
          current.location_id,
          diff > 0 ? "stock_in" : "stock_out",
          Math.abs(diff),
          remarks || "Inventory updated by admin",
          req.user.id,
        ]
      );
    }

    await client.query(`select sync_main_inventory($1)`, [current.product_id]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Inventory updated and main inventory synced",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Update inventory error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to update inventory",
    });
  } finally {
    client.release();
  }
});

/**
 * DELETE / DEACTIVATE LOCATION INVENTORY
 */
router.delete("/:id", async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const currentResult = await client.query(
      `select *
       from location_inventory
       where id = $1`,
      [req.params.id]
    );

    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Inventory not found",
      });
    }

    const current = currentResult.rows[0];

    const result = await client.query(
      `update location_inventory
       set is_active = false,
           available_stock = 0,
           reserved_stock = 0,
           is_out_of_stock = true,
           updated_at = now()
       where id = $1
       returning *`,
      [req.params.id]
    );

    if (Number(current.available_stock) > 0) {
      await client.query(
        `insert into inventory_transactions
         (
          product_id,
          location_id,
          transaction_type,
          quantity,
          reference_type,
          remarks,
          created_by
         )
         values ($1,$2,'stock_out',$3,'manual','Location inventory deactivated',$4)`,
        [
          current.product_id,
          current.location_id,
          Number(current.available_stock),
          req.user.id,
        ]
      );
    }

    await client.query(`select sync_main_inventory($1)`, [current.product_id]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Inventory deleted and main inventory synced",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete inventory error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete inventory",
    });
  } finally {
    client.release();
  }
});

/**
 * INVENTORY TRANSACTION HISTORY
 */
router.get("/:id/transactions", async (req, res) => {
  try {
    const invResult = await db.query(
      `select product_id, location_id
       from location_inventory
       where id = $1`,
      [req.params.id]
    );

    if (invResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Inventory not found",
      });
    }

    const inv = invResult.rows[0];

    const result = await db.query(
      `select
        it.*,
        up.full_name as created_by_name
       from inventory_transactions it
       left join user_profiles up
         on up.id = it.created_by
       where it.product_id = $1
       and it.location_id = $2
       order by it.created_at desc`,
      [inv.product_id, inv.location_id]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Inventory transaction history error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch inventory history",
    });
  }
});

/**
 * BULK UPLOAD LOCATION INVENTORY CSV
 *
 * CSV columns:
 * sku,location_name,available_stock,reserved_stock,min_stock_level,remarks
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
    const touchedProducts = new Set();

    await client.query("BEGIN");

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];

      const sku = String(row.sku || "").trim();
      const locationName = String(row.location_name || "").trim();

      const availableStock = Number(row.available_stock || 0);
      const reservedStock = Number(row.reserved_stock || 0);
      const minStock = Number(row.min_stock_level || 0);
      const remarks = row.remarks || "Bulk inventory upload";

      if (!sku || !locationName) {
        results.push({
          row: index + 1,
          success: false,
          message: "sku and location_name are required",
        });
        continue;
      }

      if (availableStock < 0 || reservedStock < 0 || minStock < 0) {
        results.push({
          row: index + 1,
          success: false,
          sku,
          location_name: locationName,
          message: "Stock values cannot be negative",
        });
        continue;
      }

      const productResult = await client.query(
        `select id, name, sku
         from products
         where sku = $1
         limit 1`,
        [sku]
      );

      if (productResult.rows.length === 0) {
        results.push({
          row: index + 1,
          success: false,
          sku,
          message: "Product not found",
        });
        continue;
      }

      const locationResult = await client.query(
        `select id, name
         from service_locations
         where lower(name) = lower($1)
         limit 1`,
        [locationName]
      );

      if (locationResult.rows.length === 0) {
        results.push({
          row: index + 1,
          success: false,
          location_name: locationName,
          message: "Location not found",
        });
        continue;
      }

      const product = productResult.rows[0];
      const location = locationResult.rows[0];

      const existingResult = await client.query(
        `select available_stock
         from location_inventory
         where product_id = $1
         and location_id = $2
         limit 1`,
        [product.id, location.id]
      );

      const oldStock =
        existingResult.rows.length > 0
          ? Number(existingResult.rows[0].available_stock || 0)
          : 0;

      await client.query(
        `insert into location_inventory
         (
          product_id,
          location_id,
          available_stock,
          reserved_stock,
          min_stock_level,
          is_out_of_stock,
          is_active,
          updated_at
         )
         values ($1,$2,$3,$4,$5,$6,true,now())
         on conflict (product_id, location_id)
         do update set
          available_stock = excluded.available_stock,
          reserved_stock = excluded.reserved_stock,
          min_stock_level = excluded.min_stock_level,
          is_out_of_stock = excluded.is_out_of_stock,
          is_active = true,
          updated_at = now()`,
        [
          product.id,
          location.id,
          availableStock,
          reservedStock,
          minStock,
          availableStock <= 0,
        ]
      );

      const diff = availableStock - oldStock;

      if (diff !== 0) {
        await client.query(
          `insert into inventory_transactions
           (
            product_id,
            location_id,
            transaction_type,
            quantity,
            reference_type,
            remarks,
            created_by
           )
           values ($1,$2,$3,$4,'bulk_upload',$5,$6)`,
          [
            product.id,
            location.id,
            diff > 0 ? "stock_in" : "stock_out",
            Math.abs(diff),
            remarks,
            req.user.id,
          ]
        );
      }

      touchedProducts.add(product.id);

      results.push({
        row: index + 1,
        success: true,
        sku,
        product_name: product.name,
        location_name: locationName,
        available_stock: availableStock,
        reserved_stock: reservedStock,
        min_stock_level: minStock,
      });
    }

    for (const productId of touchedProducts) {
      await client.query(`select sync_main_inventory($1)`, [productId]);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Bulk inventory processed",
      total_rows: rows.length,
      processed: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Bulk inventory upload error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Bulk inventory upload failed",
    });
  } finally {
    client.release();
  }
});

module.exports = router;