const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticate, authorize('admin', 'operator'));

// Get inventory for all products
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `select
        i.id,
        i.product_id,
        p.name as product_name,
        p.sku,
        i.location_id,
        sl.name as location_name,
        i.available_stock,
        i.reserved_stock,
        i.min_stock_level,
        i.is_out_of_stock,
        i.is_active,
        i.updated_at
       from inventory i
       join products p on p.id = i.product_id
       left join service_locations sl on sl.id = i.location_id
       where i.is_active = true
       order by i.updated_at desc`,
      []
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get inventory error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inventory' });
  }
});

// Get inventory by product
router.get('/product/:productId', async (req, res) => {
  try {
    const result = await db.query(
      `select
        i.*,
        p.name as product_name,
        p.sku,
        sl.name as location_name
       from inventory i
       join products p on p.id = i.product_id
       left join service_locations sl on sl.id = i.location_id
       where i.product_id = $1
       and i.is_active = true
       order by i.updated_at desc`,
      [req.params.productId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get product inventory error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch product inventory' });
  }
});

// Add / upsert inventory for product + location
router.post('/', async (req, res) => {
  try {
    const {
      product_id,
      location_id,
      available_stock,
      reserved_stock,
      min_stock_level,
      remarks
    } = req.body;

    if (!product_id || !location_id || available_stock === undefined) {
      return res.status(400).json({
        success: false,
        message: 'product_id, location_id and available_stock are required'
      });
    }

    const stock = Number(available_stock);
    const reserved = Number(reserved_stock || 0);
    const minStock = Number(min_stock_level || 0);

    if (stock < 0 || reserved < 0 || minStock < 0) {
      return res.status(400).json({
        success: false,
        message: 'Stock values cannot be negative'
      });
    }

    const result = await db.query(
      `insert into inventory
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
      [
        product_id,
        location_id,
        stock,
        reserved,
        minStock,
        stock <= 0
      ]
    );

    await db.query(
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
       values ($1,$2,'stock_in',$3,'manual',$4,$5)`,
      [
        product_id,
        location_id,
        stock,
        remarks || 'Inventory added/updated by admin',
        req.user.id
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Inventory saved successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Add inventory error:', error);
    res.status(500).json({ success: false, message: 'Failed to save inventory' });
  }
});

// Update inventory by inventory id
router.put('/:id', async (req, res) => {
  try {
    const {
      available_stock,
      reserved_stock,
      min_stock_level,
      remarks
    } = req.body;

    const currentResult = await db.query(
      `select *
       from inventory
       where id = $1
       and is_active = true`,
      [req.params.id]
    );

    if (currentResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventory not found' });
    }

    const current = currentResult.rows[0];

    const nextAvailable =
      available_stock !== undefined ? Number(available_stock) : Number(current.available_stock);

    const nextReserved =
      reserved_stock !== undefined ? Number(reserved_stock) : Number(current.reserved_stock);

    const nextMin =
      min_stock_level !== undefined ? Number(min_stock_level) : Number(current.min_stock_level);

    if (nextAvailable < 0 || nextReserved < 0 || nextMin < 0) {
      return res.status(400).json({
        success: false,
        message: 'Stock values cannot be negative'
      });
    }

    const result = await db.query(
      `update inventory
       set available_stock = $1,
           reserved_stock = $2,
           min_stock_level = $3,
           is_out_of_stock = $4,
           updated_at = now()
       where id = $5
       returning *`,
      [
        nextAvailable,
        nextReserved,
        nextMin,
        nextAvailable <= 0,
        req.params.id
      ]
    );

    const diff = nextAvailable - Number(current.available_stock);

if (diff !== 0) {
  await db.query(
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
      diff > 0 ? 'stock_in' : 'stock_out',
      Math.abs(diff),
      remarks || 'Inventory updated by admin',
      req.user.id
    ]
  );
} else if (remarks) {
  await db.query(
    `insert into audit_logs
     (
      user_id,
      action,
      module,
      record_id,
      old_data,
      new_data
     )
     values ($1,'UPDATE','INVENTORY',$2,$3,$4)`,
    [
      req.user.id,
      req.params.id,
      current,
      result.rows[0]
    ]
  );
}

    res.json({
      success: true,
      message: 'Inventory updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Update inventory error:', error);
    res.status(500).json({ success: false, message: 'Failed to update inventory' });
  }
});

// Delete/deactivate inventory
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `update inventory
       set is_active = false,
           available_stock = 0,
           reserved_stock = 0,
           is_out_of_stock = true,
           updated_at = now()
       where id = $1
       returning *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventory not found' });
    }

    await db.query(
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
       values ($1,$2,'adjustment',1,'manual','Inventory deactivated by admin',$3)`,
      [
        result.rows[0].product_id,
        result.rows[0].location_id,
        req.user.id
      ]
    );

    res.json({
      success: true,
      message: 'Inventory deleted successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Delete inventory error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete inventory' });
  }
});

// Inventory transaction history
router.get('/:id/transactions', async (req, res) => {
  try {
    const invResult = await db.query(
      `select product_id, location_id
       from inventory
       where id = $1`,
      [req.params.id]
    );

    if (invResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventory not found' });
    }

    const inv = invResult.rows[0];

    const result = await db.query(
      `select
        it.*,
        up.full_name as created_by_name
       from inventory_transactions it
       left join user_profiles up on up.id = it.created_by
       where it.product_id = $1
       and it.location_id = $2
       order by it.created_at desc`,
      [inv.product_id, inv.location_id]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Inventory transaction history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inventory history' });
  }
});

module.exports = router;