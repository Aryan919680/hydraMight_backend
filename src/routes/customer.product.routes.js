const express = require("express");
const db = require("../config/db");

const router = express.Router();

/**
 * GET locations for customer selection.
 */
router.get("/locations", async (req, res) => {
  try {
    const result = await db.query(
      `select
        id,
        name,
        city,
        state,
        pincode,
        latitude,
        longitude,
        radius_km
       from service_locations
       where is_active = true
       order by city asc, name asc`,
      []
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Customer locations error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch locations",
    });
  }
});

/**
 * GET active categories.
 */
router.get("/categories", async (req, res) => {
  try {
    const result = await db.query(
      `select
        id,
        name,
        slug,
        description,
        image_url,
        display_order
       from categories
       where is_active = true
       order by display_order asc, name asc`,
      []
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Customer categories error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch categories",
    });
  }
});

/**
 * GET customer products.
 *
 * New flow:
 * /api/customer/products?service_location_id=uuid&ecom_channel=household
 * /api/customer/products?service_location_id=uuid&ecom_channel=commercial
 *
 * Backward compatible:
 * /api/customer/products?location_id=uuid&portal_type=household
 */
router.get("/products", async (req, res) => {
  try {
    const {
      service_location_id,
      location_id,

      ecom_channel,
      portal_type,

      category_slug,
      search,
      featured,
      limit = 20,
      offset = 0,
    } = req.query;

    const finalLocationId = service_location_id || location_id;
    const finalEcomChannel = ecom_channel || portal_type;

    const conditions = [];
    const params = [];

    if (finalLocationId) {
      params.push(finalLocationId);
      conditions.push(`cpl.service_location_id = $${params.length}`);
    }

    if (finalEcomChannel) {
      if (!["household", "commercial"].includes(finalEcomChannel)) {
        return res.status(400).json({
          success: false,
          message: "ecom_channel must be household or commercial",
        });
      }

      params.push(finalEcomChannel);
      conditions.push(`cpl.ecom_channel = $${params.length}`);
    }

    if (category_slug) {
      params.push(category_slug);
      conditions.push(`cpl.category_slug = $${params.length}`);
    }

    if (featured === "true") {
      conditions.push(`cpl.is_featured = true`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`
        (
          cpl.name ilike $${params.length}
          or cpl.brand ilike $${params.length}
          or cpl.short_description ilike $${params.length}
          or cpl.description ilike $${params.length}
        )
      `);
    }

    params.push(Number(limit));
    const limitParam = `$${params.length}`;

    params.push(Number(offset));
    const offsetParam = `$${params.length}`;

    const whereClause = conditions.length
      ? `where ${conditions.join(" and ")}`
      : "";

    const result = await db.query(
      `select
        cpl.id,
        cpl.name,
        cpl.slug,
        cpl.sku,

        cpl.short_description,
        cpl.description,
        cpl.brand,

        cpl.ecom_channel,
        cpl.quantity_value,
        cpl.quantity_unit,
        cpl.unit,
        cpl.weight,

        cpl.mrp,
        cpl.selling_price,
        cpl.currency,

        cpl.is_featured,

        cpl.category_id,
        cpl.category_name,
        cpl.category_slug,

        cpl.service_location_id,
        cpl.service_location_name,
        cpl.service_location_city,
        cpl.service_location_state,
        cpl.service_location_pincode,

        cpl.allocated_stock,
        cpl.reserved_stock,
        cpl.available_stock,
        cpl.is_out_of_stock,
        cpl.is_low_stock,

        cpl.primary_image,

        coalesce(
          (
            select json_agg(
              json_build_object(
                'id', pi.id,
                'image_url', pi.image_url,
                'storage_bucket', pi.storage_bucket,
                'storage_path', pi.storage_path,
                'file_name', pi.file_name,
                'mime_type', pi.mime_type,
                'file_size', pi.file_size,
                'alt_text', pi.alt_text,
                'is_primary', pi.is_primary,
                'display_order', pi.display_order
              )
              order by pi.is_primary desc, pi.display_order asc, pi.created_at asc
            )
            from product_images pi
            where pi.product_id = cpl.id
            and coalesce(pi.is_active, true) = true
          ),
          '[]'::json
        ) as images

       from customer_product_listing cpl

       ${whereClause}

       order by cpl.is_featured desc, cpl.name asc
       limit ${limitParam} offset ${offsetParam}`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Customer products error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch products",
    });
  }
});

/**
 * GET product detail by slug.
 *
 * New flow:
 * /api/customer/products/:slug?service_location_id=uuid&ecom_channel=household
 *
 * Backward compatible:
 * /api/customer/products/:slug?location_id=uuid&portal_type=household
 */
router.get("/products/:slug", async (req, res) => {
  try {
    const {
      service_location_id,
      location_id,

      ecom_channel,
      portal_type,
    } = req.query;

    const finalLocationId = service_location_id || location_id;
    const finalEcomChannel = ecom_channel || portal_type;

    const params = [req.params.slug];
    const conditions = [`slug = $1`];

    if (finalLocationId) {
      params.push(finalLocationId);
      conditions.push(`service_location_id = $${params.length}`);
    }

    if (finalEcomChannel) {
      if (!["household", "commercial"].includes(finalEcomChannel)) {
        return res.status(400).json({
          success: false,
          message: "ecom_channel must be household or commercial",
        });
      }

      params.push(finalEcomChannel);
      conditions.push(`ecom_channel = $${params.length}`);
    }

    const productResult = await db.query(
      `select *
       from customer_product_listing
       where ${conditions.join(" and ")}
       limit 1`,
      params
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found or not available for selected location",
      });
    }

    const product = productResult.rows[0];

   const imagesResult = await db.query(
  `select
    id,
    image_url,
    storage_bucket,
    storage_path,
    file_name,
    mime_type,
    file_size,
    alt_text,
    is_primary,
    display_order
   from product_images
   where product_id = $1
   and coalesce(is_active, true) = true
   order by is_primary desc, display_order asc, created_at asc`,
  [product.id]
);

    res.json({
      success: true,
      data: {
        ...product,
        images: imagesResult.rows,
      },
    });
  } catch (error) {
    console.error("Customer product detail error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch product details",
    });
  }
});

module.exports = router;