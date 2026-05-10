const express = require('express');
const db = require('../config/db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const {
      location_id,
      category_slug,
      search,
      featured
    } = req.query;

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const conditions = [];
    const params = [];

    if (location_id) {
      params.push(location_id);
      conditions.push(`location_id = $${params.length}`);
    }

    if (category_slug) {
      params.push(category_slug);
      conditions.push(`category_slug = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(name ilike $${params.length} or brand ilike $${params.length} or description ilike $${params.length})`);
    }

    if (featured === 'true') {
      conditions.push(`is_featured = true`);
    }

    params.push(limit);
    const limitParam = `$${params.length}`;

    params.push(offset);
    const offsetParam = `$${params.length}`;

    const whereClause = conditions.length ? `where ${conditions.join(' and ')}` : '';

    const sql = `
      select *
      from customer_product_listing
      ${whereClause}
      order by is_featured desc, name asc
      limit ${limitParam} offset ${offsetParam}
    `;

    const result = await db.query(sql, params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Customer product listing error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch products' });
  }
});

router.get('/categories', async (req, res) => {
  try {
    const result = await db.query(
      `select id, name, slug, image_url, description
       from categories
       where is_active = true
       order by display_order asc, name asc`,
      []
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Customer categories error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
});

router.get('/:slug', async (req, res) => {
  try {
    const { location_id } = req.query;

    const params = [req.params.slug];
    let locationCondition = '';

    if (location_id) {
      params.push(location_id);
      locationCondition = `and location_id = $2`;
    }

    const productResult = await db.query(
      `select *
       from customer_product_listing
       where slug = $1
       ${locationCondition}
       limit 1`,
      params
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found or not available' });
    }

    const imagesResult = await db.query(
      `select image_url, alt_text, is_primary, display_order
       from product_images
       where product_id = $1
       order by display_order asc`,
      [productResult.rows[0].id]
    );

    res.json({
      success: true,
      data: {
        ...productResult.rows[0],
        images: imagesResult.rows
      }
    });
  } catch (error) {
    console.error('Customer product detail error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch product details' });
  }
});

module.exports = router;
