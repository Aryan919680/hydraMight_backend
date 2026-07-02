const DISTRIBUTOR_CHANNEL_CODES = ["distributor", "distribution"];

async function createStockistInventoryLedger(client, payload) {
  const {
    stockistInventoryId,
    stockistId,
    productId,
    stockistPurchaseOrderId,
    transactionType,
    quantity,
    note = null,
    actorId = null,
  } = payload;

  await client.query(
    `
    insert into public.stockist_inventory_ledger (
      stockist_inventory_id,
      stockist_id,
      product_id,
      stockist_purchase_order_id,
      transaction_type,
      quantity,
      note,
      actor_id,
      created_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, now())
    `,
    [
      stockistInventoryId,
      stockistId,
      productId,
      stockistPurchaseOrderId,
      transactionType,
      quantity,
      note,
      actorId,
    ]
  );
}

async function shipPurchaseItemImmediately(client, payload) {
  const {
    stockistPurchaseOrderId,
    stockistPurchaseOrderItemId,
    stockistId,
    productId,
    mainInventoryId,
    requestedQuantity,
    note = null,
    actorId = null,
  } = payload;

  const mainInventoryResult = await client.query(
    `
    select
      id,
      coalesce(total_stock, 0) as total_stock,
      coalesce(available_stock, 0) as available_stock
    from public.main_inventory
    where id = $1
    for update
    `,
    [mainInventoryId]
  );

  if (mainInventoryResult.rowCount === 0) {
    throw new Error("Main inventory was not found for the selected product.");
  }

  const mainInventory = mainInventoryResult.rows[0];

  if (Number(mainInventory.total_stock) < requestedQuantity) {
    throw new Error(
      `Main inventory is insufficient. Available: ${mainInventory.total_stock}, requested: ${requestedQuantity}.`
    );
  }

  const allocationResult = await client.query(
    `
    select
      ia.id,
      coalesce(ia.allocated_stock, 0) as allocated_stock,
      coalesce(ia.reserved_stock, 0) as reserved_stock,
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

  const distributorAvailableStock = allocationResult.rows.reduce(
    (total, row) => total + Number(row.available_stock || 0),
    0
  );

  if (distributorAvailableStock < requestedQuantity) {
    throw new Error(
      `Distributor channel stock is insufficient. Available: ${distributorAvailableStock}, requested: ${requestedQuantity}.`
    );
  }

  let remainingQuantity = requestedQuantity;

  for (const allocation of allocationResult.rows) {
    if (remainingQuantity <= 0) {
      break;
    }

    const allocationAvailable = Number(allocation.available_stock || 0);

    const quantityToShip = Math.min(
      allocationAvailable,
      remainingQuantity
    );

    /*
      IMPORTANT:
      Do not update available_stock.
      It is generated automatically from allocated_stock/reserved_stock.
    */
    const allocationUpdate = await client.query(
      `
      update public.inventory_allocations
      set
        allocated_stock = greatest(
          0,
          coalesce(allocated_stock, 0) - $1
        ),
        updated_at = now()
      where id = $2
        and coalesce(available_stock, 0) >= $1
      returning id
      `,
      [quantityToShip, allocation.id]
    );

    if (allocationUpdate.rowCount === 0) {
      throw new Error(
        "Distributor stock changed while placing the order. Please retry."
      );
    }

    await client.query(
      `
      insert into public.stockist_purchase_shipments (
        stockist_purchase_order_id,
        stockist_purchase_order_item_id,
        stockist_id,
        product_id,
        main_inventory_id,
        inventory_allocation_id,
        quantity,
        shipment_status,
        shipped_at,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        'shipped',
        now(),
        now(),
        now()
      )
      `,
      [
        stockistPurchaseOrderId,
        stockistPurchaseOrderItemId,
        stockistId,
        productId,
        mainInventoryId,
        allocation.id,
        quantityToShip,
      ]
    );

    const stockistInventoryResult = await client.query(
      `
      insert into public.stockist_inventory (
        stockist_id,
        product_id,
        total_stock,
        reserved_stock,
        available_stock,
        in_transit_stock,
        created_at,
        updated_at
      )
      values ($1, $2, 0, 0, 0, $3, now(), now())
      on conflict (stockist_id, product_id)
      do update set
        in_transit_stock =
          public.stockist_inventory.in_transit_stock
          + excluded.in_transit_stock,
        updated_at = now()
      returning id
      `,
      [stockistId, productId, quantityToShip]
    );

    await createStockistInventoryLedger(client, {
      stockistInventoryId: stockistInventoryResult.rows[0].id,
      stockistId,
      productId,
      stockistPurchaseOrderId,
      transactionType: "stock_in_transit",
      quantity: quantityToShip,
      note,
      actorId,
    });

    remainingQuantity -= quantityToShip;
  }

  /*
    Do not update main_inventory.available_stock.
    It is generated automatically.
  */
  const mainInventoryUpdate = await client.query(
    `
    update public.main_inventory
    set
      total_stock = greatest(
        0,
        coalesce(total_stock, 0) - $1
      ),
      updated_at = now()
    where id = $2
      and coalesce(total_stock, 0) >= $1
    returning id
    `,
    [requestedQuantity, mainInventoryId]
  );

  if (mainInventoryUpdate.rowCount === 0) {
    throw new Error(
      "Main inventory changed while placing the order. Please retry."
    );
  }
}
async function receivePurchaseOrderAtStockist(client, payload) {
  const {
    stockistPurchaseOrderId,
    stockistId,
    note = null,
    actorId = null,
  } = payload;

  const shipmentResult = await client.query(
    `
    select
      id,
      product_id,
      quantity
    from public.stockist_purchase_shipments
    where stockist_purchase_order_id = $1
      and stockist_id = $2
      and shipment_status = 'shipped'
    for update
    `,
    [stockistPurchaseOrderId, stockistId]
  );

  if (shipmentResult.rowCount === 0) {
    throw new Error("No shipped stock was found for this order.");
  }

  for (const shipment of shipmentResult.rows) {
    const inventoryResult = await client.query(
      `
      insert into public.stockist_inventory (
        stockist_id,
        product_id,
        total_stock,
        reserved_stock,
        available_stock,
        in_transit_stock,
        last_received_at,
        created_at,
        updated_at
      )
      values ($1, $2, $3, 0, $3, 0, now(), now(), now())
      on conflict (stockist_id, product_id)
      do update set
        total_stock =
          public.stockist_inventory.total_stock + excluded.total_stock,
        available_stock =
          public.stockist_inventory.available_stock + excluded.available_stock,
        in_transit_stock = greatest(
          0,
          public.stockist_inventory.in_transit_stock - excluded.total_stock
        ),
        last_received_at = now(),
        updated_at = now()
      returning id
      `,
      [stockistId, shipment.product_id, shipment.quantity]
    );

    await client.query(
      `
      update public.stockist_purchase_shipments
      set
        shipment_status = 'delivered',
        delivered_at = now(),
        updated_at = now()
      where id = $1
      `,
      [shipment.id]
    );

    await createStockistInventoryLedger(client, {
      stockistInventoryId: inventoryResult.rows[0].id,
      stockistId,
      productId: shipment.product_id,
      stockistPurchaseOrderId,
      transactionType: "stock_received",
      quantity: shipment.quantity,
      note,
      actorId,
    });
  }
}

module.exports = {
  shipPurchaseItemImmediately,
  receivePurchaseOrderAtStockist,
};