const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticate, authorize('admin', 'operator'));

// GET all locations
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `select *
       from service_locations
       order by created_at desc`,
      []
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch locations' });
  }
});

// GET single location
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `select *
       from service_locations
       where id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Location not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get location error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch location' });
  }
});

// CREATE location
router.post('/', async (req, res) => {
  try {
    const {
      name,
      city,
      state,
      pincode,
      latitude,
      longitude,
      radius_km,
      is_active
    } = req.body;

    if (!name || !city || !state || !pincode) {
      return res.status(400).json({
        success: false,
        message: 'name, city, state and pincode are required'
      });
    }

    const result = await db.query(
      `insert into service_locations
       (
        name,
        city,
        state,
        pincode,
        latitude,
        longitude,
        radius_km,
        is_active
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [
        name,
        city,
        state,
        pincode,
        latitude || null,
        longitude || null,
        radius_km || null,
        is_active !== undefined ? is_active : true
      ]
    );

    await db.query(
      `insert into audit_logs
       (user_id, action, module, record_id, new_data)
       values ($1,'CREATE','LOCATION',$2,$3)`,
      [req.user.id, result.rows[0].id, result.rows[0]]
    );

    res.status(201).json({
      success: true,
      message: 'Location created successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Create location error:', error);
    res.status(500).json({ success: false, message: 'Failed to create location' });
  }
});

// UPDATE location
router.put('/:id', async (req, res) => {
  try {
    const oldResult = await db.query(
      `select *
       from service_locations
       where id = $1`,
      [req.params.id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Location not found' });
    }

    const {
      name,
      city,
      state,
      pincode,
      latitude,
      longitude,
      radius_km,
      is_active
    } = req.body;

    const result = await db.query(
      `update service_locations
       set name = coalesce($1, name),
           city = coalesce($2, city),
           state = coalesce($3, state),
           pincode = coalesce($4, pincode),
           latitude = coalesce($5, latitude),
           longitude = coalesce($6, longitude),
           radius_km = coalesce($7, radius_km),
           is_active = coalesce($8, is_active)
       where id = $9
       returning *`,
      [
        name || null,
        city || null,
        state || null,
        pincode || null,
        latitude ?? null,
        longitude ?? null,
        radius_km ?? null,
        is_active,
        req.params.id
      ]
    );

    await db.query(
      `insert into audit_logs
       (user_id, action, module, record_id, old_data, new_data)
       values ($1,'UPDATE','LOCATION',$2,$3,$4)`,
      [req.user.id, req.params.id, oldResult.rows[0], result.rows[0]]
    );

    res.json({
      success: true,
      message: 'Location updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ success: false, message: 'Failed to update location' });
  }
});

// DELETE / deactivate location
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `update service_locations
       set is_active = false
       where id = $1
       returning *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Location not found' });
    }

    await db.query(
      `insert into audit_logs
       (user_id, action, module, record_id, new_data)
       values ($1,'DEACTIVATE','LOCATION',$2,$3)`,
      [req.user.id, req.params.id, result.rows[0]]
    );

    res.json({
      success: true,
      message: 'Location deactivated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Delete location error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete location' });
  }
});

module.exports = router;