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
  `with unique_products as (
    select distinct on (cpl.id)
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

      cpl.primary_image

    from customer_product_listing cpl

    ${whereClause}

    order by
      cpl.id,
      cpl.available_stock desc,
      cpl.is_featured desc
  )

  select
    up.*,

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
        where pi.product_id = up.id
        and coalesce(pi.is_active, true) = true
      ),
      '[]'::json
    ) as images

  from unique_products up

  order by up.is_featured desc, up.name asc

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
 * SEARCH customer products.
 *
 * Examples:
 * /api/customer/products/search?q=floor&service_location_id=uuid&ecom_channel=household
 * /api/customer/products/search?q=detergent&service_location_id=uuid&ecom_channel=household&category_slug=laundry-care
 * /api/customer/products/search?q=cleaner&min_price=100&max_price=500&sort=price_low_to_high
 */
router.get("/products/search", async (req, res) => {
  try {
    const {
      q,
      search,

      service_location_id,
      location_id,

      ecom_channel,
      portal_type,

      category_slug,
      min_price,
      max_price,

      featured,
      in_stock = "true",

      sort = "relevance",

      limit = 20,
      offset = 0,
    } = req.query;
  console.log("Search query:");
    const finalSearch = String(q || search || "").trim();
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

    if (in_stock !== "false") {
      conditions.push(`cpl.available_stock > 0`);
      conditions.push(`cpl.is_out_of_stock = false`);
    }

    if (min_price !== undefined && min_price !== "") {
      params.push(Number(min_price));
      conditions.push(`cpl.selling_price >= $${params.length}`);
    }

    if (max_price !== undefined && max_price !== "") {
      params.push(Number(max_price));
      conditions.push(`cpl.selling_price <= $${params.length}`);
    }

    let relevanceSelect = `0 as relevance_score`;

    if (finalSearch) {
      params.push(`%${finalSearch}%`);
      const likeParam = `$${params.length}`;

      params.push(finalSearch);
      const exactParam = `$${params.length}`;

      conditions.push(`
        (
          cpl.name ilike ${likeParam}
          or cpl.sku ilike ${likeParam}
          or cpl.brand ilike ${likeParam}
          or cpl.category_name ilike ${likeParam}
          or cpl.short_description ilike ${likeParam}
          or cpl.description ilike ${likeParam}
        )
      `);

      relevanceSelect = `
        case
          when lower(cpl.name) = lower(${exactParam}) then 100
          when cpl.name ilike ${likeParam} then 80
          when cpl.sku ilike ${likeParam} then 75
          when cpl.category_name ilike ${likeParam} then 60
          when cpl.brand ilike ${likeParam} then 50
          when cpl.short_description ilike ${likeParam} then 40
          when cpl.description ilike ${likeParam} then 30
          else 0
        end as relevance_score
      `;
    }

    const safeLimit = Math.min(Number(limit) || 20, 50);
    const safeOffset = Number(offset) || 0;

    params.push(safeLimit);
    const limitParam = `$${params.length}`;

    params.push(safeOffset);
    const offsetParam = `$${params.length}`;

    const whereClause = conditions.length
      ? `where ${conditions.join(" and ")}`
      : "";

    let orderBy = `relevance_score desc, up.is_featured desc, up.name asc`;

    if (sort === "price_low_to_high") {
      orderBy = `up.selling_price asc nulls last, up.name asc`;
    }

    if (sort === "price_high_to_low") {
      orderBy = `up.selling_price desc nulls last, up.name asc`;
    }

    if (sort === "newest") {
      orderBy = `up.name asc`;
    }

    if (sort === "stock_high_to_low") {
      orderBy = `up.available_stock desc, up.name asc`;
    }

    const result = await db.query(
      `with unique_products as (
        select distinct on (cpl.id)
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

          ${relevanceSelect}

        from customer_product_listing cpl

        ${whereClause}

        order by
          cpl.id,
          cpl.available_stock desc,
          cpl.is_featured desc
      ),

      total_count as (
        select count(*)::int as total
        from unique_products
      )

      select
        up.*,

        tc.total,

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
            where pi.product_id = up.id
            and coalesce(pi.is_active, true) = true
          ),
          '[]'::json
        ) as images

      from unique_products up
      cross join total_count tc

      order by ${orderBy}

      limit ${limitParam}
      offset ${offsetParam}`,
      params
    );

    const total = result.rows.length > 0 ? Number(result.rows[0].total || 0) : 0;

    const data = result.rows.map((row) => {
      const { total, ...product } = row;
      return product;
    });

    res.json({
      success: true,
      query: finalSearch,
      filters: {
        service_location_id: finalLocationId || null,
        ecom_channel: finalEcomChannel || null,
        category_slug: category_slug || null,
        min_price: min_price || null,
        max_price: max_price || null,
        in_stock,
        sort,
      },
      pagination: {
        total,
        limit: safeLimit,
        offset: safeOffset,
        has_more: safeOffset + safeLimit < total,
      },
      data,
    });
  } catch (error) {
    console.error("Customer product search error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to search products",
    });
  }
});


/**
 * GET product search suggestions / autocomplete.
 *
 * Example:
 * /api/customer/products/suggestions?q=f&service_location_id=uuid&ecom_channel=household
 */
router.get("/products/suggestions", async (req, res) => {
  try {
    const {
      q,
      search,

      service_location_id,
      location_id,

      ecom_channel,
      portal_type,

      limit = 10,
    } = req.query;

    const finalSearch = String(q || search || "").trim();
    const finalLocationId = service_location_id || location_id;
    const finalEcomChannel = ecom_channel || portal_type;

    if (!finalSearch) {
      return res.json({
        success: true,
        query: "",
        data: [],
      });
    }

    if (!finalLocationId) {
      return res.status(400).json({
        success: false,
        message: "service_location_id is required",
      });
    }

    if (!finalEcomChannel || !["household", "commercial"].includes(finalEcomChannel)) {
      return res.status(400).json({
        success: false,
        message: "ecom_channel must be household or commercial",
      });
    }

    const safeLimit = Math.min(Number(limit) || 10, 15);

    const productResult = await db.query(
      `with matched_products as (
        select distinct on (cpl.id)
          'product' as type,

          cpl.id,
          cpl.name,
          cpl.slug,
          cpl.sku,

          cpl.category_id,
          cpl.category_name,
          cpl.category_slug,

          cpl.brand,
          cpl.ecom_channel,

          cpl.mrp,
          cpl.selling_price,
          cpl.currency,

          cpl.primary_image,
          cpl.available_stock,

          case
            when lower(cpl.name) = lower($1) then 100
            when cpl.name ilike $2 then 90
            when cpl.sku ilike $2 then 80
            when cpl.category_name ilike $2 then 70
            when cpl.brand ilike $2 then 60
            when cpl.short_description ilike $2 then 50
            when cpl.description ilike $2 then 40
            else 0
          end as relevance_score

        from customer_product_listing cpl

        where cpl.service_location_id = $3
        and cpl.ecom_channel = $4
        and cpl.available_stock > 0
        and cpl.is_out_of_stock = false
        and (
          cpl.name ilike $2
          or cpl.sku ilike $2
          or cpl.category_name ilike $2
          or cpl.brand ilike $2
          or cpl.short_description ilike $2
          or cpl.description ilike $2
        )

        order by
          cpl.id,
          cpl.available_stock desc,
          cpl.is_featured desc
      )

      select *
      from matched_products
      order by
        relevance_score desc,
        name asc
      limit $5`,
      [
        finalSearch,
        `%${finalSearch}%`,
        finalLocationId,
        finalEcomChannel,
        safeLimit,
      ]
    );

    const categoryResult = await db.query(
      `select distinct
        'category' as type,
        null::uuid as id,
        cpl.category_name as name,
        null::text as slug,
        null::text as sku,

        cpl.category_id,
        cpl.category_name,
        cpl.category_slug,

        null::text as brand,
        cpl.ecom_channel,

        null::numeric as mrp,
        null::numeric as selling_price,
        null::text as currency,

        null::text as primary_image,
        null::int as available_stock,

        case
          when lower(cpl.category_name) = lower($1) then 100
          when cpl.category_name ilike $2 then 85
          else 0
        end as relevance_score

       from customer_product_listing cpl

       where cpl.service_location_id = $3
       and cpl.ecom_channel = $4
       and cpl.available_stock > 0
       and cpl.is_out_of_stock = false
       and cpl.category_name ilike $2

       order by relevance_score desc, cpl.category_name asc

       limit 5`,
      [
        finalSearch,
        `%${finalSearch}%`,
        finalLocationId,
        finalEcomChannel,
      ]
    );

    const merged = [...productResult.rows, ...categoryResult.rows]
      .sort((a, b) => {
        const scoreDiff = Number(b.relevance_score || 0) - Number(a.relevance_score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return String(a.name || "").localeCompare(String(b.name || ""));
      })
      .slice(0, safeLimit);

    res.json({
      success: true,
      query: finalSearch,
      data: merged,
    });
  } catch (error) {
    console.error("Customer product suggestions error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch product suggestions",
    });
  }
});

/**
 * GET product detail by id.
 *
 * Example:
 * /api/customer/products/id/PRODUCT_UUID?service_location_id=uuid&ecom_channel=household
 */
router.get("/products/id/:id", async (req, res) => {
  try {
    const {
      service_location_id,
      location_id,

      ecom_channel,
      portal_type,
    } = req.query;

    const finalLocationId = service_location_id || location_id;
    const finalEcomChannel = ecom_channel || portal_type;

    const params = [req.params.id];
    const conditions = [`id = $1`];

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
      `select distinct on (id)
        *
       from customer_product_listing
       where ${conditions.join(" and ")}
       order by id, available_stock desc
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
    console.error("Customer product detail by id error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch product details",
    });
  }
});


/**
 * GET product recommendations from same category.
 *
 * Example:
 * /api/customer/products/:slug/recommendations?service_location_id=uuid&ecom_channel=household
 */
router.get("/products/:slug/recommendations", async (req, res) => {
  try {
    const {
      service_location_id,
      location_id,
      ecom_channel,
      portal_type,
      limit = 8,
    } = req.query;

    const finalLocationId = service_location_id || location_id;
    const finalEcomChannel = ecom_channel || portal_type;

    if (!finalLocationId) {
      return res.status(400).json({
        success: false,
        message: "service_location_id is required",
      });
    }

    if (!finalEcomChannel || !["household", "commercial"].includes(finalEcomChannel)) {
      return res.status(400).json({
        success: false,
        message: "ecom_channel must be household or commercial",
      });
    }

    /**
     * First find selected product in same customer-available listing.
     * This ensures selected product is valid for this location/channel.
     */
const selectedProductResult = await db.query(
  `select distinct on (id)
    id,
    slug,
    category_id,
    category_slug,
    ecom_channel,
    service_location_id
   from customer_product_listing
   where slug = $1
   and service_location_id = $2
   and ecom_channel = $3
   order by id, available_stock desc
   limit 1`,
  [req.params.slug, finalLocationId, finalEcomChannel]
);

    if (selectedProductResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Selected product not found or not available for selected location",
      });
    }

    const selectedProduct = selectedProductResult.rows[0];

    const maxLimit = Math.min(Number(limit) || 8, 20);

const result = await db.query(
  `with unique_recommendations as (
    select distinct on (cpl.id)
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

      cpl.primary_image

    from customer_product_listing cpl

    where cpl.category_id = $1
    and cpl.id <> $2
    and cpl.service_location_id = $3
    and cpl.ecom_channel = $4
    and cpl.available_stock > 0
    and cpl.is_out_of_stock = false

    order by
      cpl.id,
      cpl.available_stock desc,
      cpl.is_featured desc,
      cpl.name asc
  )

  select
    ur.*,

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
        where pi.product_id = ur.id
        and coalesce(pi.is_active, true) = true
      ),
      '[]'::json
    ) as images

  from unique_recommendations ur

  order by
    ur.is_featured desc,
    ur.available_stock desc,
    ur.name asc

  limit $5`,
  [
    selectedProduct.category_id,
    selectedProduct.id,
    finalLocationId,
    finalEcomChannel,
    maxLimit,
  ]
);
    res.json({
      success: true,
      selected_product: {
        id: selectedProduct.id,
        slug: selectedProduct.slug,
        category_id: selectedProduct.category_id,
        category_slug: selectedProduct.category_slug,
        ecom_channel: selectedProduct.ecom_channel,
        service_location_id: selectedProduct.service_location_id,
      },
      data: result.rows,
    });
  } catch (error) {
    console.error("Customer recommendations error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch product recommendations",
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