const express = require("express");
const db = require("../config/db");

const router = express.Router();

/**
 * GET customer products
 * Example:
 * /api/customer/products?portal_type=household&location_id=UUID
 * /api/customer/products?portal_type=commercial&location_id=UUID
 */
router.get("/products", async (req, res) => {
  try {
    const {
      location_id,
      portal_type,
      category_slug,
      search,
      limit = 20,
      offset = 0,
    } = req.query;

    const conditions = [];
    const params = [];

    if (location_id) {
      params.push(location_id);
      conditions.push(`location_id = $${params.length}`);
    }

    if (portal_type) {
      params.push(portal_type);
      conditions.push(`(portal_type = $${params.length} or portal_type = 'both')`);
    }

    if (category_slug) {
      params.push(category_slug);
      conditions.push(`category_slug = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`
        (
          name ilike $${params.length}
          or brand ilike $${params.length}
          or short_description ilike $${params.length}
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
      `
      select
        id,
        name,
        slug,
        short_description,
        description,
        brand,
        unit,
        weight,
        quantity_value,
        quantity_unit,
        portal_type,
        is_featured,
        category_id,
        category_name,
        category_slug,
        mrp,
        selling_price,
        currency,
        available_stock,
        location_id,
        primary_image
      from customer_product_listing
      ${whereClause}
      order by is_featured desc, name asc
      limit ${limitParam} offset ${offsetParam}
      `,
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
      message: "Failed to fetch products",
    });
  }
});

/**
 * GET single product by slug
 * Example:
 * /api/customer/products/floor-cleaner-500ml?location_id=UUID
 */
router.get("/products/:slug", async (req, res) => {
  try {
    const { location_id, portal_type } = req.query;

    const params = [req.params.slug];
    const conditions = [`slug = $1`];

    if (location_id) {
      params.push(location_id);
      conditions.push(`location_id = $${params.length}`);
    }

    if (portal_type) {
      params.push(portal_type);
      conditions.push(`(portal_type = $${params.length} or portal_type = 'both')`);
    }

    const result = await db.query(
      `
      select *
      from customer_product_listing
      where ${conditions.join(" and ")}
      limit 1
      `,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found or not available",
      });
    }

    const product = result.rows[0];

    const imagesResult = await db.query(
      `
      select
        image_url,
        alt_text,
        is_primary,
        display_order
      from product_images
      where product_id = $1
      order by display_order asc
      `,
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
      message: "Failed to fetch product details",
    });
  }
});

/**
 * GET active categories
 */
router.get("/categories", async (req, res) => {
  try {
    const result = await db.query(
      `
      select
        id,
        name,
        slug,
        description,
        image_url,
        display_order
      from categories
      where is_active = true
      order by display_order asc, name asc
      `,
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
 * GET active service locations
 */
router.get("/locations", async (req, res) => {
  try {
    const result = await db.query(
      `
      select
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
      order by name asc
      `,
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

module.exports = router;