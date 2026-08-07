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

const normalizeSku = (value) =>
  clean(value).toUpperCase();

const normalizeLinkReason = (value) => {
  const reason = clean(value).toLowerCase();

  if (
    reason === "no_product" ||
    reason === "sku_mismatch"
  ) {
    return reason;
  }

  return "";
};

const normalizeLinkType = (value) => {
  const type = clean(value).toLowerCase();

  if (type === "auto" || type === "manual") {
    return type;
  }

  return "";
};

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const getStockStatus = (availableStock, minStock) => ({
  isOutOfStock: availableStock <= 0,
  isLowStock: availableStock > 0 && availableStock <= minStock,
});

async function findProductBySku(
  client,
  sku
) {
  const result = await client.query(
    `select
      id,
      sku,
      name,
      portal_type,
      ecom_channel,
      inventory_link_status,
      is_active
     from products
     where upper(sku) = upper($1)
     and is_active = true
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

async function upsertInventoryBySku(
  client,
  row,
  userId,
  transactionType = "bulk_upload",
  options = {}
) {
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
   where upper(sku) = upper($1)
   limit 1`,
  [sku]
);

const existing = existingResult.rows[0];

if (existing && options.rejectExisting) {
  const error = new Error(
    `SKU ${sku} already exists in main inventory`
  );

  error.code = "DUPLICATE_SKU";
  throw error;
}


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
product_link_type,
product_linked_at,
product_linked_by,
sku_role,
is_active,
remarks,
created_by,
updated_by,
created_at,
updated_at
     )
     values
     (
      $1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,'primary',true,$13,$14,$14,now(),now()
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
    when coalesce(
      main_inventory.product_id,
      excluded.product_id
    ) is null
    then 'pending'
    else 'linked'
  end,

product_link_type =
  case
    when main_inventory.product_id is not null
    then main_inventory.product_link_type
    when excluded.product_id is not null
    then 'auto'
    else null
  end,

product_linked_at =
  case
    when main_inventory.product_id is not null
    then main_inventory.product_linked_at
    when excluded.product_id is not null
    then now()
    else null
  end,

product_linked_by =
  case
    when main_inventory.product_id is not null
    then main_inventory.product_linked_by
    when excluded.product_id is not null
    then excluded.updated_by
    else null
  end,

sku_role =
  coalesce(
    main_inventory.sku_role,
    'primary'
  ),
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
  product ? "auto" : null,
  product ? new Date() : null,
  product ? userId : null,

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
        mi.product_link_type,
mi.product_linked_at,
mi.product_linked_by,
mi.sku_role,
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
/**
 * CHECK WHETHER A MAIN-INVENTORY SKU ALREADY EXISTS
 */
router.get("/check-sku/:sku", async (req, res) => {
  try {
    const sku = clean(req.params.sku).toUpperCase();

    if (!sku) {
      return res.status(400).json({
        success: false,
        message: "SKU is required",
      });
    }

    const result = await db.query(
      `select
        id,
        sku,
        item_name,
        total_stock,
        reserved_stock,
        allocated_stock,
        available_stock,
        min_stock_level,
        product_link_status,
        product_id,
        remarks,
        is_active
       from main_inventory
       where upper(sku) = upper($1)
       and is_active = true
       limit 1`,
      [sku]
    );

    return res.json({
      success: true,
      exists: result.rows.length > 0,
      data: result.rows[0] || null,
    });
  } catch (error) {
    console.error("Check main inventory SKU error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to check SKU",
    });
  }
});


/**
 * PRODUCT LINKING STATISTICS
 */
router.get(
  "/product-links/stats",
  async (req, res) => {
    try {
      const result = await db.query(
        `select
          count(*)::int as total_skus,

          count(*) filter (
            where product_id is not null
            and product_link_status = 'linked'
            and coalesce(
              product_link_type,
              'auto'
            ) = 'auto'
          )::int as auto_linked,

          count(*) filter (
            where product_id is not null
            and product_link_status = 'linked'
            and product_link_type = 'manual'
          )::int as manually_linked,

          count(*) filter (
            where product_id is null
            or product_link_status <> 'linked'
          )::int as unlinked,

          count(*) filter (
            where (
              product_id is null
              or product_link_status <> 'linked'
            )
            and not exists (
              select 1
              from products p
              where p.is_active = true
              and (
                upper(p.sku) = upper(mi.sku)
                or lower(trim(p.name)) =
                   lower(trim(mi.item_name))
              )
            )
          )::int as no_product_exists,

          count(*) filter (
            where (
              product_id is null
              or product_link_status <> 'linked'
            )
            and not exists (
              select 1
              from products exact_product
              where exact_product.is_active = true
              and upper(exact_product.sku) =
                  upper(mi.sku)
            )
            and exists (
              select 1
              from products name_product
              where name_product.is_active = true
              and lower(trim(name_product.name)) =
                  lower(trim(mi.item_name))
            )
          )::int as sku_mismatch

         from main_inventory mi
         where mi.is_active = true`
      );

      return res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Get product linking stats error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Failed to fetch product linking statistics",
      });
    }
  }
);



/**
 * GET PRODUCT LINKING RECORDS
 *
 * Query:
 * status=linked|unlinked
 * search=
 * reason=no_product|sku_mismatch
 * catalogue=ecom|distribution|white_label
 * link_type=auto|manual
 */
router.get(
  "/product-links",
  async (req, res) => {
    try {
      const {
        status,
        search,
        reason,
        catalogue,
        link_type,
      } = req.query;

      const params = [];
      const conditions = [
        "mi.is_active = true",
      ];

      if (status === "linked") {
        conditions.push(
          "mi.product_id is not null"
        );

        conditions.push(
          "mi.product_link_status = 'linked'"
        );
      }

      if (status === "unlinked") {
        conditions.push(
          `(mi.product_id is null
            or mi.product_link_status <> 'linked')`
        );
      }

      if (search) {
        params.push(
          `%${clean(search)}%`
        );

        const index = params.length;

        conditions.push(
          `(
            mi.sku ilike $${index}
            or coalesce(mi.item_name, '') ilike $${index}
            or coalesce(p.name, '') ilike $${index}
            or coalesce(p.sku, '') ilike $${index}
          )`
        );
      }

      const finalLinkType =
        normalizeLinkType(link_type);

      if (finalLinkType) {
        params.push(finalLinkType);

        conditions.push(
          `mi.product_link_type = $${params.length}`
        );
      }

      if (catalogue) {
        const finalCatalogue =
          clean(catalogue).toLowerCase();

        if (
          finalCatalogue === "ecom"
        ) {
          conditions.push(
            `(
              p.portal_type in (
                'household',
                'commercial',
                'ecom'
              )
              or p.ecom_channel in (
                'household',
                'commercial'
              )
            )`
          );
        }

        if (
          finalCatalogue ===
          "distribution"
        ) {
          conditions.push(
            `p.portal_type in (
              'distribution',
              'distributor'
            )`
          );
        }

        if (
          finalCatalogue ===
          "white_label"
        ) {
          conditions.push(
            `p.portal_type in (
              'white_label',
              'whitelabel'
            )`
          );
        }
      }

      const finalReason =
        normalizeLinkReason(reason);

      if (
        finalReason === "no_product"
      ) {
        conditions.push(
          `not exists (
            select 1
            from products rp
            where rp.is_active = true
            and (
              upper(rp.sku) = upper(mi.sku)
              or lower(trim(rp.name)) =
                 lower(trim(mi.item_name))
            )
          )`
        );
      }

      if (
        finalReason === "sku_mismatch"
      ) {
        conditions.push(
          `not exists (
            select 1
            from products exact_product
            where exact_product.is_active = true
            and upper(exact_product.sku) =
                upper(mi.sku)
          )`
        );

        conditions.push(
          `exists (
            select 1
            from products name_product
            where name_product.is_active = true
            and lower(trim(name_product.name)) =
                lower(trim(mi.item_name))
          )`
        );
      }

      const result = await db.query(
        `select
          mi.id
            as main_inventory_id,

          mi.sku,
          mi.item_name,
          mi.total_stock,
          mi.reserved_stock,
          mi.allocated_stock,
          mi.available_stock,

          mi.product_id,
          mi.product_link_status,
          mi.product_link_type,
          mi.product_linked_at,
          mi.product_linked_by,
          mi.sku_role,

          p.name
            as product_name,
          p.sku
            as product_sku,
          p.portal_type
            as product_portal,
          p.ecom_channel,

          case
            when mi.product_id is not null
              and mi.product_link_status = 'linked'
            then null

            when exists (
              select 1
              from products exact_product
              where exact_product.is_active = true
              and upper(exact_product.sku) =
                  upper(mi.sku)
            )
            then 'sku_match_available'

            when exists (
              select 1
              from products name_product
              where name_product.is_active = true
              and lower(trim(name_product.name)) =
                  lower(trim(mi.item_name))
            )
            then 'sku_mismatch'

            else 'no_product'
          end as reason

         from main_inventory mi

         left join products p
           on p.id = mi.product_id

         where ${conditions.join(
           " and "
         )}

         order by
           case
             when mi.product_id is null
             then 0
             else 1
           end,
           mi.updated_at desc`,
        params
      );

      return res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      console.error(
        "Get inventory product links error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Failed to fetch inventory product links",
      });
    }
  }
);







/**
 * SEARCH PRODUCTS FOR MANUAL LINKING
 */
router.get(
  "/:id/product-candidates",
  async (req, res) => {
    try {
      const search = clean(
        req.query.search
      );

      const requestedLimit = Number(
        req.query.limit || 30
      );

      const limit = Math.min(
        Math.max(
          Number.isFinite(
            requestedLimit
          )
            ? requestedLimit
            : 30,
          1
        ),
        100
      );

      const inventoryResult =
        await db.query(
          `select
            id,
            sku,
            item_name,
            product_id
           from main_inventory
           where id = $1
           and is_active = true
           limit 1`,
          [req.params.id]
        );

      if (
        inventoryResult.rows.length ===
        0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Main inventory not found",
        });
      }

      const inventory =
        inventoryResult.rows[0];

      const params = [
        inventory.sku,
        search
          ? `%${search}%`
          : "%",
        limit,
      ];

      const result = await db.query(
        `select
          p.id,
          p.sku,
          p.name,
          p.portal_type,
          p.ecom_channel,
          p.inventory_link_status,

          case
            when upper(p.sku) =
                 upper($1)
            then true
            else false
          end as exact_sku_match,

          case
            when exists (
              select 1
              from main_inventory other_mi
              where other_mi.product_id = p.id
              and other_mi.is_active = true
              and other_mi.id <> $4
            )
            then true
            else false
          end as already_linked_elsewhere

         from products p

         where p.is_active = true

         and (
           p.sku ilike $2
           or p.name ilike $2
           or coalesce(
             p.brand,
             ''
           ) ilike $2
         )

         order by
           case
             when upper(p.sku) =
                  upper($1)
             then 0
             else 1
           end,
           p.name asc

         limit $3`,
        [
          inventory.sku,
          search
            ? `%${search}%`
            : "%",
          limit,
          inventory.id,
        ]
      );

      return res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      console.error(
        "Get product candidates error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Failed to search products",
      });
    }
  }
);


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
 * MANUALLY LINK INVENTORY TO PRODUCT
 */
router.post(
  "/:id/link-product",
  async (req, res) => {
    const client =
      await db.pool.connect();

    try {
      const productId =
        clean(req.body.product_id);

      if (!productId) {
        return res.status(400).json({
          success: false,
          message:
            "product_id is required",
        });
      }

      await client.query("BEGIN");

      const inventoryResult =
        await client.query(
          `select *
           from main_inventory
           where id = $1
           and is_active = true
           limit 1
           for update`,
          [req.params.id]
        );

      if (
        inventoryResult.rows.length ===
        0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message:
            "Main inventory not found",
        });
      }

      const inventory =
        inventoryResult.rows[0];

      const productResult =
        await client.query(
          `select
            id,
            sku,
            name,
            portal_type,
            inventory_link_status
           from products
           where id = $1
           and is_active = true
           limit 1
           for update`,
          [productId]
        );

      if (
        productResult.rows.length ===
        0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message:
            "Active product not found",
        });
      }

      const product =
        productResult.rows[0];

      const conflictResult =
        await client.query(
          `select
            id,
            sku,
            item_name
           from main_inventory
           where product_id = $1
           and is_active = true
           and id <> $2
           limit 1`,
          [
            product.id,
            inventory.id,
          ]
        );

      if (
        conflictResult.rows.length > 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({
          success: false,
          message:
            `This product is already linked to inventory SKU ${conflictResult.rows[0].sku}`,
        });
      }

      /*
       * If this inventory was previously
       * linked with a different product,
       * mark that old product as pending.
       */
      if (
        inventory.product_id &&
        inventory.product_id !==
          product.id
      ) {
        await client.query(
          `update products
           set inventory_link_status =
                 'pending',
               updated_at = now()
           where id = $1`,
          [inventory.product_id]
        );
      }

      const linkType =
        normalizeSku(inventory.sku) ===
        normalizeSku(product.sku)
          ? "auto"
          : "manual";

      const result =
        await client.query(
          `update main_inventory
           set
            product_id = $1,
            product_link_status =
              'linked',
            product_link_type = $2,
            product_linked_at = now(),
            product_linked_by = $3,
            sku_role =
              coalesce(
                sku_role,
                'primary'
              ),
            updated_by = $3,
            updated_at = now()
           where id = $4
           returning *`,
          [
            product.id,
            linkType,
            req.user.id,
            inventory.id,
          ]
        );

      await client.query(
        `update products
         set
          inventory_link_status =
            'linked',
          updated_at = now()
         where id = $1`,
        [product.id]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message:
          linkType === "auto"
            ? "Inventory linked to matching product SKU"
            : "Inventory manually linked to product",
        data: {
          ...result.rows[0],
          product_name:
            product.name,
          product_sku:
            product.sku,
          product_portal:
            product.portal_type,
        },
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "Manual inventory product link error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Failed to link inventory to product",
      });
    } finally {
      client.release();
    }
  }
);


/**
 * UNLINK INVENTORY FROM PRODUCT
 */
router.post(
  "/:id/unlink-product",
  async (req, res) => {
    const client =
      await db.pool.connect();

    try {
      await client.query("BEGIN");

      const inventoryResult =
        await client.query(
          `select *
           from main_inventory
           where id = $1
           and is_active = true
           limit 1
           for update`,
          [req.params.id]
        );

      if (
        inventoryResult.rows.length ===
        0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message:
            "Main inventory not found",
        });
      }

      const inventory =
        inventoryResult.rows[0];

      if (!inventory.product_id) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          success: false,
          message:
            "Inventory is already unlinked",
        });
      }

      const oldProductId =
        inventory.product_id;

      const result =
        await client.query(
          `update main_inventory
           set
            product_id = null,
            product_link_status =
              'pending',
            product_link_type = null,
            product_linked_at = null,
            product_linked_by = null,
            updated_by = $1,
            updated_at = now()
           where id = $2
           returning *`,
          [
            req.user.id,
            inventory.id,
          ]
        );

      const remainingLink =
        await client.query(
          `select 1
           from main_inventory
           where product_id = $1
           and is_active = true
           limit 1`,
          [oldProductId]
        );

      if (
        remainingLink.rows.length ===
        0
      ) {
        await client.query(
          `update products
           set
            inventory_link_status =
              'pending',
            updated_at = now()
           where id = $1`,
          [oldProductId]
        );
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message:
          "Product unlinked from inventory",
        data: result.rows[0],
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "Unlink inventory product error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Failed to unlink product",
      });
    } finally {
      client.release();
    }
  }
);

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
  "stock_in",
  {
    rejectExisting: true,
  }
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

return res
  .status(error.code === "DUPLICATE_SKU" ? 409 : 500)
  .json({
    success: false,
    code: error.code || "SAVE_FAILED",
    message:
      error.message || "Failed to save main inventory",
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
/**
 * AUTO LINK ALL MATCHING SKUs
 */
router.post(
  "/link-products",
  async (req, res) => {
    const client =
      await db.pool.connect();

    try {
      await client.query("BEGIN");

      /*
       * Only link inventory that is currently
       * unlinked. Do not overwrite a manual
       * association.
       */
      const result =
        await client.query(
          `update main_inventory mi
           set
            product_id = p.id,
            product_link_status =
              'linked',
            product_link_type =
              'auto',
            product_linked_at =
              now(),
            product_linked_by =
              $1,
            sku_role =
              coalesce(
                mi.sku_role,
                'primary'
              ),
            updated_by = $1,
            updated_at = now()

           from products p

           where
            upper(p.sku) =
              upper(mi.sku)

           and p.is_active = true
           and mi.is_active = true

           and (
             mi.product_id is null
             or mi.product_link_status
                <> 'linked'
           )

           and not exists (
             select 1
             from main_inventory other_mi
             where
              other_mi.product_id =
                p.id
             and
              other_mi.is_active =
                true
             and
              other_mi.id <>
                mi.id
           )

           returning
            mi.id,
            mi.sku,
            mi.item_name,
            mi.product_id,
            mi.product_link_status,
            mi.product_link_type`
          ,
          [req.user.id]
        );

      if (result.rows.length > 0) {
        const productIds =
          result.rows
            .map(
              (row) =>
                row.product_id
            )
            .filter(Boolean);

        if (
          productIds.length > 0
        ) {
          await client.query(
            `update products
             set
              inventory_link_status =
                'linked',
              updated_at = now()
             where id = any($1::uuid[])`,
            [productIds]
          );
        }
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message:
          result.rows.length > 0
            ? `${result.rows.length} inventory SKU(s) auto-linked`
            : "No new matching inventory SKUs found",
        linked_count:
          result.rows.length,
        data: result.rows,
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "Auto-link inventory products error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Failed to auto-link inventory products",
      });
    } finally {
      client.release();
    }
  }
);

/**
 * BULK UPLOAD MAIN INVENTORY
 *
 * CSV columns:
 * sku,total_stock,reserved_stock,min_stock_level,remarks
 *
 * Optional:
 * item_name
 */
/**
 * BULK UPLOAD OR VALIDATE MAIN INVENTORY
 *
 * CSV columns:
 * sku,item_name,total_stock,reserved_stock,min_stock_level,remarks
 */
router.post(
  "/bulk-upload",
  upload.single("file"),
  async (req, res) => {
    const validateOnly =
      String(req.query.validate_only).toLowerCase() ===
      "true";

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
          .pipe(
            csvParser({
              mapHeaders: ({ header }) =>
                String(header || "")
                  .trim()
                  .toLowerCase(),
            })
          )
          .on("data", (row) => rows.push(row))
          .on("end", resolve)
          .on("error", reject);
      });

      if (rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: "The CSV file has no data rows",
        });
      }

      const results = [];
      const fileSkus = new Set();

      await client.query("BEGIN");

      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const rowNumber = index + 2;
        const sku = clean(row.sku).toUpperCase();

        try {
          if (!sku) {
            throw new Error("SKU is required");
          }

          if (
            !/^[A-Z0-9][A-Z0-9._-]*$/i.test(sku)
          ) {
            throw new Error(
              "SKU may contain only letters, numbers, hyphens, dots and underscores"
            );
          }

          if (fileSkus.has(sku)) {
            throw new Error(
              `Duplicate SKU ${sku} in uploaded CSV`
            );
          }

          fileSkus.add(sku);

          if (!clean(row.item_name)) {
            throw new Error("Item name is required");
          }

          const inventory =
            await upsertInventoryBySku(
              client,
              {
                ...row,
                sku,
              },
              req.user.id,
              "bulk_upload",
              {
                rejectExisting: true,
              }
            );

          results.push({
            row: rowNumber,
            success: true,
            sku: inventory.sku,
            item_name: inventory.item_name,
            total_stock: Number(
              inventory.total_stock || 0
            ),
            reserved_stock: Number(
              inventory.reserved_stock || 0
            ),
            allocated_stock: Number(
              inventory.allocated_stock || 0
            ),
            available_stock: Number(
              inventory.available_stock || 0
            ),
            min_stock_level: Number(
              inventory.min_stock_level || 0
            ),
            product_link_status:
              inventory.product_link_status,
            product_id: inventory.product_id,
            message: validateOnly
              ? "Valid and ready to import"
              : "Inventory created",
          });
        } catch (rowError) {
          results.push({
            row: rowNumber,
            success: false,
            sku,
            item_name: clean(row.item_name),
            message:
              rowError.message || "Validation failed",
          });
        }
      }

      if (validateOnly) {
        await client.query("ROLLBACK");
      } else {
        await client.query("COMMIT");
      }

      const successfulRows = results.filter(
        (row) => row.success
      ).length;

      const failedRows = results.filter(
        (row) => !row.success
      ).length;

      return res.json({
        success: true,
        validate_only: validateOnly,
        message: validateOnly
          ? "CSV validation completed"
          : "Main inventory import completed",
        total_rows: rows.length,
        processed: successfulRows,
        valid: successfulRows,
        failed: failedRows,
        invalid: failedRows,
        results,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Bulk upload rollback error:",
          rollbackError
        );
      }

      console.error(
        "Bulk upload main inventory error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message || "Bulk upload failed",
      });
    } finally {
      client.release();
    }
  }
);

module.exports = router;