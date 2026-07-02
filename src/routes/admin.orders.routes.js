const express = require("express");
const db = require("../config/db");

const pool = db.pool || db;
const router = express.Router();

const PORTALS = new Set([
  "household",
  "commercial",
  "distributor",
  "whitelabel",
]);

const SALES_STATUSES = new Set([
  "placed",
  "pending",
  "pending_approval",
  "approved",
  "processing",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "returned",
  "partially_returned",
  "rejected",
  "refunded",
]);

const DISTRIBUTOR_STATUSES = new Set([
  "pending",
  "pending_admin_approval",
  "pending_stockist_approval",
  "approved",
  "rejected",
  "processing",
  "packed",
  "dispatched",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
]);

const PAYMENT_STATUSES = new Set([
  "pending",
  "paid",
  "failed",
  "refunded",
  "partial_refund",
  "partial",
]);

const DELIVERY_STATUSES = new Set([
  "not_started",
  "processing",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
  "failed",
  "returned",
]);

const STOCKIST_PURCHASE_PAYMENT_STATUSES = new Set([
  "pending",
  "paid",
  "failed",
  "refunded",
]);

const getAdminId = (req) => req.user?.id || req.admin?.id || null;

const clamp = (value, fallback, max) => {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return Math.min(Math.floor(number), max);
};

const normalizePortal = (value) => String(value || "").trim().toLowerCase();

function isStockistPurchaseOrder(order) {
  return order?.source_type === "stockist_purchase";
}

function tableForOrder(portalType, order) {
  if (portalType === "distributor" && isStockistPurchaseOrder(order)) {
    return "public.stockist_purchase_orders";
  }

  return portalType === "distributor"
    ? "public.distributor_orders"
    : "public.sales_orders";
}

function salesPortalCondition(portalType, alias = "so") {
  if (portalType === "household") {
    return `
      lower(
        coalesce(
          ${alias}.sub_channel,
          ${alias}.customer_type,
          'household'
        )
      ) = 'household'
    `;
  }

  if (portalType === "commercial") {
    return `
      lower(
        coalesce(
          ${alias}.sub_channel,
          ${alias}.customer_type,
          ''
        )
      ) = 'commercial'
    `;
  }

  if (portalType === "whitelabel") {
    return `
      lower(coalesce(${alias}.sub_channel, ''))
      in ('white_label', 'whitelabel')
    `;
  }

  return "1 = 0";
}

/**
 * Unified order-management result:
 * 1. Household orders
 * 2. Commercial orders
 * 3. White-label orders
 * 4. Existing distributor/agency orders
 * 5. New stockist purchase orders
 */
function getUnifiedOrdersSql() {
  return `
    select
      so.id::text as id,
      so.order_number,

      case
        when lower(coalesce(so.sub_channel, ''))
          in ('white_label', 'whitelabel')
          then 'whitelabel'

        when lower(
          coalesce(so.sub_channel, so.customer_type, 'household')
        ) = 'commercial'
          then 'commercial'

        else 'household'
      end as portal_type,

      'sales_orders'::text as source_table,
      null::text as source_type,

      so.customer_id::text as customer_id,

      coalesce(
        so.business_name,
        so.contact_person,
        up.full_name,
        'Customer'
      ) as customer_name,

      coalesce(
        so.customer_mobile,
        up.mobile
      ) as customer_phone,

      up.email as customer_email,

      so.business_name,
      so.contact_person,
      so.gst_number,

      so.service_location_id::text as service_location_id,
      sl.name as location_name,

      so.order_status,
      so.payment_status,
      coalesce(so.delivery_status, 'not_started') as delivery_status,

      coalesce(so.subtotal, 0)::numeric as subtotal,
      coalesce(so.discount_amount, 0)::numeric as discount_amount,
      coalesce(so.tax_amount, 0)::numeric as tax_amount,
      coalesce(so.delivery_charge, 0)::numeric as delivery_charge,
      coalesce(so.total_amount, 0)::numeric as total_amount,

      so.delivery_address::text as delivery_address,
      so.remarks,
      so.placed_at,
      so.placed_at as created_at,
      so.updated_at,

      (
        select count(*)::int
        from public.sales_order_items soi
        where soi.order_id = so.id
      ) as item_count

    from public.sales_orders so

    left join public.user_profiles up
      on up.id = so.customer_id

    left join public.service_locations sl
      on sl.id = so.service_location_id

    union all

    select
      doo.id::text as id,
      doo.order_number,

      'distributor'::text as portal_type,

      'distributor_orders'::text as source_table,
      doo.order_type::text as source_type,

      doo.user_profile_id::text as customer_id,

      coalesce(
        a.business_name,
        s.business_name,
        up.full_name,
        'Distributor'
      ) as customer_name,

      coalesce(
        a.mobile,
        s.mobile,
        up.mobile
      ) as customer_phone,

      coalesce(
        a.email,
        s.email,
        up.email
      ) as customer_email,

      coalesce(a.business_name, s.business_name) as business_name,
      coalesce(a.contact_person, s.contact_person) as contact_person,
      coalesce(a.gst_number, s.gst_number) as gst_number,

      null::text as service_location_id,
      coalesce(a.territory, s.territory) as location_name,

      doo.order_status,
      doo.payment_status,
      coalesce(doo.delivery_status, 'not_started') as delivery_status,

      coalesce(doo.subtotal, 0)::numeric as subtotal,
      coalesce(doo.discount_amount, 0)::numeric as discount_amount,
      coalesce(doo.tax_amount, 0)::numeric as tax_amount,
      coalesce(doo.delivery_charge, 0)::numeric as delivery_charge,
      coalesce(doo.total_amount, 0)::numeric as total_amount,

      doo.delivery_address::text as delivery_address,
      doo.remarks,
      doo.placed_at,
      doo.placed_at as created_at,
      doo.updated_at,

      (
        select count(*)::int
        from public.distributor_order_items doi
        where doi.order_id = doo.id
      ) as item_count

    from public.distributor_orders doo

    left join public.stockists s
      on s.id = doo.stockist_id

    left join public.agencies a
      on a.id = doo.agency_id

    left join public.user_profiles up
      on up.id = doo.user_profile_id

    union all

    select
      spo.id::text as id,
      spo.order_number,

      'distributor'::text as portal_type,

      'stockist_purchase_orders'::text as source_table,
      'stockist_purchase'::text as source_type,

      null::text as customer_id,

      coalesce(
        s.business_name,
        s.contact_person,
        'Stockist'
      ) as customer_name,

      s.mobile as customer_phone,
      s.email as customer_email,

      s.business_name,
      s.contact_person,
      s.gst_number,

      null::text as service_location_id,
      s.territory as location_name,

      spo.order_status,
      spo.payment_status,
      coalesce(spo.delivery_status, 'not_started') as delivery_status,

      coalesce(spo.subtotal, 0)::numeric as subtotal,
      0::numeric as discount_amount,
      0::numeric as tax_amount,
      0::numeric as delivery_charge,
      coalesce(spo.total_amount, 0)::numeric as total_amount,

      null::text as delivery_address,
      spo.remarks,
      spo.placed_at,
      coalesce(spo.created_at, spo.placed_at) as created_at,
      spo.updated_at,

      (
        select count(*)::int
        from public.stockist_purchase_order_items spoi
        where spoi.stockist_purchase_order_id = spo.id
      ) as item_count

    from public.stockist_purchase_orders spo

    join public.stockists s
      on s.id = spo.stockist_id
  `;
}

async function findOrder(client, portalType, orderId, lock = false) {
  if (!PORTALS.has(portalType)) {
    return null;
  }

  if (portalType === "distributor") {
    const distributorOrderResult = await client.query(
      `
      select
        id,
        order_number,
        order_status,
        payment_status,
        coalesce(delivery_status, 'not_started') as delivery_status,
        created_at,
        'distributor_orders'::text as source_table,
        order_type::text as source_type
      from public.distributor_orders
      where id = $1
      ${lock ? "for update" : ""}
      `,
      [orderId]
    );

    if (distributorOrderResult.rowCount > 0) {
      return distributorOrderResult.rows[0];
    }

    const stockistPurchaseOrderResult = await client.query(
      `
      select
        id,
        order_number,
        order_status,
        payment_status,
        coalesce(delivery_status, 'not_started') as delivery_status,
        created_at,
        'stockist_purchase_orders'::text as source_table,
        'stockist_purchase'::text as source_type
      from public.stockist_purchase_orders
      where id = $1
      ${lock ? "for update" : ""}
      `,
      [orderId]
    );

    return stockistPurchaseOrderResult.rows[0] || null;
  }

  const result = await client.query(
    `
    select
      id,
      order_number,
      order_status,
      payment_status,
      coalesce(delivery_status, 'not_started') as delivery_status,
      created_at,
      sub_channel,
      customer_type,
      'sales_orders'::text as source_table,
      null::text as source_type
    from public.sales_orders
    where id = $1
      and ${salesPortalCondition(portalType, "sales_orders")}
    ${lock ? "for update" : ""}
    `,
    [orderId]
  );

  return result.rows[0] || null;
}

async function createOrderEvent(
  client,
  {
    portalType,
    orderId,
    eventType,
    previousValue = null,
    newValue = null,
    note = null,
    metadata = null,
    createdBy = null,
  }
) {
  await client.query(
    `
    insert into public.admin_order_events (
      portal_type,
      order_id,
      event_type,
      previous_value,
      new_value,
      note,
      metadata,
      created_by,
      created_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, now())
    `,
    [
      portalType,
      orderId,
      eventType,
      previousValue,
      newValue,
      note,
      metadata ? JSON.stringify(metadata) : null,
      createdBy,
    ]
  );
}

/**
 * GET /api/admin/orders/summary
 */
router.get("/summary", async (req, res) => {
  try {
    const result = await pool.query(
      `
      with unified_orders as (
        ${getUnifiedOrdersSql()}
      )
      select
        count(*)::int as total_orders,

        count(*) filter (
          where portal_type = 'household'
        )::int as household_orders,

        count(*) filter (
          where portal_type = 'commercial'
        )::int as commercial_orders,

        count(*) filter (
          where portal_type = 'distributor'
        )::int as distributor_orders,

        count(*) filter (
          where portal_type = 'whitelabel'
        )::int as whitelabel_orders,

        count(*) filter (
          where order_status in (
            'pending_approval',
            'pending_admin_approval',
            'pending_stockist_approval'
          )
        )::int as pending_approval,

        count(*) filter (
          where order_status in (
            'approved',
            'processing',
            'packed'
          )
        )::int as processing_orders,

        count(*) filter (
          where order_status = 'delivered'
        )::int as delivered_orders,

        count(*) filter (
          where order_status in (
            'cancelled',
            'returned',
            'partially_returned',
            'rejected'
          )
        )::int as closed_problem_orders,

        coalesce(
          sum(total_amount) filter (
            where placed_at::date = current_date
          ),
          0
        )::numeric as today_revenue,

        coalesce(sum(total_amount), 0)::numeric as total_revenue

      from unified_orders
      `
    );

    return res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("ADMIN ORDER SUMMARY ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch order summary",
      error: error.message,
    });
  }
});

/**
 * GET /api/admin/orders
 */
router.get("/", async (req, res) => {
  try {
    const portalType = req.query.portal_type
      ? normalizePortal(req.query.portal_type)
      : null;

    const status = req.query.status
      ? String(req.query.status).trim().toLowerCase()
      : null;

    const paymentStatus = req.query.payment_status
      ? String(req.query.payment_status).trim().toLowerCase()
      : null;

    const deliveryStatus = req.query.delivery_status
      ? String(req.query.delivery_status).trim().toLowerCase()
      : null;

    const search = req.query.search
      ? String(req.query.search).trim()
      : null;

    const fromDate = req.query.from_date || null;
    const toDate = req.query.to_date || null;

    const limit = clamp(req.query.limit, 20, 100);
    const offset = clamp(req.query.offset, 0, 1000000);

    if (portalType && !PORTALS.has(portalType)) {
      return res.status(400).json({
        success: false,
        message:
          "portal_type must be household, commercial, distributor, or whitelabel",
      });
    }

    const params = [];
    const conditions = [];

    if (portalType) {
      params.push(portalType);
      conditions.push(`u.portal_type = $${params.length}`);
    }

    if (status) {
      params.push(status);
      conditions.push(`lower(u.order_status) = $${params.length}`);
    }

    if (paymentStatus) {
      params.push(paymentStatus);
      conditions.push(`lower(u.payment_status) = $${params.length}`);
    }

    if (deliveryStatus) {
      params.push(deliveryStatus);
      conditions.push(`lower(u.delivery_status) = $${params.length}`);
    }

    if (fromDate) {
      params.push(fromDate);
      conditions.push(`u.placed_at >= $${params.length}::timestamptz`);
    }

    if (toDate) {
      params.push(toDate);
      conditions.push(
        `u.placed_at < ($${params.length}::date + interval '1 day')`
      );
    }

    if (search) {
      params.push(`%${search}%`);

      conditions.push(`
        (
          u.order_number ilike $${params.length}
          or u.customer_name ilike $${params.length}
          or coalesce(u.business_name, '') ilike $${params.length}
          or coalesce(u.customer_phone, '') ilike $${params.length}
          or coalesce(u.customer_email, '') ilike $${params.length}
          or coalesce(u.location_name, '') ilike $${params.length}
        )
      `);
    }

    const whereSql = conditions.length
      ? `where ${conditions.join(" and ")}`
      : "";

    params.push(limit);
    const limitIndex = params.length;

    params.push(offset);
    const offsetIndex = params.length;

    const result = await pool.query(
      `
      with unified_orders as (
        ${getUnifiedOrdersSql()}
      )
      select
        u.*,
        count(*) over()::int as total_count
      from unified_orders u
      ${whereSql}
      order by
        u.placed_at desc nulls last,
        u.created_at desc nulls last
      limit $${limitIndex}
      offset $${offsetIndex}
      `,
      params
    );

    const total = result.rows[0]?.total_count || 0;

    return res.json({
      success: true,
      pagination: {
        total,
        limit,
        offset,
      },
      data: result.rows.map(({ total_count, ...order }) => order),
    });
  } catch (error) {
    console.error("ADMIN ORDER LIST ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
});

/**
 * GET /api/admin/orders/:portalType/:orderId
 */
router.get("/:portalType/:orderId", async (req, res) => {
  try {
    const portalType = normalizePortal(req.params.portalType);
    const { orderId } = req.params;

    if (!PORTALS.has(portalType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid portal type",
      });
    }

    if (portalType === "distributor") {
      const sourceOrder = await findOrder(
        pool,
        "distributor",
        orderId,
        false
      );

      if (!sourceOrder) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      if (isStockistPurchaseOrder(sourceOrder)) {
        const [orderResult, itemsResult, shipmentsResult] = await Promise.all([
          pool.query(
            `
            select
              spo.*,
              'distributor'::text as portal_type,
              'stockist_purchase_orders'::text as source_table,
              'stockist_purchase'::text as source_type,

              coalesce(
                s.business_name,
                s.contact_person,
                'Stockist'
              ) as customer_name,

              s.mobile as customer_phone,
              s.email as customer_email,

              s.business_name as stockist_business_name,
              s.contact_person as stockist_contact_person,
              s.mobile as stockist_mobile,
              s.email as stockist_email,
              s.territory as stockist_territory

            from public.stockist_purchase_orders spo

            join public.stockists s
              on s.id = spo.stockist_id

            where spo.id = $1
            limit 1
            `,
            [orderId]
          ),

          pool.query(
            `
            select
              spoi.*,
              p.name as current_product_name,
              p.sku as current_product_sku
            from public.stockist_purchase_order_items spoi

            left join public.products p
              on p.id = spoi.product_id

            where spoi.stockist_purchase_order_id = $1
            order by spoi.created_at asc
            `,
            [orderId]
          ),

          pool.query(
            `
            select
              sps.id,
              sps.product_id,
              sps.quantity,
              sps.shipment_status,
              sps.shipped_at,
              sps.delivered_at,
              p.name as product_name,
              p.sku
            from public.stockist_purchase_shipments sps

            left join public.products p
              on p.id = sps.product_id

            where sps.stockist_purchase_order_id = $1
            order by sps.shipped_at asc
            `,
            [orderId]
          ),
        ]);

        return res.json({
          success: true,
          data: {
            ...orderResult.rows[0],
            items: itemsResult.rows,
            shipments: shipmentsResult.rows,
          },
        });
      }

      const orderResult = await pool.query(
        `
        select
          doo.*,

          'distributor'::text as portal_type,
          'distributor_orders'::text as source_table,
          doo.order_type::text as source_type,

          s.business_name as stockist_business_name,
          s.contact_person as stockist_contact_person,
          s.mobile as stockist_mobile,
          s.email as stockist_email,
          s.territory as stockist_territory,

          a.business_name as agency_business_name,
          a.contact_person as agency_contact_person,
          a.mobile as agency_mobile,
          a.email as agency_email,
          a.territory as agency_territory,

          up.full_name as user_name,
          up.email as user_email,
          up.mobile as user_mobile

        from public.distributor_orders doo

        left join public.stockists s
          on s.id = doo.stockist_id

        left join public.agencies a
          on a.id = doo.agency_id

        left join public.user_profiles up
          on up.id = doo.user_profile_id

        where doo.id = $1
        limit 1
        `,
        [orderId]
      );

      const itemsResult = await pool.query(
        `
        select *
        from public.distributor_order_items
        where order_id = $1
        order by created_at asc
        `,
        [orderId]
      );

      return res.json({
        success: true,
        data: {
          ...orderResult.rows[0],
          items: itemsResult.rows,
        },
      });
    }

    const orderResult = await pool.query(
      `
      select
        so.*,

        case
          when lower(coalesce(so.sub_channel, ''))
            in ('white_label', 'whitelabel')
            then 'whitelabel'

          when lower(
            coalesce(so.sub_channel, so.customer_type, 'household')
          ) = 'commercial'
            then 'commercial'

          else 'household'
        end as portal_type,

        up.full_name as customer_name,
        up.email as customer_email,
        up.mobile as profile_mobile,

        sl.name as location_name

      from public.sales_orders so

      left join public.user_profiles up
        on up.id = so.customer_id

      left join public.service_locations sl
        on sl.id = so.service_location_id

      where so.id = $1
        and ${salesPortalCondition(portalType, "so")}

      limit 1
      `,
      [orderId]
    );

    if (orderResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const itemsResult = await pool.query(
      `
      select *
      from public.sales_order_items
      where order_id = $1
      order by created_at asc
      `,
      [orderId]
    );

    return res.json({
      success: true,
      data: {
        ...orderResult.rows[0],
        items: itemsResult.rows,
      },
    });
  } catch (error) {
    console.error("ADMIN ORDER DETAIL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch order detail",
      error: error.message,
    });
  }
});

/**
 * PATCH /api/admin/orders/:portalType/:orderId/status
 */
router.patch("/:portalType/:orderId/status", async (req, res) => {
  let client;

  try {
    const portalType = normalizePortal(req.params.portalType);
    const { orderId } = req.params;

    const status = String(req.body.status || "").trim().toLowerCase();
    const note = req.body.note
      ? String(req.body.note).trim()
      : null;

    if (!PORTALS.has(portalType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid portal type",
      });
    }

    const allowedStatuses =
      portalType === "distributor"
        ? DISTRIBUTOR_STATUSES
        : SALES_STATUSES;

    if (!allowedStatuses.has(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order status",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const existingOrder = await findOrder(
      client,
      portalType,
      orderId,
      true
    );

    if (!existingOrder) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (isStockistPurchaseOrder(existingOrder)) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message:
          "Stockist purchase shipment and delivery are updated from the stockist portal because those actions update stockist inventory.",
      });
    }

    const orderTable = tableForOrder(portalType, existingOrder);

    const updateResult = await client.query(
      `
      update ${orderTable}
      set
        order_status = $1,
        updated_at = now()
      where id = $2
      returning *
      `,
      [status, orderId]
    );

    await createOrderEvent(client, {
      portalType,
      orderId,
      eventType: "status_changed",
      previousValue: existingOrder.order_status,
      newValue: status,
      note,
      createdBy: getAdminId(req),
    });

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Order status updated successfully",
      data: updateResult.rows[0],
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("ADMIN ORDER STATUS UPDATE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update order status",
      error: error.message,
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * PATCH /api/admin/orders/:portalType/:orderId/payment-status
 */
router.patch(
  "/:portalType/:orderId/payment-status",
  async (req, res) => {
    let client;

    try {
      const portalType = normalizePortal(req.params.portalType);
      const { orderId } = req.params;

      const paymentStatus = String(
        req.body.payment_status || ""
      )
        .trim()
        .toLowerCase();

      const note = req.body.note
        ? String(req.body.note).trim()
        : null;

      if (!PORTALS.has(portalType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid portal type",
        });
      }

      if (!PAYMENT_STATUSES.has(paymentStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment status",
        });
      }

      client = await pool.connect();
      await client.query("BEGIN");

      const existingOrder = await findOrder(
        client,
        portalType,
        orderId,
        true
      );

      if (!existingOrder) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      if (
        isStockistPurchaseOrder(existingOrder) &&
        !STOCKIST_PURCHASE_PAYMENT_STATUSES.has(paymentStatus)
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Stockist purchase payment status must be pending, paid, failed or refunded.",
        });
      }

      const orderTable = tableForOrder(portalType, existingOrder);

      const updateResult = await client.query(
        `
        update ${orderTable}
        set
          payment_status = $1,
          updated_at = now()
        where id = $2
        returning *
        `,
        [paymentStatus, orderId]
      );

      await createOrderEvent(client, {
        portalType,
        orderId,
        eventType: "payment_status_changed",
        previousValue: existingOrder.payment_status,
        newValue: paymentStatus,
        note,
        createdBy: getAdminId(req),
      });

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Payment status updated successfully",
        data: updateResult.rows[0],
      });
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
      }

      console.error("ADMIN PAYMENT STATUS UPDATE ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to update payment status",
        error: error.message,
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

/**
 * PATCH /api/admin/orders/:portalType/:orderId/delivery-status
 */
router.patch(
  "/:portalType/:orderId/delivery-status",
  async (req, res) => {
    let client;

    try {
      const portalType = normalizePortal(req.params.portalType);
      const { orderId } = req.params;

      const deliveryStatus = String(
        req.body.delivery_status || ""
      )
        .trim()
        .toLowerCase();

      const note = req.body.note
        ? String(req.body.note).trim()
        : null;

      if (!PORTALS.has(portalType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid portal type",
        });
      }

      if (!DELIVERY_STATUSES.has(deliveryStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid delivery status",
        });
      }

      client = await pool.connect();
      await client.query("BEGIN");

      const existingOrder = await findOrder(
        client,
        portalType,
        orderId,
        true
      );

      if (!existingOrder) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      if (isStockistPurchaseOrder(existingOrder)) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Stockist purchase delivery is confirmed by the stockist from the stockist portal because it updates stockist inventory.",
        });
      }

      const orderTable = tableForOrder(portalType, existingOrder);

      const updateResult = await client.query(
        `
        update ${orderTable}
        set
          delivery_status = $1,
          updated_at = now()
        where id = $2
        returning *
        `,
        [deliveryStatus, orderId]
      );

      await createOrderEvent(client, {
        portalType,
        orderId,
        eventType: "delivery_status_changed",
        previousValue: existingOrder.delivery_status,
        newValue: deliveryStatus,
        note,
        createdBy: getAdminId(req),
      });

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Delivery status updated successfully",
        data: updateResult.rows[0],
      });
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
      }

      console.error("ADMIN DELIVERY STATUS UPDATE ERROR:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to update delivery status",
        error: error.message,
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

/**
 * POST /api/admin/orders/:portalType/:orderId/notes
 */
router.post("/:portalType/:orderId/notes", async (req, res) => {
  let client;

  try {
    const portalType = normalizePortal(req.params.portalType);
    const { orderId } = req.params;
    const note = String(req.body.note || "").trim();

    if (!PORTALS.has(portalType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid portal type",
      });
    }

    if (!note) {
      return res.status(400).json({
        success: false,
        message: "note is required",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const existingOrder = await findOrder(
      client,
      portalType,
      orderId,
      false
    );

    if (!existingOrder) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    await createOrderEvent(client, {
      portalType,
      orderId,
      eventType: "admin_note",
      note,
      createdBy: getAdminId(req),
    });

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Admin note added successfully",
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("ADMIN ORDER NOTE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to add admin note",
      error: error.message,
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * GET /api/admin/orders/:portalType/:orderId/timeline
 */
router.get("/:portalType/:orderId/timeline", async (req, res) => {
  try {
    const portalType = normalizePortal(req.params.portalType);
    const { orderId } = req.params;

    if (!PORTALS.has(portalType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid portal type",
      });
    }

    const order = await findOrder(pool, portalType, orderId, false);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const eventsResult = await pool.query(
      `
      select
        aoe.*,
        up.full_name as created_by_name,
        up.email as created_by_email

      from public.admin_order_events aoe

      left join public.user_profiles up
        on up.id = aoe.created_by

      where aoe.portal_type = $1
        and aoe.order_id = $2

      order by aoe.created_at asc
      `,
      [portalType, orderId]
    );

    return res.json({
      success: true,
      data: [
        {
          event_type: "order_created",
          previous_value: null,
          new_value: order.order_status,
          note: `Order ${order.order_number} created`,
          created_at: order.created_at,
          system_event: true,
        },
        ...eventsResult.rows,
      ],
    });
  } catch (error) {
    console.error("ADMIN ORDER TIMELINE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch order timeline",
      error: error.message,
    });
  }
});

module.exports = router;