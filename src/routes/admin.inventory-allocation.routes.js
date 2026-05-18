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

const normalizeCode = (value) =>
  clean(value).toLowerCase().replace(/\s+/g, "_");

const normalizeSku = (sku) => clean(sku).toUpperCase();

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const getStatus = (availableStock, minStock) => ({
  is_out_of_stock: availableStock <= 0,
  is_low_stock: availableStock > 0 && availableStock <= minStock,
});

async function getChannel(client, code) {
  const channelCode = normalizeCode(code);

  const result = await client.query(
    `select *
     from inventory_channels
     where code = $1
     and is_active = true
     limit 1`,
    [channelCode]
  );

  if (result.rows.length === 0) {
    throw new Error(`Invalid channel: ${code}`);
  }

  return result.rows[0];
}

async function getSubChannel(client, channelId, code) {
  if (!code) return null;

  const subCode = normalizeCode(code);

  const result = await client.query(
    `select *
     from inventory_sub_channels
     where channel_id = $1
     and code = $2
     and is_active = true
     limit 1`,
    [channelId, subCode]
  );

  if (result.rows.length === 0) {
    throw new Error(`Invalid sub_channel: ${code}`);
  }

  return result.rows[0];
}

async function findMainInventoryBySku(client, sku) {
  const finalSku = normalizeSku(sku);

  const result = await client.query(
    `select *
     from main_inventory
     where sku = $1
     and is_active = true
     limit 1`,
    [finalSku]
  );

  if (result.rows.length === 0) {
    throw new Error(`Main inventory not found for SKU ${finalSku}`);
  }

  return result.rows[0];
}

async function findOrCreateLocation(client, payload) {
  const {
    channel,
    subChannel,
    service_location_id,
    location_code,
    location_name,
    city,
    state,
    pincode,
    location_type,
  } = payload;

  /**
   * ECOM:
   * location must come from service_locations
   */
  console.log("payload for location:", payload);
  if (channel.code === "ecom") {
    if (!service_location_id) {
      throw new Error("service_location_id is required for ecom inventory allocation");
    }

    const serviceLocationResult = await client.query(
      `select *
       from service_locations
       where id = $1
       and is_active = true
       limit 1`,
      [service_location_id]
    );

    if (serviceLocationResult.rows.length === 0) {
      throw new Error("Active service location not found");
    }

    const sl = serviceLocationResult.rows[0];

    const existing = await client.query(
      `select *
       from inventory_locations
       where channel_id = $1
       and sub_channel_id = $2
       and service_location_id = $3
       limit 1`,
      [channel.id, subChannel ? subChannel.id : null, service_location_id]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const result = await client.query(
      `insert into inventory_locations
       (
        channel_id,
        sub_channel_id,
        service_location_id,
        name,
        code,
        city,
        state,
        pincode,
        location_type,
        is_active,
        created_at,
        updated_at
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8,'service_area',true,now(),now())
       returning *`,
      [
        channel.id,
        subChannel ? subChannel.id : null,
        service_location_id,
        sl.name,
        sl.code || sl.pincode || service_location_id,
        sl.city,
        sl.state,
        sl.pincode,
      ]
    );

    return result.rows[0];
  }

  /**
   * DISTRIBUTION / WHITE LABEL:
   * use inventory_locations custom location
   */
  if (!location_code && !location_name) {
    throw new Error("location_code or location_name is required");
  }

  const finalCode = normalizeCode(location_code || location_name);
  const finalName = clean(location_name || location_code);

  const existing = await client.query(
    `select *
     from inventory_locations
     where channel_id = $1
     and coalesce(sub_channel_id::text, '') = coalesce($2::text, '')
     and code = $3
     limit 1`,
    [channel.id, subChannel ? subChannel.id : null, finalCode]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const result = await client.query(
    `insert into inventory_locations
     (
      channel_id,
      sub_channel_id,
      name,
      code,
      city,
      state,
      pincode,
      location_type,
      is_active,
      created_at,
      updated_at
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,true,now(),now())
     returning *`,
    [
      channel.id,
      subChannel ? subChannel.id : null,
      finalName,
      finalCode,
      clean(city) || null,
      clean(state) || null,
      clean(pincode) || null,
      clean(location_type) || "warehouse",
    ]
  );

  return result.rows[0];
}

async function insertAllocationTransaction(client, payload) {
  await client.query(
    `insert into inventory_allocation_transactions
     (
      allocation_id,
      main_inventory_id,
      sku,
      channel_id,
      sub_channel_id,
      location_id,
      transaction_type,
      quantity,
      old_allocated_stock,
      new_allocated_stock,
      old_reserved_stock,
      new_reserved_stock,
      old_available_stock,
      new_available_stock,
      remarks,
      created_by
     )
     values
     ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      payload.allocation_id,
      payload.main_inventory_id,
      payload.sku,
      payload.channel_id,
      payload.sub_channel_id || null,
      payload.location_id,
      payload.transaction_type,
      payload.quantity,
      payload.old_allocated_stock,
      payload.new_allocated_stock,
      payload.old_reserved_stock,
      payload.new_reserved_stock,
      payload.old_available_stock,
      payload.new_available_stock,
      payload.remarks || null,
      payload.created_by,
    ]
  );
}

async function upsertAllocation(client, row, userId, transactionType = "allocate") {
  const sku = normalizeSku(row.sku);
  const channelCode = clean(row.channel);
  const subChannelCode = clean(row.sub_channel);

  if (!sku) throw new Error("sku is required");
  if (!channelCode) throw new Error("channel is required");

  const channel = await getChannel(client, channelCode);

  let subChannel = null;

  if (channel.code === "ecom") {
    if (!subChannelCode) {
      throw new Error("sub_channel is required for ecom channel");
    }

    subChannel = await getSubChannel(client, channel.id, subChannelCode);

    if (!["household", "commercial"].includes(subChannel.code)) {
      throw new Error("ecom sub_channel must be household or commercial");
    }
  } else {
    if (subChannelCode) {
      subChannel = await getSubChannel(client, channel.id, subChannelCode);
    }
  }

  const mainInventory = await findMainInventoryBySku(client, sku);

const location = await findOrCreateLocation(client, {
  channel,
  subChannel,

  // important for ecom
  service_location_id: row.service_location_id,

  // used for distribution / white label
  location_code: row.location_code,
  location_name: row.location_name,
  city: row.city,
  state: row.state,
  pincode: row.pincode,

  location_type:
    row.location_type ||
    (channel.code === "distribution"
      ? "distributor"
      : channel.code === "white_label"
        ? "partner"
        : "service_area"),
});

  const allocatedStock = toNumber(row.allocated_stock ?? row.quantity, 0);
  const reservedStock = toNumber(row.reserved_stock, 0);
  const minStock = toNumber(row.min_stock_level, 0);

  if (allocatedStock < 0 || reservedStock < 0 || minStock < 0) {
    throw new Error(`Stock values cannot be negative for SKU ${sku}`);
  }

  if (reservedStock > allocatedStock) {
    throw new Error(`reserved_stock cannot be greater than allocated_stock for SKU ${sku}`);
  }

  const existingResult = await client.query(
    `select *
     from inventory_allocations
     where main_inventory_id = $1
     and channel_id = $2
     and coalesce(sub_channel_id::text, '') = coalesce($3::text, '')
     and location_id = $4
     limit 1`,
    [
      mainInventory.id,
      channel.id,
      subChannel ? subChannel.id : null,
      location.id,
    ]
  );

  const existing = existingResult.rows[0];

  const oldAllocated = existing ? Number(existing.allocated_stock || 0) : 0;
  const oldReserved = existing ? Number(existing.reserved_stock || 0) : 0;
  const oldAvailable = existing ? Number(existing.available_stock || 0) : 0;

  const deltaAllocated = allocatedStock - oldAllocated;

  const mainAvailableBefore = Number(mainInventory.available_stock || 0);

  if (deltaAllocated > mainAvailableBefore) {
    throw new Error(
      `Insufficient main inventory for SKU ${sku}. Available: ${mainAvailableBefore}, Required extra: ${deltaAllocated}`
    );
  }

  const nextAvailable = allocatedStock - reservedStock;
  const status = getStatus(nextAvailable, minStock);

  const result = await client.query(
    `insert into inventory_allocations
     (
      main_inventory_id,
      sku,
      channel_id,
      sub_channel_id,
      location_id,
      allocated_stock,
      reserved_stock,
      min_stock_level,
      is_out_of_stock,
      is_low_stock,
      is_active,
      remarks,
      created_by,
      updated_by,
      created_at,
      updated_at
     )
     values
     ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$12,now(),now())
     on conflict (main_inventory_id, channel_id, sub_channel_id, location_id)
     do update set
      allocated_stock = excluded.allocated_stock,
      reserved_stock = excluded.reserved_stock,
      min_stock_level = excluded.min_stock_level,
      is_out_of_stock = excluded.is_out_of_stock,
      is_low_stock = excluded.is_low_stock,
      is_active = true,
      remarks = excluded.remarks,
      updated_by = excluded.updated_by,
      updated_at = now()
     returning *`,
    [
      mainInventory.id,
      sku,
      channel.id,
      subChannel ? subChannel.id : null,
      location.id,
      allocatedStock,
      reservedStock,
      minStock,
      status.is_out_of_stock,
      status.is_low_stock,
      clean(row.remarks) || "Inventory allocated",
      userId,
    ]
  );

  const allocation = result.rows[0];

  const quantityChanged =
    Math.abs(allocatedStock - oldAllocated) +
    Math.abs(reservedStock - oldReserved);

  if (quantityChanged > 0) {
    await insertAllocationTransaction(client, {
      allocation_id: allocation.id,
      main_inventory_id: mainInventory.id,
      sku,
      channel_id: channel.id,
      sub_channel_id: subChannel ? subChannel.id : null,
      location_id: location.id,
      transaction_type: transactionType,
      quantity: quantityChanged,
      old_allocated_stock: oldAllocated,
      new_allocated_stock: Number(allocation.allocated_stock),
      old_reserved_stock: oldReserved,
      new_reserved_stock: Number(allocation.reserved_stock),
      old_available_stock: oldAvailable,
      new_available_stock: Number(allocation.available_stock),
      remarks: clean(row.remarks) || "Inventory allocation changed",
      created_by: userId,
    });
  }

  await client.query(`select sync_main_inventory_allocated_stock($1)`, [
    mainInventory.id,
  ]);

  return allocation;
}

/**
 * GET channels
 */
router.get("/channels", async (req, res) => {
  try {
    const result = await db.query(
      `select *
       from inventory_channels
       where is_active = true
       order by name asc`,
      []
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get inventory channels error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch channels",
    });
  }
});

/**
 * GET sub channels
 * /api/admin/inventory-allocations/sub-channels?channel=ecom
 */
router.get("/sub-channels", async (req, res) => {
  try {
    const { channel } = req.query;

    const params = [];
    let filter = "";

    if (channel) {
      params.push(channel);
      filter = `and ic.code = $${params.length}`;
    }

    const result = await db.query(
      `select
        isc.*,
        ic.code as channel_code,
        ic.name as channel_name
       from inventory_sub_channels isc
       join inventory_channels ic on ic.id = isc.channel_id
       where isc.is_active = true
       ${filter}
       order by ic.name asc, isc.name asc`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get inventory sub channels error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch sub channels",
    });
  }
});

/**
 * GET locations
 * filters: channel, sub_channel
 */
router.get("/locations", async (req, res) => {
  try {
    const { channel, sub_channel } = req.query;

    const params = [];
    const conditions = ["il.is_active = true"];

    if (channel) {
      params.push(channel);
      conditions.push(`ic.code = $${params.length}`);
    }

    if (sub_channel) {
      params.push(sub_channel);
      conditions.push(`isc.code = $${params.length}`);
    }

    const result = await db.query(
      `select
        il.*,
        ic.code as channel_code,
        ic.name as channel_name,
        isc.code as sub_channel_code,
        isc.name as sub_channel_name
       from inventory_locations il
       join inventory_channels ic on ic.id = il.channel_id
       left join inventory_sub_channels isc on isc.id = il.sub_channel_id
       where ${conditions.join(" and ")}
       order by ic.name asc, isc.name asc, il.name asc`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get inventory locations error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch locations",
    });
  }
});

/**
 * CREATE location manually
 */
router.post("/locations", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      channel,
      sub_channel,
      location_code,
      location_name,
      city,
      state,
      pincode,
      location_type,
    } = req.body;

    await client.query("BEGIN");

    const channelRow = await getChannel(client, channel);
    const subChannelRow =
      sub_channel && channelRow.code === "ecom"
        ? await getSubChannel(client, channelRow.id, sub_channel)
        : sub_channel
          ? await getSubChannel(client, channelRow.id, sub_channel)
          : null;

    const location = await findOrCreateLocation(client, {
      channel: channelRow,
      subChannel: subChannelRow,
      location_code,
      location_name,
      city,
      state,
      pincode,
      location_type,
    });

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Inventory location saved successfully",
      data: location,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create inventory location error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to create location",
    });
  } finally {
    client.release();
  }
});

/**
 * GET allocations
 * filters: sku, channel, sub_channel, location_id
 */
router.get("/", async (req, res) => {
  try {
    const { sku, channel, sub_channel, location_id } = req.query;

    const params = [];
    const conditions = ["ia.is_active = true"];

    if (sku) {
      params.push(normalizeSku(sku));
      conditions.push(`ia.sku = $${params.length}`);
    }

    if (channel) {
      params.push(channel);
      conditions.push(`ic.code = $${params.length}`);
    }

    if (sub_channel) {
      params.push(sub_channel);
      conditions.push(`isc.code = $${params.length}`);
    }

    if (location_id) {
      params.push(location_id);
      conditions.push(`ia.location_id = $${params.length}`);
    }

    const result = await db.query(
      `select
        ia.id,
        ia.main_inventory_id,
        ia.sku,

        ia.channel_id,
        ic.code as channel_code,
        ic.name as channel_name,

        ia.sub_channel_id,
        isc.code as sub_channel_code,
        isc.name as sub_channel_name,

        ia.location_id,
        il.name as location_name,
        il.code as location_code,
        il.city,
        il.state,
        il.pincode,
        il.location_type,

        ia.allocated_stock,
        ia.reserved_stock,
        ia.available_stock,
        ia.min_stock_level,
        ia.is_out_of_stock,
        ia.is_low_stock,
        ia.remarks,
        ia.created_at,
        ia.updated_at,

        mi.item_name,
        mi.total_stock as main_total_stock,
        mi.available_stock as main_available_stock,
        mi.product_link_status,
        il.service_location_id,
sl.name as service_location_name,
sl.city as service_location_city,
sl.state as service_location_state,
sl.pincode as service_location_pincode

       from inventory_allocations ia

       join main_inventory mi
         on mi.id = ia.main_inventory_id

       join inventory_channels ic
         on ic.id = ia.channel_id

       left join inventory_sub_channels isc
         on isc.id = ia.sub_channel_id

       join inventory_locations il
         on il.id = ia.location_id
         left join service_locations sl
  on sl.id = il.service_location_id

       where ${conditions.join(" and ")}

       order by ia.updated_at desc`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get inventory allocations error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch inventory allocations",
    });
  }
});

/**
 * CREATE / UPDATE allocation
 */
router.post("/", async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const allocation = await upsertAllocation(
      client,
      req.body,
      req.user.id,
      "allocate"
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Inventory allocation saved successfully",
      data: allocation,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create allocation error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to save allocation",
    });
  } finally {
    client.release();
  }
});

/**
 * UPDATE allocation by id
 */
router.put("/:id", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      allocated_stock,
      reserved_stock = 0,
      min_stock_level = 0,
      remarks,
    } = req.body;

    await client.query("BEGIN");

    const currentResult = await client.query(
      `select ia.*, mi.available_stock as main_available_stock
       from inventory_allocations ia
       join main_inventory mi on mi.id = ia.main_inventory_id
       where ia.id = $1
       and ia.is_active = true
       limit 1`,
      [req.params.id]
    );

    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Allocation not found",
      });
    }

    const current = currentResult.rows[0];

    const nextAllocated = toNumber(allocated_stock, Number(current.allocated_stock));
    const nextReserved = toNumber(reserved_stock, 0);
    const nextMin = toNumber(min_stock_level, 0);

    if (nextAllocated < 0 || nextReserved < 0 || nextMin < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Stock values cannot be negative",
      });
    }

    if (nextReserved > nextAllocated) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "reserved_stock cannot be greater than allocated_stock",
      });
    }

    const deltaAllocated = nextAllocated - Number(current.allocated_stock || 0);
    const mainAvailable = Number(current.main_available_stock || 0);

    if (deltaAllocated > mainAvailable) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Insufficient main inventory. Available: ${mainAvailable}, Required extra: ${deltaAllocated}`,
      });
    }

    const nextAvailable = nextAllocated - nextReserved;
    const status = getStatus(nextAvailable, nextMin);

    const result = await client.query(
      `update inventory_allocations
       set
        allocated_stock = $1,
        reserved_stock = $2,
        min_stock_level = $3,
        is_out_of_stock = $4,
        is_low_stock = $5,
        remarks = $6,
        updated_by = $7,
        updated_at = now()
       where id = $8
       returning *`,
      [
        nextAllocated,
        nextReserved,
        nextMin,
        status.is_out_of_stock,
        status.is_low_stock,
        clean(remarks) || "Allocation adjusted",
        req.user.id,
        req.params.id,
      ]
    );

    const updated = result.rows[0];

    const quantityChanged =
      Math.abs(nextAllocated - Number(current.allocated_stock || 0)) +
      Math.abs(nextReserved - Number(current.reserved_stock || 0));

    if (quantityChanged > 0) {
      await insertAllocationTransaction(client, {
        allocation_id: updated.id,
        main_inventory_id: updated.main_inventory_id,
        sku: updated.sku,
        channel_id: updated.channel_id,
        sub_channel_id: updated.sub_channel_id,
        location_id: updated.location_id,
        transaction_type: "adjustment",
        quantity: quantityChanged,
        old_allocated_stock: Number(current.allocated_stock || 0),
        new_allocated_stock: Number(updated.allocated_stock || 0),
        old_reserved_stock: Number(current.reserved_stock || 0),
        new_reserved_stock: Number(updated.reserved_stock || 0),
        old_available_stock: Number(current.available_stock || 0),
        new_available_stock: Number(updated.available_stock || 0),
        remarks: clean(remarks) || "Allocation adjusted",
        created_by: req.user.id,
      });
    }

    await client.query(`select sync_main_inventory_allocated_stock($1)`, [
      updated.main_inventory_id,
    ]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Allocation updated successfully",
      data: updated,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Update allocation error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to update allocation",
    });
  } finally {
    client.release();
  }
});

/**
 * DELETE / deactivate allocation
 */
router.delete("/:id", async (req, res) => {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    const currentResult = await client.query(
      `select *
       from inventory_allocations
       where id = $1
       and is_active = true
       limit 1`,
      [req.params.id]
    );

    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Allocation not found",
      });
    }

    const current = currentResult.rows[0];

    const result = await client.query(
      `update inventory_allocations
       set
        is_active = false,
        allocated_stock = 0,
        reserved_stock = 0,
        is_out_of_stock = true,
        is_low_stock = false,
        remarks = 'Allocation deactivated',
        updated_by = $1,
        updated_at = now()
       where id = $2
       returning *`,
      [req.user.id, req.params.id]
    );

    if (Number(current.allocated_stock || 0) > 0) {
      await insertAllocationTransaction(client, {
        allocation_id: current.id,
        main_inventory_id: current.main_inventory_id,
        sku: current.sku,
        channel_id: current.channel_id,
        sub_channel_id: current.sub_channel_id,
        location_id: current.location_id,
        transaction_type: "deactivate",
        quantity: Number(current.allocated_stock || 0),
        old_allocated_stock: Number(current.allocated_stock || 0),
        new_allocated_stock: 0,
        old_reserved_stock: Number(current.reserved_stock || 0),
        new_reserved_stock: 0,
        old_available_stock: Number(current.available_stock || 0),
        new_available_stock: 0,
        remarks: "Allocation deactivated",
        created_by: req.user.id,
      });
    }

    await client.query(`select sync_main_inventory_allocated_stock($1)`, [
      current.main_inventory_id,
    ]);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Allocation deactivated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete allocation error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to delete allocation",
    });
  } finally {
    client.release();
  }
});

/**
 * GET allocation transactions
 */
router.get("/:id/transactions", async (req, res) => {
  try {
    const result = await db.query(
      `select
        iat.*,
        ic.code as channel_code,
        isc.code as sub_channel_code,
        il.name as location_name,
        up.full_name as created_by_name
       from inventory_allocation_transactions iat
       left join inventory_channels ic on ic.id = iat.channel_id
       left join inventory_sub_channels isc on isc.id = iat.sub_channel_id
       left join inventory_locations il on il.id = iat.location_id
       left join user_profiles up on up.id = iat.created_by
       where iat.allocation_id = $1
       order by iat.created_at desc`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get allocation transactions error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch allocation transactions",
    });
  }
});

/**
 * BULK UPLOAD SUB INVENTORY / ALLOCATIONS
 *
 * CSV columns:
 * sku,channel,sub_channel,location_code,location_name,city,state,pincode,location_type,allocated_stock,reserved_stock,min_stock_level,remarks
 */
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
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
        .pipe(csvParser())
        .on("data", (row) => rows.push(row))
        .on("end", resolve)
        .on("error", reject);
    });

    const results = [];

    await client.query("BEGIN");

    for (let index = 0; index < rows.length; index++) {
      try {
        const allocation = await upsertAllocation(
          client,
          rows[index],
          req.user.id,
          "bulk_upload"
        );

        results.push({
          row: index + 1,
          success: true,
          sku: allocation.sku,
          allocation_id: allocation.id,
          allocated_stock: allocation.allocated_stock,
          reserved_stock: allocation.reserved_stock,
          available_stock: allocation.available_stock,
        });
      } catch (rowError) {
        results.push({
          row: index + 1,
          success: false,
          sku: rows[index]?.sku,
          message: rowError.message,
        });
      }
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Sub inventory bulk upload processed",
      total_rows: rows.length,
      processed: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Bulk upload allocation error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Bulk upload failed",
    });
  } finally {
    client.release();
  }
});

module.exports = router;