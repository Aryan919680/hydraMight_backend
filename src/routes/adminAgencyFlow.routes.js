const express = require("express");
const db = require("../config/db");

const {
  authenticate,
  authorize,
} = require("../middleware/auth.middleware");

const {
  releaseAgencyOrderReservations,
  shipAgencyOrderReservations,
} = require("../services/agencySupply.service");

const pool = db.pool || db;
const router = express.Router();

router.use(authenticate, authorize("admin", "operator"));

const text = (value) => String(value ?? "").trim();
const getAdminId = (req) => req.user?.id || null;

/**
 * Assign agency to Stockist or Admin fallback.
 *
 * PATCH /api/admin/distributors/agency-flow/agencies/:agencyId/supplier
 *
 * { "fulfillment_source": "stockist", "stockist_id": "uuid" }
 * OR
 * { "fulfillment_source": "admin" }
 */
router.patch(
  "/agencies/:agencyId/supplier",
  async (req, res) => {
    try {
      const stockistId = text(req.body.stockist_id) || null;

      /*
        stockist_id:
        - UUID => agency is permanently assigned to that Stockist
        - null => agency can browse all active Stockist catalogues
      */
      if (stockistId) {
        const stockistResult = await pool.query(
          `
          select id
          from public.stockists
          where id = $1
            and lower(status) = 'active'
          limit 1
          `,
          [stockistId]
        );

        if (stockistResult.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Active stockist was not found.",
          });
        }
      }

      const result = await pool.query(
        `
        update public.agencies
        set
          stockist_id = $1,
          fulfillment_source = 'stockist',
          updated_at = now()
        where id = $2
        returning *
        `,
        [stockistId, req.params.agencyId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Agency was not found.",
        });
      }

      return res.json({
        success: true,
        message: stockistId
          ? "Agency assigned to stockist successfully."
          : "Agency is now allowed to browse all Stockist catalogues.",
        data: result.rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          error.message || "Failed to update agency stockist assignment.",
      });
    }
  }
);

/**
 * Admin allocates distributor inventory to Stockist inventory.
 *
 * POST /api/admin/distributors/agency-flow/stockists/:stockistId/inventory/allocate
 *
 * { "product_id": "uuid", "quantity": 100 }
 */
router.post(
  "/stockists/:stockistId/inventory/allocate",
  async (req, res) => {
    let client;

    try {
      const productId = text(req.body.product_id);
      const quantity = Number(req.body.quantity);

      if (
        !productId ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "product_id and a positive whole quantity are required.",
        });
      }

      client = await pool.connect();
      await client.query("BEGIN");

      const stockistResult = await client.query(
        `
        select id
        from public.stockists
        where id = $1
          and status = 'active'
        for update
        `,
        [req.params.stockistId]
      );

      if (stockistResult.rowCount === 0) {
        throw new Error("Active stockist was not found.");
      }

      const mainInventoryResult = await client.query(
        `
        select
          id,
          coalesce(total_stock, 0) as total_stock
        from public.main_inventory
        where product_id = $1
          and is_active = true
        order by updated_at desc nulls last
        limit 1
        for update
        `,
        [productId]
      );

      if (mainInventoryResult.rowCount === 0) {
        throw new Error(
          "Main inventory was not found for the selected product."
        );
      }

      const mainInventory = mainInventoryResult.rows[0];

      if (Number(mainInventory.total_stock) < quantity) {
        throw new Error(
          `Main inventory is insufficient. Available: ${mainInventory.total_stock}, requested: ${quantity}.`
        );
      }

      const allocationsResult = await client.query(
        `
        select
          ia.id,
          coalesce(ia.available_stock, 0) as available_stock
        from public.inventory_allocations ia
        join public.inventory_channels ic
          on ic.id = ia.channel_id
        where ia.main_inventory_id = $1
          and ia.is_active = true
          and lower(coalesce(ic.code, ''))
            in ('distribution', 'distributor')
          and coalesce(ia.available_stock, 0) > 0
        order by ia.updated_at asc nulls last, ia.id
        for update of ia
        `,
        [mainInventory.id]
      );

      const available = allocationsResult.rows.reduce(
        (sum, row) => sum + Number(row.available_stock || 0),
        0
      );

      if (available < quantity) {
        throw new Error(
          `Distribution allocation is insufficient. Available: ${available}, requested: ${quantity}.`
        );
      }

      let remaining = quantity;

      for (const allocation of allocationsResult.rows) {
        if (remaining <= 0) {
          break;
        }

        const quantityToMove = Math.min(
          Number(allocation.available_stock),
          remaining
        );

        /*
          available_stock is generated in your inventory table.
          Do not update it directly.
        */
        await client.query(
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
          `,
          [quantityToMove, allocation.id]
        );

        remaining -= quantityToMove;
      }

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
        [quantity, mainInventory.id]
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
          last_received_at,
          created_at,
          updated_at
        )
        values (
          $1, $2, $3, 0, $3, 0,
          now(), now(), now()
        )

        on conflict (stockist_id, product_id)
        do update set
          total_stock =
            public.stockist_inventory.total_stock
            + excluded.total_stock,

          available_stock =
            public.stockist_inventory.available_stock
            + excluded.available_stock,

          last_received_at = now(),
          updated_at = now()

        returning *
        `,
        [
          req.params.stockistId,
          productId,
          quantity,
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message: "Inventory allocated to stockist successfully.",
        data: stockistInventoryResult.rows[0],
      });
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
      }

      return res.status(400).json({
        success: false,
        message:
          error.message ||
          "Failed to allocate inventory to stockist.",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

/**
 * ADMIN GIFTS AND BENEFITS
 */
router.get("/benefits", async (req, res) => {
  try {
    const result = await pool.query(
      `
      select
        benefit.*,
        agency.business_name as agency_business_name
      from public.agency_gifts_benefits benefit

      left join public.agencies agency
        on agency.id = benefit.agency_id

      order by benefit.created_at desc
      `
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch {
    return res.status(500).json({
      success: false,
      message: "Failed to load agency benefits.",
    });
  }
});

router.post("/benefits", async (req, res) => {
  try {
    const title = text(req.body.title);

    const benefitType = text(
      req.body.benefit_type || "benefit"
    ).toLowerCase();

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "title is required.",
      });
    }

    if (
      !["gift", "benefit", "offer", "incentive"].includes(
        benefitType
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "benefit_type must be gift, benefit, offer or incentive.",
      });
    }

    const result = await pool.query(
      `
      insert into public.agency_gifts_benefits (
        agency_id,
        title,
        benefit_type,
        short_description,
        description,
        benefit_value,
        image_url,
        terms_and_conditions,
        is_active,
        starts_at,
        ends_at,
        created_by,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        coalesce($9, true),
        $10, $11, $12,
        now(),
        now()
      )
      returning *
      `,
      [
        req.body.agency_id || null,
        title,
        benefitType,
        text(req.body.short_description) || null,
        text(req.body.description) || null,
        text(req.body.benefit_value) || null,
        text(req.body.image_url) || null,
        text(req.body.terms_and_conditions) || null,
        req.body.is_active,
        req.body.starts_at || null,
        req.body.ends_at || null,
        getAdminId(req),
      ]
    );

    return res.status(201).json({
      success: true,
      message:
        "Agency gift or benefit created successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message:
        error.message || "Failed to create agency benefit.",
    });
  }
});

module.exports = router;