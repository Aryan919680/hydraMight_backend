const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { createSlug } = require('../utils/slug');
const { uploadProductImage } = require('../middleware/upload.middleware');
const router = express.Router();

router.use(authenticate, authorize('admin', 'operator'));

/**
 * Create product in one transaction:
 * 1. products
 * 2. product_images
 * 3. product_prices
 * 4. inventory
 */
router.post('/', async (req, res) => {
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
      unit,
      weight,
      is_featured,
      images,
      location_id,
      mrp,
      selling_price,
      currency,
      available_stock,
      min_stock_level
    } = req.body;

    if (!category_id || !name || !location_id || mrp === undefined || selling_price === undefined) {
      return res.status(400).json({
        success: false,
        message: 'category_id, name, location_id, mrp and selling_price are required'
      });
    }

    await client.query('BEGIN');

    const productResult = await client.query(
      `insert into products
       (category_id, name, slug, sku, short_description, description, brand, unit, weight, is_featured, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning *`,
      [
        category_id,
        name,
        slug || createSlug(name),
        sku || null,
        short_description || null,
        description || null,
        brand || null,
        unit || null,
        weight || null,
        Boolean(is_featured),
        req.user.id
      ]
    );

    const product = productResult.rows[0];

    if (Array.isArray(images) && images.length > 0) {
      for (let index = 0; index < images.length; index++) {
        const img = images[index];

        await client.query(
          `insert into product_images
           (product_id, image_url, alt_text, is_primary, display_order)
           values ($1,$2,$3,$4,$5)`,
          [
            product.id,
            img.image_url,
            img.alt_text || null,
            index === 0 ? true : Boolean(img.is_primary),
            img.display_order || index
          ]
        );
      }
    }

    await client.query(
      `insert into product_prices
       (product_id, location_id, mrp, selling_price, currency, is_active)
       values ($1,$2,$3,$4,$5,true)`,
      [product.id, location_id, mrp, selling_price, currency || 'INR']
    );

    await client.query(
      `insert into inventory
       (product_id, location_id, available_stock, reserved_stock, min_stock_level, is_out_of_stock)
       values ($1,$2,$3,0,$4,$5)`,
      [
        product.id,
        location_id,
        available_stock || 0,
        min_stock_level || 0,
        Number(available_stock || 0) <= 0
      ]
    );

    await client.query(
      `insert into audit_logs
       (user_id, action, module, record_id, new_data)
       values ($1,'CREATE','PRODUCT',$2,$3)`,
      [req.user.id, product.id, product]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create product error:', error);
    res.status(500).json({ success: false, message: 'Failed to create product' });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const result = await db.query(
      `select *
       from admin_product_listing
       order by created_at desc
       limit $1 offset $2`,
      [limit, offset]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get admin products error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch products' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const productResult = await db.query(
      `select *
       from products
       where id = $1`,
      [req.params.id]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const imagesResult = await db.query(
      `select *
       from product_images
       where product_id = $1
       order by display_order asc`,
      [req.params.id]
    );

    const priceResult = await db.query(
      `select *
       from product_prices
       where product_id = $1
       order by created_at desc`,
      [req.params.id]
    );

    const inventoryResult = await db.query(
      `select *
       from inventory
       where product_id = $1`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: {
        ...productResult.rows[0],
        images: imagesResult.rows,
        prices: priceResult.rows,
        inventory: inventoryResult.rows
      }
    });
  } catch (error) {
    console.error('Get admin product detail error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch product details' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const {
      category_id,
      name,
      slug,
      sku,
      short_description,
      description,
      brand,
      unit,
      weight,
      is_active,
      is_featured
    } = req.body;

    const result = await db.query(
      `update products
       set category_id = coalesce($1, category_id),
           name = coalesce($2, name),
           slug = coalesce($3, slug),
           sku = coalesce($4, sku),
           short_description = coalesce($5, short_description),
           description = coalesce($6, description),
           brand = coalesce($7, brand),
           unit = coalesce($8, unit),
           weight = coalesce($9, weight),
           is_active = coalesce($10, is_active),
           is_featured = coalesce($11, is_featured),
           updated_at = now()
       where id = $12
       returning *`,
      [
        category_id || null,
        name || null,
        slug || null,
        sku || null,
        short_description || null,
        description || null,
        brand || null,
        unit || null,
        weight || null,
        is_active,
        is_featured,
        req.params.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    await db.query(
      `insert into audit_logs
       (user_id, action, module, record_id, new_data)
       values ($1,'UPDATE','PRODUCT',$2,$3)`,
      [req.user.id, req.params.id, result.rows[0]]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ success: false, message: 'Failed to update product' });
  }
});

router.put('/:id/price', async (req, res) => {
  try {
    const { location_id, mrp, selling_price, currency } = req.body;

    if (!location_id || mrp === undefined || selling_price === undefined) {
      return res.status(400).json({ success: false, message: 'location_id, mrp and selling_price are required' });
    }

    await db.query(
      `update product_prices
       set is_active = false,
           effective_to = now()
       where product_id = $1
       and location_id = $2
       and is_active = true`,
      [req.params.id, location_id]
    );

    const result = await db.query(
      `insert into product_prices
       (product_id, location_id, mrp, selling_price, currency, is_active)
       values ($1,$2,$3,$4,$5,true)
       returning *`,
      [req.params.id, location_id, mrp, selling_price, currency || 'INR']
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update price error:', error);
    res.status(500).json({ success: false, message: 'Failed to update product price' });
  }
});

router.put('/:id/inventory', async (req, res) => {
  try {
    const { location_id, available_stock, min_stock_level } = req.body;

    if (!location_id || available_stock === undefined) {
      return res.status(400).json({ success: false, message: 'location_id and available_stock are required' });
    }

    const result = await db.query(
      `insert into inventory
       (product_id, location_id, available_stock, reserved_stock, min_stock_level, is_out_of_stock)
       values ($1,$2,$3,0,$4,$5)
       on conflict (product_id, location_id)
       do update set
         available_stock = excluded.available_stock,
         min_stock_level = excluded.min_stock_level,
         is_out_of_stock = excluded.is_out_of_stock,
         updated_at = now()
       returning *`,
      [
        req.params.id,
        location_id,
        available_stock,
        min_stock_level || 0,
        Number(available_stock) <= 0
      ]
    );

    await db.query(
      `insert into inventory_transactions
       (product_id, location_id, transaction_type, quantity, reference_type, remarks, created_by)
       values ($1,$2,'adjustment',$3,'manual','Admin inventory update',$4)`,
      [req.params.id, location_id, Math.abs(Number(available_stock)), req.user.id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update inventory error:', error);
    res.status(500).json({ success: false, message: 'Failed to update inventory' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `update products
       set is_active = false, updated_at = now()
       where id = $1
       returning *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    await db.query(
      `insert into audit_logs
       (user_id, action, module, record_id, new_data)
       values ($1,'DEACTIVATE','PRODUCT',$2,$3)`,
      [req.user.id, req.params.id, result.rows[0]]
    );

    res.json({ success: true, message: 'Product deactivated', data: result.rows[0] });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete product' });
  }
});


router.post(
  '/upload-image',
  uploadProductImage.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'Image file is required'
        });
      }

      const imageUrl = `${req.protocol}://${req.get('host')}/uploads/products/${req.file.filename}`;

      res.status(201).json({
        success: true,
        image_url: imageUrl
      });
    } catch (error) {
      console.error('Upload product image error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to upload product image'
      });
    }
  }
);

module.exports = router;
