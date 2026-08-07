const express = require("express");
const db = require("../config/db");
const { authenticate, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(authenticate, authorize("admin", "operator"));

function createSlug(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function validateEcomProduct({ ecom_channel, quantity_unit }) {
  if (!["household", "commercial"].includes(ecom_channel)) {
    return "ecom_channel must be household or commercial";
  }

  if (ecom_channel === "household" && !["ml", "litre"].includes(quantity_unit)) {
    return "Household products must use ml or litre";
  }

  if (ecom_channel === "commercial" && quantity_unit !== "gallon") {
    return "Commercial products must use gallon";
  }

  return null;
}

async function linkProductWithMainInventory(
  client,
  productId,
  sku,
  userId
) {
  const inventoryResult =
    await client.query(
      `select
        id,
        product_id,
        product_link_status
       from main_inventory
       where upper(sku) =
             upper($1)
       and is_active = true
       limit 1
       for update`,
      [sku]
    );

  const inventory =
    inventoryResult.rows[0];

  if (!inventory) {
    return false;
  }

  /*
   * Do not silently replace a manual link
   * pointing to another product.
   */
  if (
    inventory.product_id &&
    inventory.product_id !== productId &&
    inventory.product_link_status ===
      "linked"
  ) {
    return false;
  }

  await client.query(
    `update main_inventory
     set
      product_id = $1,
      product_link_status =
        'linked',
      product_link_type =
        'auto',
      product_linked_at =
        now(),
      product_linked_by =
        $3,
      sku_role =
        coalesce(
          sku_role,
          'primary'
        ),
      updated_by = $3,
      updated_at = now()

     where upper(sku) =
           upper($2)
     and is_active = true`,
    [
      productId,
      sku,
      userId,
    ]
  );

  await client.query(
    `update products
     set
      inventory_link_status =
        'linked',
      updated_at = now()
     where id = $1`,
    [productId]
  );

  return true;
}

async function replaceProductServiceLocations(client, productId, serviceLocationIds) {
  await client.query(
    `update product_service_locations
     set is_active = false,
         updated_at = now()
     where product_id = $1`,
    [productId]
  );

  if (!Array.isArray(serviceLocationIds) || serviceLocationIds.length === 0) {
    return;
  }

  const uniqueIds = [...new Set(serviceLocationIds)];

  for (const serviceLocationId of uniqueIds) {
    const locationResult = await client.query(
      `select id
       from service_locations
       where id = $1
       and is_active = true
       limit 1`,
      [serviceLocationId]
    );

    if (locationResult.rows.length === 0) {
      throw new Error(`Invalid service location: ${serviceLocationId}`);
    }

    await client.query(
      `insert into product_service_locations
       (
        product_id,
        service_location_id,
        is_active,
        created_at,
        updated_at
       )
       values ($1,$2,true,now(),now())
       on conflict (product_id, service_location_id)
       do update set
        is_active = true,
        updated_at = now()`,
      [productId, serviceLocationId]
    );
  }
}

async function replaceProductImages(client, productId, productName, images) {
  await client.query(
    `update product_images
     set is_active = false,
         updated_at = now()
     where product_id = $1`,
    [productId]
  );

  if (!Array.isArray(images) || images.length === 0) {
    await client.query(
      `update products
       set primary_image_url = null,
           updated_at = now()
       where id = $1`,
      [productId]
    );
    return;
  }

  let primaryImageUrl = null;

  for (let index = 0; index < images.length; index++) {
    const img = images[index];

    if (!img.image_url) continue;

    const isPrimary = index === 0 ? true : Boolean(img.is_primary);

    if (isPrimary && !primaryImageUrl) {
      primaryImageUrl = img.image_url;
    }

    await client.query(
      `insert into product_images
       (
        product_id,
        image_url,
        storage_bucket,
        storage_path,
        file_name,
        mime_type,
        file_size,
        alt_text,
        is_primary,
        display_order,
        is_active,
        created_at,
        updated_at
       )
       values
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,now(),now())`,
      [
        productId,
        img.image_url,
        img.storage_bucket || null,
        img.storage_path || null,
        img.file_name || null,
        img.mime_type || null,
        img.file_size || null,
        img.alt_text || productName,
        isPrimary,
        img.display_order ?? index,
      ]
    );
  }

  await client.query(
    `update products
     set primary_image_url = $1,
         updated_at = now()
     where id = $2`,
    [primaryImageUrl, productId]
  );
}

const multer = require("multer");
const path = require("path");
const supabase = require("../config/supabase");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }

    cb(null, true);
  },
});

/**
 * GET products
 */
router.get("/", async (req, res) => {
  try {
    const { limit = 100, offset = 0, search, ecom_channel } = req.query;

    const params = [];
    const conditions = ["1=1"];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(name ilike $${params.length} or sku ilike $${params.length} or brand ilike $${params.length})`
      );
    }

    if (ecom_channel) {
      params.push(ecom_channel);
      conditions.push(`ecom_channel = $${params.length}`);
    }

    params.push(Number(limit));
    const limitParam = params.length;

    params.push(Number(offset));
    const offsetParam = params.length;

    const result = await db.query(
      `select *
       from admin_product_listing
       where ${conditions.join(" and ")}
       order by created_at desc
       limit $${limitParam}
       offset $${offsetParam}`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch products",
    });
  }
});

/**
 * GET product detail
 */
router.get("/:id", async (req, res) => {
  try {
    const productResult = await db.query(
      `select *
       from admin_product_listing
       where id = $1
       limit 1`,
      [req.params.id]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const locationsResult = await db.query(
      `select
        psl.service_location_id,
        sl.name,
        sl.city,
        sl.state,
        sl.pincode
       from product_service_locations psl
       join service_locations sl
         on sl.id = psl.service_location_id
       where psl.product_id = $1
       and psl.is_active = true
       order by sl.name asc`,
      [req.params.id]
    );

    const imagesResult = await db.query(
      `select *
       from product_images
       where product_id = $1
       and coalesce(is_active, true) = true
       order by is_primary desc, display_order asc, created_at asc`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: {
        ...productResult.rows[0],
        service_locations: locationsResult.rows,
        images: imagesResult.rows,
      },
    });
  } catch (error) {
    console.error("Get product detail error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch product detail",
    });
  }
});

/**
 * CREATE ecom product
 */
router.post("/", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      category_id,
      name,
      slug,
      sku,
      short_description,
      description,
      brand,

      ecom_channel,
      quantity_value,
      quantity_unit,

      unit,
      weight,

      mrp,
      selling_price,
      currency,

      is_featured,
      is_available_for_sale,

      service_location_ids,
      images,
    } = req.body;

    if (!category_id || !name || !sku || !ecom_channel || !quantity_unit) {
      return res.status(400).json({
        success: false,
        message: "category_id, name, sku, ecom_channel and quantity_unit are required",
      });
    }

    const validationMessage = validateEcomProduct({
      ecom_channel,
      quantity_unit,
    });

    if (validationMessage) {
      return res.status(400).json({
        success: false,
        message: validationMessage,
      });
    }

    if (!Array.isArray(service_location_ids) || service_location_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one service location is required",
      });
    }

    await client.query("BEGIN");

    const duplicateResult = await client.query(
      `select id
       from products
       where upper(sku) = upper($1)
       limit 1`,
      [sku]
    );

    if (duplicateResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Product already exists with this SKU",
      });
    }

    const inventoryResult = await client.query(
      `select id
       from main_inventory
       where upper(sku) = upper($1)
       and is_active = true
       limit 1`,
      [sku]
    );

    const inventoryLinked = inventoryResult.rows.length > 0;

    const productResult = await client.query(
      `insert into products
       (
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
       values
       (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$8,$9,$10,
        $11,$12,
        $13,$14,$15,
        $16,$17,$18,true,$19,now(),now()
       )
       returning *`,
      [
        category_id,
        name,
        slug || createSlug(name),
        sku.trim().toUpperCase(),
        short_description || null,
        description || null,
        brand || null,

        ecom_channel,
        quantity_value ? Number(quantity_value) : null,
        quantity_unit,

        unit || null,
        weight ? Number(weight) : null,

        mrp !== undefined ? Number(mrp) : null,
        selling_price !== undefined ? Number(selling_price) : null,
        currency || "INR",

        Boolean(is_featured),
        is_available_for_sale !== false,
        inventoryLinked ? "linked" : "pending",
        req.user.id,
      ]
    );

    const product = productResult.rows[0];

if (inventoryLinked) {
  await linkProductWithMainInventory(
    client,
    product.id,
    product.sku,
    req.user.id
  );
}

    await replaceProductServiceLocations(client, product.id, service_location_ids);
    await replaceProductImages(client, product.id, product.name, images);

    await client.query(
      `insert into audit_logs
       (user_id, action, module, record_id, new_data)
       values ($1,'CREATE','PRODUCT',$2,$3)`,
      [req.user.id, product.id, product]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: inventoryLinked
        ? "Product created and linked with main inventory"
        : "Product created. Inventory link pending because SKU is not available in main inventory.",
      data: product,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create product error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to create product",
    });
  } finally {
    client.release();
  }
});

router.post("/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Image file is required",
      });
    }

    const bucket = process.env.SUPABASE_PRODUCT_IMAGE_BUCKET || "product-images";

    const ext = path.extname(req.file.originalname) || ".png";
    const safeName = req.file.originalname
      .replace(ext, "")
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .toLowerCase();

    const fileName = `${Date.now()}-${safeName}${ext}`;
    const storagePath = `products/${fileName}`;

    const { error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (error) {
      throw error;
    }

    const { data } = supabase.storage
      .from(bucket)
      .getPublicUrl(storagePath);

    res.json({
      success: true,
      message: "Image uploaded successfully",
      image_url: data.publicUrl,
      storage_bucket: bucket,
      storage_path: storagePath,
      file_name: req.file.originalname,
      mime_type: req.file.mimetype,
      file_size: req.file.size,
    });
  } catch (error) {
    console.error("Product image upload error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to upload product image",
    });
  }
});
/**
 * UPDATE product
 * SKU is locked after creation.
 */
router.put("/:id", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      category_id,
      name,
      short_description,
      description,
      brand,

      ecom_channel,
      quantity_value,
      quantity_unit,

      unit,
      weight,

      mrp,
      selling_price,
      currency,

      is_featured,
      is_available_for_sale,
      is_active,

      service_location_ids,
      images,
    } = req.body;

    await client.query("BEGIN");

    const existingResult = await client.query(
      `select *
       from products
       where id = $1
       limit 1`,
      [req.params.id]
    );

    if (existingResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const existing = existingResult.rows[0];

    const nextEcomChannel = ecom_channel || existing.ecom_channel;
    const nextQuantityUnit = quantity_unit || existing.quantity_unit;

    const validationMessage = validateEcomProduct({
      ecom_channel: nextEcomChannel,
      quantity_unit: nextQuantityUnit,
    });

    if (validationMessage) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: validationMessage,
      });
    }

    const result = await client.query(
      `update products
       set
        category_id = coalesce($1, category_id),
        name = coalesce($2, name),
        slug = case when $2::text is null then slug else $3 end,
        short_description = $4,
        description = $5,
        brand = $6,

        ecom_channel = $7,
        portal_type = $7,
        quantity_value = $8,
        quantity_unit = $9,

        unit = $10,
        weight = $11,

        mrp = $12,
        selling_price = $13,
        currency = $14,

        is_featured = $15,
        is_available_for_sale = $16,
        is_active = $17,
        updated_at = now()
       where id = $18
       returning *`,
      [
        category_id || null,
        name || null,
        name ? createSlug(name) : null,
        short_description ?? existing.short_description,
        description ?? existing.description,
        brand ?? existing.brand,

        nextEcomChannel,
        quantity_value !== undefined ? Number(quantity_value) : existing.quantity_value,
        nextQuantityUnit,

        unit ?? existing.unit,
        weight !== undefined ? Number(weight) : existing.weight,

        mrp !== undefined ? Number(mrp) : existing.mrp,
        selling_price !== undefined ? Number(selling_price) : existing.selling_price,
        currency || existing.currency || "INR",

        is_featured !== undefined ? Boolean(is_featured) : existing.is_featured,
        is_available_for_sale !== undefined
          ? Boolean(is_available_for_sale)
          : existing.is_available_for_sale,
        is_active !== undefined ? Boolean(is_active) : existing.is_active,

        req.params.id,
      ]
    );

    const product = result.rows[0];

    await linkProductWithMainInventory(
  client,
  product.id,
  product.sku,
  req.user.id
);

    if (Array.isArray(service_location_ids)) {
      await replaceProductServiceLocations(client, product.id, service_location_ids);
    }

    if (Array.isArray(images)) {
      await replaceProductImages(client, product.id, product.name, images);
    }

    await client.query(
      `insert into audit_logs
       (user_id, action, module, record_id, new_data)
       values ($1,'UPDATE','PRODUCT',$2,$3)`,
      [req.user.id, product.id, product]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Product updated successfully",
      data: product,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Update product error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to update product",
    });
  } finally {
    client.release();
  }
});

/**
 * DELETE / deactivate product
 */
router.delete("/:id", async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `select *
       from products
       where id = $1
       limit 1`,
      [req.params.id]
    );

    if (productResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const product = productResult.rows[0];

    const result = await client.query(
      `update products
       set is_active = false,
           is_available_for_sale = false,
           updated_at = now()
       where id = $1
       returning *`,
      [req.params.id]
    );

    await client.query(
      `update product_service_locations
       set is_active = false,
           updated_at = now()
       where product_id = $1`,
      [req.params.id]
    );

    await client.query(
  `update main_inventory
   set
    product_id = null,
    product_link_status =
      'pending',
    product_link_type = null,
    product_linked_at = null,
    product_linked_by = null,
    updated_at = now()
   where product_id = $1`,
  [req.params.id]
);

    await client.query(
      `insert into audit_logs
       (user_id, action, module, record_id, old_data, new_data)
       values ($1,'DELETE','PRODUCT',$2,$3,$4)`,
      [req.user.id, req.params.id, product, result.rows[0]]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Product deactivated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete product error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete product",
    });
  } finally {
    client.release();
  }
});

/**
 * GET product images
 */
router.get("/:id/images", async (req, res) => {
  try {
    const result = await db.query(
      `select *
       from product_images
       where product_id = $1
       and coalesce(is_active, true) = true
       order by is_primary desc, display_order asc, created_at asc`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get product images error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch product images",
    });
  }
});

/**
 * GET product service locations
 */
router.get("/:id/service-locations", async (req, res) => {
  try {
    const result = await db.query(
      `select
        psl.id,
        psl.service_location_id,
        sl.name,
        sl.city,
        sl.state,
        sl.pincode,
        psl.is_active
       from product_service_locations psl
       join service_locations sl
         on sl.id = psl.service_location_id
       where psl.product_id = $1
       and psl.is_active = true
       order by sl.name asc`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get product service locations error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch product service locations",
    });
  }
});

module.exports = router;