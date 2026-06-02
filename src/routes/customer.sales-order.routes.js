const express = require("express");
const db = require("../config/db");
const { authenticateCustomer } = require("../middleware/customerAuth.middleware");

const router = express.Router();

router.use(authenticateCustomer);

function generateOrderNumber() {
  return `HM-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function generateReturnNumber() {
  return `HMR-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}
async function validateCustomerForChannel(client, customerId, requestedChannel) {
  const profileResult = await client.query(
    `select
       up.id,
       up.full_name,
       up.mobile,
       up.email,
       up.customer_type,
       up.status
     from user_profiles up
     where up.id = $1
     limit 1`,
    [customerId]
  );

  if (profileResult.rows.length === 0) {
    throw new Error("Customer profile not found");
  }

  const profile = profileResult.rows[0];

  if (profile.status !== "active") {
    throw new Error("Customer account is not active");
  }

  if (requestedChannel === "household") {
    if (profile.customer_type && profile.customer_type !== "household") {
      throw new Error("This account is not allowed to place household orders");
    }

    return {
      profile,
      commercialCustomer: null,
    };
  }

  if (requestedChannel === "commercial") {
    if (profile.customer_type !== "commercial") {
      throw new Error("This account is not registered as commercial customer");
    }

    const commercialResult = await client.query(
      `select
         cc.id,
         cc.business_name,
         cc.contact_person,
         cc.gst_number,
         cc.email,
         cc.phone,
         cc.status
       from commercial_customers cc
       where cc.user_profile_id = $1
       limit 1`,
      [customerId]
    );

    if (commercialResult.rows.length === 0) {
      throw new Error("Commercial customer profile not found");
    }

    const commercialCustomer = commercialResult.rows[0];

    if (commercialCustomer.status !== "approved") {
      throw new Error("Commercial account is not approved yet");
    }

    return {
      profile,
      commercialCustomer,
    };
  }

  throw new Error("Invalid ecom_channel");
}
/**
 * POST /api/customer/orders
 *
 * Place sales order and reduce location allocation stock.
 *
 * Body:
 * {
 *   "service_location_id": "uuid",
 *   "ecom_channel": "household",
 *   "items": [
 *     { "product_id": "uuid", "quantity": 2 }
 *   ],
 *   "delivery_address": {},
 *   "remarks": "optional"
 * }
 */
router.post("/", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      service_location_id,
      location_id,
      ecom_channel = "household",
      portal_type,
      items,
      delivery_address,
      remarks,
    } = req.body;

    const finalLocationId = service_location_id || location_id;
    const finalEcomChannel = ecom_channel || portal_type || "household";

    if (!finalLocationId) {
      return res.status(400).json({
        success: false,
        message: "service_location_id is required",
      });
    }

    if (!["household", "commercial"].includes(finalEcomChannel)) {
      return res.status(400).json({
        success: false,
        message: "ecom_channel must be household or commercial",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one order item is required",
      });
    }

    await client.query("BEGIN");
console.log("ORDER CUSTOMER:", req.customer);
console.log("ORDER CHANNEL:", finalEcomChannel);
    const { profile, commercialCustomer } = await validateCustomerForChannel(
  client,
  req.customer.id,
  finalEcomChannel
);

    const orderNumber = generateOrderNumber();

const orderResult = await client.query(
  `insert into sales_orders
   (
    order_number,
    customer_id,
    customer_mobile,
    channel,
    sub_channel,
    customer_type,
    commercial_customer_id,
    business_name,
    gst_number,
    contact_person,
    service_location_id,
    order_status,
    payment_status,
    delivery_address,
    remarks,
    placed_at,
    updated_at
   )
   values
   ($1,$2,$3,'ecom',$4,$5,$6,$7,$8,$9,$10,'placed','pending',$11,$12,now(),now())
   returning *`,
  [
    orderNumber,
    req.customer.id,
    profile.mobile || req.customer.mobile || commercialCustomer?.phone || null,
    finalEcomChannel,
    finalEcomChannel,
    commercialCustomer?.id || null,
    commercialCustomer?.business_name || null,
    commercialCustomer?.gst_number || null,
    commercialCustomer?.contact_person || null,
    finalLocationId,
    delivery_address || null,
    remarks || null,
  ]
);

    const order = orderResult.rows[0];

    let subtotal = 0;
    let totalDiscount = 0;
    let totalTax = 0;

    const createdItems = [];

    for (const item of items) {
      const productId = item.product_id || item.id;
      const quantity = Number(item.quantity || 0);

      if (!productId || quantity <= 0) {
        throw new Error("Each item must have product_id and quantity > 0");
      }

      /**
       * Lock product + allocation row for this product/location/channel.
       * This prevents overselling during concurrent orders.
       */
      const productResult = await client.query(
        `select
          cpl.id as product_id,
          cpl.name,
          cpl.slug,
          cpl.sku,
          cpl.ecom_channel,

          cpl.mrp,
          cpl.selling_price,
          cpl.currency,

          cpl.service_location_id,
          cpl.available_stock,

          ia.id as allocation_id,
          ia.main_inventory_id,
          ia.allocated_stock,
          ia.reserved_stock,
          ia.available_stock as allocation_available_stock,

          mi.id as main_inventory_id

         from customer_product_listing cpl

         join inventory_channels ic
           on ic.code = 'ecom'

         join inventory_sub_channels isc
           on isc.channel_id = ic.id
          and isc.code = cpl.ecom_channel

         join inventory_locations il
           on il.service_location_id = cpl.service_location_id
          and il.channel_id = ic.id
          and il.sub_channel_id = isc.id
          and il.is_active = true

         join inventory_allocations ia
           on ia.location_id = il.id
          and upper(ia.sku) = upper(cpl.sku)
          and ia.is_active = true

         join main_inventory mi
           on mi.id = ia.main_inventory_id
          and mi.is_active = true

         where cpl.id = $1
         and cpl.service_location_id = $2
         and cpl.ecom_channel = $3
         and cpl.available_stock > 0
         and cpl.is_out_of_stock = false

         limit 1
         for update of ia`,
        [productId, finalLocationId, finalEcomChannel]
      );

      if (productResult.rows.length === 0) {
        throw new Error(`Product not available for selected location: ${productId}`);
      }

      const product = productResult.rows[0];

      const availableStock = Number(product.allocation_available_stock || 0);

      if (availableStock < quantity) {
        throw new Error(
          `Insufficient stock for ${product.name}. Available: ${availableStock}`
        );
      }

      const unitPrice = toNumber(product.selling_price);
      const mrp = toNumber(product.mrp);
      const lineTotal = unitPrice * quantity;
      const lineDiscount = Math.max(mrp - unitPrice, 0) * quantity;

      subtotal += lineTotal;
      totalDiscount += lineDiscount;

      const itemResult = await client.query(
        `insert into sales_order_items
         (
          order_id,
          product_id,
          main_inventory_id,
          allocation_id,
          sku,
          product_name,
          quantity,
          unit_price,
          mrp,
          discount_amount,
          tax_amount,
          total_price,
          created_at
         )
         values
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,now())
         returning *`,
        [
          order.id,
          product.product_id,
          product.main_inventory_id,
          product.allocation_id,
          product.sku,
          product.name,
          quantity,
          unitPrice,
          mrp,
          lineDiscount,
          lineTotal,
        ]
      );

      const orderItem = itemResult.rows[0];
      createdItems.push(orderItem);

      /**
       * Reduce location sub-inventory.
       */
      await client.query(
        `update inventory_allocations
         set
          allocated_stock = allocated_stock - $1,
          is_out_of_stock = case when (allocated_stock - $1 - reserved_stock) <= 0 then true else false end,
          is_low_stock = case when (allocated_stock - $1 - reserved_stock) <= min_stock_level then true else false end,
          updated_at = now()
         where id = $2`,
        [quantity, product.allocation_id]
      );

      await client.query(
        `insert into inventory_transactions
         (
          main_inventory_id,
          allocation_id,
          product_id,
          sku,
          location_id,
          transaction_type,
          quantity,
          reference_type,
          reference_id,
          order_id,
          order_item_id,
          remarks,
          created_by,
          created_at
         )
         values
         ($1,$2,$3,$4,$5,'stock_out',$6,'sales_order',$7,$7,$8,$9,$10,now())`,
        [
          product.main_inventory_id,
          product.allocation_id,
          product.product_id,
          product.sku,
          product.service_location_id,
          quantity,
          order.id,
          orderItem.id,
          `Sales order ${order.order_number}`,
          req.customer.id,
        ]
      );

      await client.query(
        `select sync_main_inventory_allocated_stock($1)`,
        [product.main_inventory_id]
      );
    }

    const deliveryCharge = 0;
    const taxAmount = totalTax;
    const totalAmount = subtotal + deliveryCharge + taxAmount;

    const updatedOrderResult = await client.query(
      `update sales_orders
       set
        subtotal = $1,
        discount_amount = $2,
        delivery_charge = $3,
        tax_amount = $4,
        total_amount = $5,
        updated_at = now()
       where id = $6
       returning *`,
      [
        subtotal,
        totalDiscount,
        deliveryCharge,
        taxAmount,
        totalAmount,
        order.id,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Order placed successfully",
      data: {
        order: updatedOrderResult.rows[0],
        items: createdItems,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Place sales order error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to place order",
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/customer/orders
 *
 * Customer order history
 */
router.get("/", async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const result = await db.query(
      `select
        so.*,

        coalesce(
          (
            select json_agg(
              json_build_object(
                'id', soi.id,
                'product_id', soi.product_id,
                'sku', soi.sku,
                'product_name', soi.product_name,
                'quantity', soi.quantity,
                'returned_quantity', soi.returned_quantity,
                'unit_price', soi.unit_price,
                'mrp', soi.mrp,
                'total_price', soi.total_price
              )
              order by soi.created_at asc
            )
            from sales_order_items soi
            where soi.order_id = so.id
          ),
          '[]'::json
        ) as items

       from sales_orders so
       where so.customer_id = $1
       order by so.placed_at desc
       limit $2 offset $3`,
      [req.customer.id, Number(limit), Number(offset)]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Customer order history error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch orders",
    });
  }
});

/**
 * GET /api/customer/orders/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const orderResult = await db.query(
      `select *
       from sales_orders
       where id = $1
       and customer_id = $2
       limit 1`,
      [req.params.id, req.customer.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const itemsResult = await db.query(
      `select *
       from sales_order_items
       where order_id = $1
       order by created_at asc`,
      [req.params.id]
    );

    const returnsResult = await db.query(
      `select *
       from sales_returns
       where order_id = $1
       order by created_at desc`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: {
        ...orderResult.rows[0],
        items: itemsResult.rows,
        returns: returnsResult.rows,
      },
    });
  } catch (error) {
    console.error("Customer order detail error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch order",
    });
  }
});

/**
 * POST /api/customer/orders/:id/return
 *
 * Return full or partial order and restock inventory.
 *
 * Body:
 * {
 *   "reason": "Damaged item",
 *   "items": [
 *     { "order_item_id": "uuid", "quantity": 1 }
 *   ]
 * }
 */
router.post("/:id/return", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const { reason, items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Return items are required",
      });
    }

    await client.query("BEGIN");

    const orderResult = await client.query(
      `select *
       from sales_orders
       where id = $1
       and customer_id = $2
       limit 1
       for update`,
      [req.params.id, req.customer.id]
    );

    if (orderResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const order = orderResult.rows[0];

    if (["cancelled", "returned"].includes(order.order_status)) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Order is already cancelled or returned",
      });
    }

    const returnNumber = generateReturnNumber();

    const returnResult = await client.query(
      `insert into sales_returns
       (
        return_number,
        order_id,
        customer_id,
        return_status,
        reason,
        created_at,
        updated_at
       )
       values
       ($1,$2,$3,'completed',$4,now(),now())
       returning *`,
      [returnNumber, order.id, req.customer.id, reason || null]
    );

    const returnOrder = returnResult.rows[0];

    let totalRefund = 0;
    const returnedItems = [];

    for (const item of items) {
      const orderItemId = item.order_item_id;
      const returnQty = Number(item.quantity || 0);

      if (!orderItemId || returnQty <= 0) {
        throw new Error("Each return item must have order_item_id and quantity > 0");
      }

      const orderItemResult = await client.query(
        `select *
         from sales_order_items
         where id = $1
         and order_id = $2
         limit 1
         for update`,
        [orderItemId, order.id]
      );

      if (orderItemResult.rows.length === 0) {
        throw new Error(`Order item not found: ${orderItemId}`);
      }

      const orderItem = orderItemResult.rows[0];

      const remainingReturnable =
        Number(orderItem.quantity || 0) - Number(orderItem.returned_quantity || 0);

      if (returnQty > remainingReturnable) {
        throw new Error(
          `Return quantity exceeds purchased quantity for ${orderItem.product_name}`
        );
      }

      const refundAmount = toNumber(orderItem.unit_price) * returnQty;
      totalRefund += refundAmount;

      /**
       * Lock allocation row and restock location inventory.
       */
      await client.query(
        `select id
         from inventory_allocations
         where id = $1
         for update`,
        [orderItem.allocation_id]
      );

      await client.query(
        `update inventory_allocations
         set
          allocated_stock = allocated_stock + $1,
          is_out_of_stock = false,
          is_low_stock = case when (allocated_stock + $1 - reserved_stock) <= min_stock_level then true else false end,
          updated_at = now()
         where id = $2`,
        [returnQty, orderItem.allocation_id]
      );

      const returnItemResult = await client.query(
        `insert into sales_return_items
         (
          return_id,
          order_item_id,
          product_id,
          main_inventory_id,
          allocation_id,
          sku,
          quantity,
          refund_amount,
          created_at
         )
         values
         ($1,$2,$3,$4,$5,$6,$7,$8,now())
         returning *`,
        [
          returnOrder.id,
          orderItem.id,
          orderItem.product_id,
          orderItem.main_inventory_id,
          orderItem.allocation_id,
          orderItem.sku,
          returnQty,
          refundAmount,
        ]
      );

      returnedItems.push(returnItemResult.rows[0]);

      await client.query(
        `update sales_order_items
         set returned_quantity = returned_quantity + $1
         where id = $2`,
        [returnQty, orderItem.id]
      );

      await client.query(
        `insert into inventory_transactions
         (
          main_inventory_id,
          allocation_id,
          product_id,
          sku,
          transaction_type,
          quantity,
          reference_type,
          reference_id,
          order_id,
          order_item_id,
          return_id,
          remarks,
          created_by,
          created_at
         )
         values
         ($1,$2,$3,$4,'stock_in',$5,'sales_return',$6,$7,$8,$6,$9,$10,now())`,
        [
          orderItem.main_inventory_id,
          orderItem.allocation_id,
          orderItem.product_id,
          orderItem.sku,
          returnQty,
          returnOrder.id,
          order.id,
          orderItem.id,
          reason || `Return for order ${order.order_number}`,
          req.customer.id,
        ]
      );

      await client.query(
        `select sync_main_inventory_allocated_stock($1)`,
        [orderItem.main_inventory_id]
      );
    }

    await client.query(
      `update sales_returns
       set total_refund_amount = $1,
           updated_at = now()
       where id = $2`,
      [totalRefund, returnOrder.id]
    );

    const remainingItemsResult = await client.query(
      `select
        sum(quantity) as total_qty,
        sum(returned_quantity) as returned_qty
       from sales_order_items
       where order_id = $1`,
      [order.id]
    );

    const totalQty = Number(remainingItemsResult.rows[0].total_qty || 0);
    const returnedQty = Number(remainingItemsResult.rows[0].returned_qty || 0);

    const newOrderStatus =
      returnedQty >= totalQty ? "returned" : "partially_returned";

    const newPaymentStatus =
      returnedQty >= totalQty ? "refunded" : "partial_refund";

    await client.query(
      `update sales_orders
       set order_status = $1,
           payment_status = $2,
           updated_at = now()
       where id = $3`,
      [newOrderStatus, newPaymentStatus, order.id]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Order return completed and inventory restocked",
      data: {
        return_order: {
          ...returnOrder,
          total_refund_amount: totalRefund,
        },
        items: returnedItems,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Return sales order error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to return order",
    });
  } finally {
    client.release();
  }
});

module.exports = router;