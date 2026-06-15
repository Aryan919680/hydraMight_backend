const express = require("express");
const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");
const db = require("../config/db");
const pool = db.pool || db;

const router = express.Router();

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const generateDefaultPassword = (contactPerson) => {
  const firstName = String(contactPerson || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();

  return `${firstName}@123`;
};

const validateRequired = (fields, body) => {
  const missing = [];

  for (const field of fields) {
    if (
      body[field] === undefined ||
      body[field] === null ||
      String(body[field]).trim() === ""
    ) {
      missing.push(field);
    }
  }

  return missing;
};


const generateReferralCode = (businessName) => {
  const prefix = String(businessName || "STK")
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 4)
    .toUpperCase();

  const random = Math.random().toString(36).substring(2, 8).toUpperCase();

  return `${prefix}${random}`;
};

/**
 * Admin Create Stockist
 * POST /api/admin/distributors/stockists
 */
router.post("/stockists", async (req, res) => {
  let client;

  try {
    client = await pool.connect();

    const requiredFields = [
      "territory",
      "gst_number",
      "business_name",
      "contact_person",
      "mobile",
      "email",
      "address_line1",
      "state",
    ];

    const missing = validateRequired(requiredFields, req.body);

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
        missing,
      });
    }

    const {
      territory,
      gst_number,
      business_name,
      contact_person,
      mobile,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
    } = req.body;

    const email = normalizeEmail(req.body.email);
    const defaultPassword = generateDefaultPassword(contact_person);
    const passwordHash = await bcrypt.hash(defaultPassword, 10);
    const userId = randomUUID();

    await client.query("BEGIN");

    const existingUser = await client.query(
      `
      select id
      from public.user_profiles
      where lower(email) = lower($1)
         or mobile = $2
      limit 1
      `,
      [email, mobile]
    );

    if (existingUser.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "User with same email or mobile already exists",
      });
    }

    let referralCode = generateReferralCode(business_name);

    let referralExists = await client.query(
      `
      select id
      from public.stockists
      where referral_code = $1
      limit 1
      `,
      [referralCode]
    );

    while (referralExists.rowCount > 0) {
      referralCode = generateReferralCode(business_name);
      referralExists = await client.query(
        `
        select id
        from public.stockists
        where referral_code = $1
        limit 1
        `,
        [referralCode]
      );
    }

    const userResult = await client.query(
      `
      insert into public.user_profiles (
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        password_hash,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4,
        'stockist',
        'distributor',
        'active',
        $5,
        now(),
        now()
      )
      returning id, full_name, mobile, email, user_type, customer_type, status
      `,
      [userId, contact_person, mobile, email, passwordHash]
    );

    const stockistResult = await client.query(
      `
      insert into public.stockists (
        user_profile_id,
        territory,
        referral_code,
        gst_number,
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        status,
        created_by
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        'active',
        $14
      )
      returning *
      `,
      [
        userId,
        String(territory).trim(),
        referralCode,
        String(gst_number).trim().toUpperCase(),
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2 || null,
        city || null,
        state,
        pincode || null,
        req.user?.id || req.admin?.id || null,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Stockist created successfully",
      data: {
        user: userResult.rows[0],
        stockist: stockistResult.rows[0],
        login: {
          email,
          default_password: defaultPassword,
        },
        referral_code: referralCode,
      },
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("CREATE STOCKIST ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Duplicate email, mobile, GST or referral code",
        detail: error.detail,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create stockist",
      error: error.message,
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * Admin Get Stockists
 * GET /api/admin/distributors/stockists
 */
router.get("/stockists", async (req, res) => {
  try {
    const { search = "", status = "", limit = 20, offset = 0 } = req.query;

    const params = [];
    const where = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`
        (
          s.business_name ilike $${params.length}
          or s.contact_person ilike $${params.length}
          or s.email ilike $${params.length}
          or s.mobile ilike $${params.length}
          or s.gst_number ilike $${params.length}
          or s.referral_code ilike $${params.length}
          or s.territory ilike $${params.length}
        )
      `);
    }

    if (status) {
      params.push(status);
      where.push(`s.status = $${params.length}`);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    params.push(Number(limit));
    const limitIndex = params.length;

    params.push(Number(offset));
    const offsetIndex = params.length;

    const result = await pool.query(
      `
      select
        s.*,
        u.full_name,
        u.user_type,
        u.customer_type,
        u.status as user_status,
        count(a.id)::int as agency_count
      from public.stockists s
      left join public.user_profiles u on u.id = s.user_profile_id
      left join public.agencies a on a.stockist_id = s.id
      ${whereSql}
      group by s.id, u.id
      order by s.created_at desc
      limit $${limitIndex}
      offset $${offsetIndex}
      `,
      params
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET STOCKISTS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch stockists",
      error: error.message,
    });
  }
});

/**
 * Admin Create Agency Under Stockist
 * POST /api/admin/distributors/agencies
 */
router.post("/agencies",  async (req, res) => {
  let client;

  try {
    client = await pool.connect();
    const requiredFields = [
      "stockist_id",
      "gst_number",
      "business_name",
      "contact_person",
      "mobile",
      "email",
      "address_line1",
      "state",
    ];

    const missing = validateRequired(requiredFields, req.body);

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
        missing,
      });
    }

    const {
      stockist_id,
      gst_number,
      business_name,
      contact_person,
      mobile,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
    } = req.body;

    const email = normalizeEmail(req.body.email);
    const defaultPassword = generateDefaultPassword(contact_person);
    const passwordHash = await bcrypt.hash(defaultPassword, 10);
    const userId = randomUUID();

    await client.query("BEGIN");

    const stockistCheck = await client.query(
      `
      select id, status
      from public.stockists
      where id = $1
      `,
      [stockist_id]
    );

    if (stockistCheck.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Parent stockist not found",
      });
    }

    if (stockistCheck.rows[0].status !== "active") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Cannot create agency under inactive stockist",
      });
    }

    const existingUser = await client.query(
      `
      select id
      from public.user_profiles
      where lower(email) = lower($1)
         or mobile = $2
      limit 1
      `,
      [email, mobile]
    );

    if (existingUser.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "User with same email or mobile already exists",
      });
    }

    const userResult = await client.query(
      `
      insert into public.user_profiles (
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        password_hash,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4,
        'agency',
        'distributor',
        'active',
        $5,
        now(),
        now()
      )
      returning id, full_name, mobile, email, user_type, customer_type, status
      `,
      [
        userId,
        contact_person,
        mobile,
        email,
        passwordHash,
      ]
    );

    const agencyResult = await client.query(
      `
      insert into public.agencies (
        stockist_id,
        user_profile_id,
        gst_number,
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        status,
        created_by
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        'active',
        $13
      )
      returning *
      `,
      [
        stockist_id,
        userId,
        String(gst_number).trim().toUpperCase(),
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2 || null,
        city || null,
        state,
        pincode || null,
        req.user?.id || req.admin?.id || null,
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Agency created successfully",
      data: {
        user: userResult.rows[0],
        agency: agencyResult.rows[0],
        login: {
          email,
          default_password: defaultPassword,
        },
      },
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("CREATE AGENCY ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Duplicate GST, email or mobile already exists",
        detail: error.detail,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create agency",
      error: error.message,
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * Admin Get Agencies
 * GET /api/admin/distributors/agencies
 */
router.get("/agencies",  async (req, res) => {
  try {
    const {
      search = "",
      stockist_id = "",
      status = "",
      limit = 20,
      offset = 0,
    } = req.query;

    const params = [];
    const where = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`
        (
          a.business_name ilike $${params.length}
          or a.contact_person ilike $${params.length}
          or a.email ilike $${params.length}
          or a.mobile ilike $${params.length}
          or a.gst_number ilike $${params.length}
        )
      `);
    }

    if (stockist_id) {
      params.push(stockist_id);
      where.push(`a.stockist_id = $${params.length}`);
    }

    if (status) {
      params.push(status);
      where.push(`a.status = $${params.length}`);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    params.push(Number(limit));
    const limitIndex = params.length;

    params.push(Number(offset));
    const offsetIndex = params.length;

    const result = await pool.query(
      `
      select
        a.*,
        u.full_name,
        u.user_type,
        u.customer_type,
        u.status as user_status,
        s.business_name as stockist_business_name
      from public.agencies a
      join public.user_profiles u on u.id = a.user_profile_id
      join public.stockists s on s.id = a.stockist_id
      ${whereSql}
      order by a.created_at desc
      limit $${limitIndex}
      offset $${offsetIndex}
      `,
      params
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET AGENCIES ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch agencies",
      error: error.message,
    });
  }
});

/**
 * Admin Get Agencies By Stockist
 * GET /api/admin/distributors/stockists/:stockistId/agencies
 */
router.get("/stockists/:stockistId/agencies", async (req, res) => {
  try {
    const result = await pool.query(
      `
      select
        a.*,
        u.status as user_status
      from public.agencies a
      join public.user_profiles u on u.id = a.user_profile_id
      where a.stockist_id = $1
      order by a.created_at desc
      `,
      [req.params.stockistId]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET STOCKIST AGENCIES ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch agencies",
      error: error.message,
    });
  }
});

/**
 * GET /api/admin/distributors/agency-requests?status=pending
 */
router.get("/agency-requests", async (req, res) => {
  try {
    const { status = "pending", search = "", limit = 20, offset = 0 } = req.query;

    const params = [];
    const where = [];

    if (status) {
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      where.push(`
        (
          r.business_name ilike $${params.length}
          or r.contact_person ilike $${params.length}
          or r.email ilike $${params.length}
          or r.mobile ilike $${params.length}
          or r.gst_number ilike $${params.length}
          or r.referral_code ilike $${params.length}
          or r.matched_territory ilike $${params.length}
          or ms.business_name ilike $${params.length}
          or ast.business_name ilike $${params.length}
        )
      `);
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    params.push(Number(limit));
    const limitIndex = params.length;

    params.push(Number(offset));
    const offsetIndex = params.length;

    const result = await pool.query(
      `
      select
        r.*,

        ms.business_name as matched_stockist_name,
        ms.referral_code as matched_stockist_referral_code,
        ms.territory as matched_stockist_territory,

        ast.business_name as assigned_stockist_name,
        ast.territory as assigned_stockist_territory

      from public.agency_signup_requests r
      left join public.stockists ms on ms.id = r.matched_stockist_id
      left join public.stockists ast on ast.id = r.assigned_stockist_id
      ${whereSql}
      order by r.created_at desc
      limit $${limitIndex}
      offset $${offsetIndex}
      `,
      params
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("GET AGENCY REQUESTS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch agency requests",
      error: error.message,
    });
  }
});


/**
 * Admin approves agency request.
 * If request has matched_stockist_id, use it.
 * Otherwise admin must send stockist_id in body.
 *
 * POST /api/admin/distributors/agency-requests/:requestId/approve
 */
router.post("/agency-requests/:requestId/approve", async (req, res) => {
  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const { requestId } = req.params;
    const { stockist_id } = req.body || {};

    const requestResult = await client.query(
      `
      select *
      from public.agency_signup_requests
      where id = $1
      for update
      `,
      [requestId]
    );

    if (requestResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Agency request not found",
      });
    }

    const request = requestResult.rows[0];

    if (request.status !== "pending") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: `Agency request is already ${request.status}`,
      });
    }

    /**
     * Priority:
     * 1. stockist_id from admin body
     * 2. matched_stockist_id from referral code
     */
    const finalStockistId = stockist_id || request.matched_stockist_id;

    if (!finalStockistId) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Please assign a stockist before approving this agency request",
      });
    }

    const stockistResult = await client.query(
      `
      select
        id,
        territory,
        status,
        referral_code,
        business_name
      from public.stockists
      where id = $1
      limit 1
      `,
      [finalStockistId]
    );

    if (stockistResult.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Selected stockist not found",
      });
    }

    const stockist = stockistResult.rows[0];

    if (stockist.status !== "active") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Selected stockist is inactive",
      });
    }

    const existingUser = await client.query(
      `
      select id
      from public.user_profiles
      where lower(email) = lower($1)
         or mobile = $2
      limit 1
      `,
      [request.email, request.mobile]
    );

    if (existingUser.rowCount > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "User with same email or mobile already exists",
      });
    }

    const userId = randomUUID();
    const defaultPassword = generateDefaultPassword(request.contact_person);
    const passwordHash = await bcrypt.hash(defaultPassword, 10);

    const userResult = await client.query(
      `
      insert into public.user_profiles (
        id,
        full_name,
        mobile,
        email,
        user_type,
        customer_type,
        status,
        password_hash,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4,
        'agency',
        'distributor',
        'active',
        $5,
        now(),
        now()
      )
      returning id, full_name, mobile, email, user_type, customer_type, status
      `,
      [
        userId,
        request.contact_person,
        request.mobile,
        request.email,
        passwordHash,
      ]
    );

    const agencyResult = await client.query(
      `
      insert into public.agencies (
        stockist_id,
        user_profile_id,
        territory,
        referral_code,
        gst_number,
        business_name,
        contact_person,
        mobile,
        email,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        status,
        created_by
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14,
        'active',
        $15
      )
      returning *
      `,
      [
        stockist.id,
        userId,
        stockist.territory,
        request.referral_code || null,
        request.gst_number,
        request.business_name,
        request.contact_person,
        request.mobile,
        request.email,
        request.address_line1,
        request.address_line2,
        request.city,
        request.state,
        request.pincode,
        req.user?.id || req.admin?.id || null,
      ]
    );

    const updateRequestResult = await client.query(
      `
      update public.agency_signup_requests
      set
        status = 'approved',
        assigned_stockist_id = $1,
        assigned_territory = $2,
        matched_stockist_id = coalesce(matched_stockist_id, $1),
        matched_territory = coalesce(matched_territory, $2),
        approved_by = $3,
        approved_at = now(),
        updated_at = now()
      where id = $4
      returning *
      `,
      [
        stockist.id,
        stockist.territory,
        req.user?.id || req.admin?.id || null,
        requestId,
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Agency request approved successfully",
      data: {
        request: updateRequestResult.rows[0],
        user: userResult.rows[0],
        agency: agencyResult.rows[0],
        assigned_stockist: {
          id: stockist.id,
          business_name: stockist.business_name,
          territory: stockist.territory,
          referral_code: stockist.referral_code,
        },
        login: {
          email: request.email,
          default_password: defaultPassword,
        },
      },
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("APPROVE AGENCY REQUEST ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Duplicate email, mobile or GST",
        detail: error.detail,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to approve agency request",
      error: error.message,
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/agency-requests/:requestId/reject", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { rejection_reason } = req.body;

    const result = await pool.query(
      `
      update public.agency_signup_requests
      set
        status = 'rejected',
        rejected_by = $1,
        rejected_at = now(),
        rejection_reason = $2,
        updated_at = now()
      where id = $3
        and status = 'pending'
      returning *
      `,
      [
        req.user?.id || req.admin?.id || null,
        rejection_reason || null,
        requestId,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending agency request not found",
      });
    }

    return res.json({
      success: true,
      message: "Agency request rejected successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("REJECT AGENCY REQUEST ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to reject agency request",
      error: error.message,
    });
  }
});

module.exports = router;