const DISTRIBUTOR_CHANNEL_CODES = ["distribution", "distributor"];

async function reserveStockistInventory(client, payload) {
  const {
    agencySupplyOrderId,
    agencySupplyOrderItemId,
    stockistId,
    productId,
    quantity,
  } = payload;

  const inventoryResult = await client.query(
    `
    select
      id,
      coalesce(total_stock, 0) as total_stock,
      coalesce(reserved_stock, 0) as reserved_stock,
      coalesce(available_stock, 0) as available_stock
    from public.stockist_inventory
    where stockist_id = $1
      and product_id = $2
    for update
    `,
    [stockistId, productId]
  );

  if (inventoryResult.rowCount === 0) {
    throw new Error(
      "Stockist inventory was not found for the selected product."
    );
  }

  const inventory = inventoryResult.rows[0];

  if (Number(inventory.available_stock) < quantity) {
    throw new Error(
      `Stockist inventory is insufficient. Available: ${inventory.available_stock}, requested: ${quantity}.`
    );
  }

  await client.query(
    `
    update public.stockist_inventory
    set
      reserved_stock = coalesce(reserved_stock, 0) + $1,
      available_stock = coalesce(available_stock, 0) - $1,
      updated_at = now()
    where id = $2
      and coalesce(available_stock, 0) >= $1
    `,
    [quantity, inventory.id]
  );

  await client.query(
    `
    insert into public.agency_supply_order_reservations (
      agency_supply_order_id,
      agency_supply_order_item_id,
      reservation_source,
      stockist_id,
      product_id,
      stockist_inventory_id,
      quantity,
      reservation_status,
      created_at,
      updated_at
    )
    values (
      $1, $2, 'stockist_inventory',
      $3, $4, $5, $6,
      'reserved',
      now(),
      now()
    )
    `,
    [
      agencySupplyOrderId,
      agencySupplyOrderItemId,
      stockistId,
      productId,
      inventory.id,
      quantity,
    ]
  );
}

async function reserveAdminDistributionInventory(client, payload) {
  const {
    agencySupplyOrderId,
    agencySupplyOrderItemId,
    productId,
    quantity,
  } = payload;

  const mainInventoryResult = await client.query(
    `
    select id
    from public.main_inventory
    where product_id = $1
      and is_active = true
    order by updated_at desc nulls last
    limit 1
    `,
    [productId]
  );

  if (mainInventoryResult.rowCount === 0) {
    throw new Error(
      "Main inventory was not found for the selected product."
    );
  }

  const mainInventoryId = mainInventoryResult.rows[0].id;

  const allocationsResult = await client.query(
    `
    select
      ia.id,
      ia.main_inventory_id,
      coalesce(ia.available_stock, 0) as available_stock
    from public.inventory_allocations ia
    join public.inventory_channels ic
      on ic.id = ia.channel_id
    where ia.main_inventory_id = $1
      and ia.is_active = true
      and lower(coalesce(ic.code, '')) = any($2::text[])
      and coalesce(ia.available_stock, 0) > 0
    order by ia.updated_at asc nulls last, ia.id
    for update of ia
    `,
    [mainInventoryId, DISTRIBUTOR_CHANNEL_CODES]
  );

  const available = allocationsResult.rows.reduce(
    (sum, allocation) =>
      sum + Number(allocation.available_stock || 0),
    0
  );

  if (available < quantity) {
    throw new Error(
      `Admin distributor inventory is insufficient. Available: ${available}, requested: ${quantity}.`
    );
  }

  let remaining = quantity;

  for (const allocation of allocationsResult.rows) {
    if (remaining <= 0) {
      break;
    }

    const quantityToReserve = Math.min(
      Number(allocation.available_stock),
      remaining
    );

    /*
      available_stock is generated in your current inventory schema.
      Only reserved_stock should be updated here.
    */
    const updateResult = await client.query(
      `
      update public.inventory_allocations
      set
        reserved_stock = coalesce(reserved_stock, 0) + $1,
        updated_at = now()
      where id = $2
        and coalesce(available_stock, 0) >= $1
      returning id
      `,
      [quantityToReserve, allocation.id]
    );

    if (updateResult.rowCount === 0) {
      throw new Error(
        "Admin distributor stock changed. Please retry the order."
      );
    }

    await client.query(
      `
      insert into public.agency_supply_order_reservations (
        agency_supply_order_id,
        agency_supply_order_item_id,
        reservation_source,
        product_id,
        main_inventory_id,
        inventory_allocation_id,
        quantity,
        reservation_status,
        created_at,
        updated_at
      )
      values (
        $1, $2, 'admin_distribution',
        $3, $4, $5, $6,
        'reserved',
        now(),
        now()
      )
      `,
      [
        agencySupplyOrderId,
        agencySupplyOrderItemId,
        productId,
        allocation.main_inventory_id,
        allocation.id,
        quantityToReserve,
      ]
    );

    remaining -= quantityToReserve;
  }
}

async function releaseAgencyOrderReservations(
  client,
  agencySupplyOrderId
) {
  const reservationsResult = await client.query(
    `
    select *
    from public.agency_supply_order_reservations
    where agency_supply_order_id = $1
      and reservation_status = 'reserved'
    for update
    `,
    [agencySupplyOrderId]
  );

  for (const reservation of reservationsResult.rows) {
    if (reservation.reservation_source === "stockist_inventory") {
      await client.query(
        `
        update public.stockist_inventory
        set
          reserved_stock = greatest(
            0,
            coalesce(reserved_stock, 0) - $1
          ),
          available_stock = coalesce(available_stock, 0) + $1,
          updated_at = now()
        where id = $2
        `,
        [reservation.quantity, reservation.stockist_inventory_id]
      );
    } else {
      await client.query(
        `
        update public.inventory_allocations
        set
          reserved_stock = greatest(
            0,
            coalesce(reserved_stock, 0) - $1
          ),
          updated_at = now()
        where id = $2
        `,
        [reservation.quantity, reservation.inventory_allocation_id]
      );
    }

    await client.query(
      `
      update public.agency_supply_order_reservations
      set
        reservation_status = 'released',
        updated_at = now()
      where id = $1
      `,
      [reservation.id]
    );
  }
}

async function shipAgencyOrderReservations(
  client,
  agencySupplyOrderId
) {
  const reservationsResult = await client.query(
    `
    select *
    from public.agency_supply_order_reservations
    where agency_supply_order_id = $1
      and reservation_status = 'reserved'
    for update
    `,
    [agencySupplyOrderId]
  );

  if (reservationsResult.rowCount === 0) {
    throw new Error(
      "No reserved inventory was found for this agency order."
    );
  }

  for (const reservation of reservationsResult.rows) {
    if (reservation.reservation_source === "stockist_inventory") {
      await client.query(
        `
        update public.stockist_inventory
        set
          total_stock = greatest(
            0,
            coalesce(total_stock, 0) - $1
          ),
          reserved_stock = greatest(
            0,
            coalesce(reserved_stock, 0) - $1
          ),
          updated_at = now()
        where id = $2
        `,
        [reservation.quantity, reservation.stockist_inventory_id]
      );
    } else {
      await client.query(
        `
        update public.inventory_allocations
        set
          allocated_stock = greatest(
            0,
            coalesce(allocated_stock, 0) - $1
          ),
          reserved_stock = greatest(
            0,
            coalesce(reserved_stock, 0) - $1
          ),
          updated_at = now()
        where id = $2
        `,
        [reservation.quantity, reservation.inventory_allocation_id]
      );

      await client.query(
        `
        update public.main_inventory
        set
          total_stock = greatest(
            0,
            coalesce(total_stock, 0) - $1
          ),
          updated_at = now()
        where id = $2
        `,
        [reservation.quantity, reservation.main_inventory_id]
      );
    }

    await client.query(
      `
      update public.agency_supply_order_reservations
      set
        reservation_status = 'shipped',
        updated_at = now()
      where id = $1
      `,
      [reservation.id]
    );
  }
}

module.exports = {
  reserveStockistInventory,
  reserveAdminDistributionInventory,
  releaseAgencyOrderReservations,
  shipAgencyOrderReservations,
};