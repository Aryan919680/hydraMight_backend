const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { createSlug } = require('../utils/slug');

const router = express.Router();

router.use(authenticate, authorize('admin', 'operator'));

router.post('/', async (req, res) => {
  try {
    const { name, slug, parent_id, description, image_url, display_order } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Category name is required' });
    }

    const finalSlug = slug || createSlug(name);

    const result = await db.query(
      `insert into categories
       (name, slug, parent_id, description, image_url, display_order)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [name, finalSlug, parent_id || null, description || null, image_url || null, display_order || 0]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ success: false, message: 'Failed to create category' });
  }
});

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `select *
       from categories
       order by display_order asc, name asc`,
      []
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, slug, parent_id, description, image_url, is_active, display_order } = req.body;

    const result = await db.query(
      `update categories
       set name = coalesce($1, name),
           slug = coalesce($2, slug),
           parent_id = $3,
           description = coalesce($4, description),
           image_url = coalesce($5, image_url),
           is_active = coalesce($6, is_active),
           display_order = coalesce($7, display_order),
           updated_at = now()
       where id = $8
       returning *`,
      [name || null, slug || null, parent_id || null, description || null, image_url || null, is_active, display_order, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ success: false, message: 'Failed to update category' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `update categories
       set is_active = false, updated_at = now()
       where id = $1
       returning *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.json({ success: true, message: 'Category deactivated', data: result.rows[0] });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete category' });
  }
});

module.exports = router;
