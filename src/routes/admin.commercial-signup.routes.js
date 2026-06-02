const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../config/db");

const router = express.Router();

function normalizePhone(phone) {
  if (!phone) return "";

  let value = String(phone).trim();
  value = value.replace(/[\s\-()]/g, "");

  if (value.startsWith("+")) {
    value = value.substring(1);
  }

  if (/^[6-9]\d{9}$/.test(value)) {
    value = `91${value}`;
  }

  return value;
}

function getDefaultPassword(contactPerson) {
  const firstName = String(contactPerson || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();

  return `${firstName}@123`;
}

/**
 * GET /api/admin/commercial-signups
 */
router.get("/", async (req, res) => {
  try {
    const { status = "pending", limit = 50, offset = 0 } = req.query;

    const conditions = [];
    const params = [];

    if (status && status !== "all") {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    params.push(Number(limit));
    const limitParam = `$${params.length}`;

    params.push(Number(offset));
    const offsetParam = `$${params.length}`;

    const whereClause = conditions.length
      ? `where ${conditions.join(" and ")}`
      : "";

    const result = await db.query(
      `select *
       from commercial_signup_requests
       ${whereClause}
       order by created_at desc
       limit ${limitParam} offset ${offsetParam}`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Commercial signup list error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch commercial signup requests",
    });
  }
});

/**
 * GET /api/admin/commercial-signups/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `select *
       from commercial_signup_requests
       where id = $1
       limit 1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Signup request not found",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Commercial signup detail error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch signup request",
    });
  }
});

/**
 * POST /api/admin/commercial-signups/:id/approve
 *
 * Approves request and creates/updates commercial customer login.
 *
 * Important:
 * - Does NOT block already approved requests.
 * - This allows repair if commercial_customers is still pending.
 * - Updates commercial_customers by email/phone first.
 */
router.post("/:id/approve", async (req, res) => {
  const client = await db.pool.connect();
console.log("APPROVE API HIT:", req.params.id, req.body);
  try {
    const { admin_remarks } = req.body;

    await client.query("BEGIN");

    const requestResult = await client.query(
      `select *
       from commercial_signup_requests
       where id = $1
       for update`,
      [req.params.id]
    );

    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Signup request not found",
      });
    }

    const request = requestResult.rows[0];
console.log("SIGNUP REQUEST FOUND:", {
  id: request.id,
  email: request.email,
  phone: request.phone,
  status: request.status,
});
    if (request.status === "rejected") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Rejected request cannot be approved",
      });
    }

    const defaultPassword = getDefaultPassword(request.contact_person);
    const passwordHash = await bcrypt.hash(defaultPassword, 10);

    const normalizedPhone = normalizePhone(request.phone);
    const email = String(request.email || "").trim().toLowerCase();

    const billingAddress = {
      address_line1: request.address_line1 || null,
      address_line2: request.address_line2 || null,
      city: request.city || null,
      state: request.state || null,
      pincode: request.pincode || null,
    };

    /**
     * Prefer existing user by email first.
     * Avoid accidentally linking to another user just because phone matched.
     */
    let existingUserResult = await client.query(
      `select *
       from user_profiles
       where lower(email) = lower($1)
       limit 1`,
      [email]
    );

    if (existingUserResult.rows.length === 0 && normalizedPhone) {
      existingUserResult = await client.query(
        `select *
         from user_profiles
         where mobile = $1
         limit 1`,
        [normalizedPhone]
      );
    }

    let user;

    if (existingUserResult.rows.length > 0) {
      const existingUser = existingUserResult.rows[0];

      const updateUserResult = await client.query(
        `update user_profiles
         set
          full_name = $1,
          mobile = $2,
          email = $3,
          user_type = 'customer',
          customer_type = 'commercial',
          status = 'active',

          company_name = $4,
          gst_number = $5,
          contact_person = $6,
          business_email = $3,
          business_phone = $2,
          business_type = $7,
          billing_address = $8::jsonb,
          delivery_address = $8::jsonb,

          commercial_profile_completed = true,
          commercial_approval_status = 'approved',

          password_hash = $9,
          must_change_password = true,

          updated_at = now()
         where id = $10
         returning *`,
        [
          request.contact_person,
          normalizedPhone,
          email,
          request.business_name,
          request.gst_number,
          request.contact_person,
          request.business_type,
          JSON.stringify(billingAddress),
          passwordHash,
          existingUser.id,
        ]
      );

      user = updateUserResult.rows[0];
    } else {
      const insertUserResult = await client.query(
        `insert into user_profiles
         (
          id,
          full_name,
          mobile,
          email,
          user_type,
          customer_type,
          status,

          company_name,
          gst_number,
          contact_person,
          business_email,
          business_phone,
          business_type,
          billing_address,
          delivery_address,

          commercial_profile_completed,
          commercial_approval_status,

          password_hash,
          must_change_password,

          is_mobile_verified,
          login_provider,

          created_at,
          updated_at
         )
         values
         (
          uuid_generate_v4(),
          $1,
          $2,
          $3,
          'customer',
          'commercial',
          'active',

          $4,
          $5,
          $6,
          $3,
          $2,
          $7,
          $8::jsonb,
          $8::jsonb,

          true,
          'approved',

          $9,
          true,

          false,
          'email_password',

          now(),
          now()
         )
         returning *`,
        [
          request.contact_person,
          normalizedPhone,
          email,
          request.business_name,
          request.gst_number,
          request.contact_person,
          request.business_type,
          JSON.stringify(billingAddress),
          passwordHash,
        ]
      );

      user = insertUserResult.rows[0];
    }

    const approvedBy = req.user?.id || null;

    /**
     * Update existing pending commercial customer first.
     * This changes status from pending to approved.
     */
    let commercialCustomerResult = await client.query(
      `update commercial_customers
       set
        user_profile_id = $1,
        business_name = $2,
        contact_person = $3,
        gst_number = $4,
        email = $5,
        phone = $6,
        address = $7::jsonb,
        status = 'approved',
        approved_by = $8,
        approved_at = now(),
        updated_at = now()
       where lower(email) = lower($5)
          or phone = $6
       returning *`,
      [
        user.id,
        request.business_name,
        request.contact_person,
        request.gst_number,
        email,
        normalizedPhone,
        JSON.stringify(billingAddress),
        approvedBy,
      ]
    );

    /**
     * If no pending commercial customer exists, create approved one.
     */
    if (commercialCustomerResult.rows.length === 0) {
      commercialCustomerResult = await client.query(
        `insert into commercial_customers
         (
          user_profile_id,
          business_name,
          contact_person,
          gst_number,
          email,
          phone,
          address,
          status,
          approved_by,
          approved_at,
          created_at,
          updated_at
         )
         values
         (
          $1,$2,$3,$4,$5,$6,$7::jsonb,'approved',$8,now(),now(),now()
         )
         returning *`,
        [
          user.id,
          request.business_name,
          request.contact_person,
          request.gst_number,
          email,
          normalizedPhone,
          JSON.stringify(billingAddress),
          approvedBy,
        ]
      );
    }

    console.log("COMMERCIAL UPDATE ROW COUNT:", commercialCustomerResult.rows.length);
console.log("COMMERCIAL UPDATE RESULT:", commercialCustomerResult.rows[0]);
console.log("COMMERCIAL INSERT RESULT:", commercialCustomerResult.rows[0]);
    const updateRequestResult = await client.query(
      `update commercial_signup_requests
       set
        status = 'approved',
        approved_by = $1,
        approved_at = coalesce(approved_at, now()),
        admin_remarks = $2,
        created_user_id = $3,
        updated_at = now()
       where id = $4
       returning *`,
      [approvedBy, admin_remarks || null, user.id, request.id]
    );

    console.log("COMMERCIAL APPROVAL COMPLETED:", {
      signup_request_id: updateRequestResult.rows[0]?.id,
      signup_status: updateRequestResult.rows[0]?.status,
      user_id: user.id,
      commercial_customer_id: commercialCustomerResult.rows[0]?.id,
      commercial_customer_status: commercialCustomerResult.rows[0]?.status,
      commercial_customer_user_profile_id:
        commercialCustomerResult.rows[0]?.user_profile_id,
    });

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Commercial signup approved and login created",
      data: {
        request: updateRequestResult.rows[0],
        user: {
          id: user.id,
          company_name: user.company_name,
          contact_person: user.contact_person,
          email: user.email,
          mobile: user.mobile,
          customer_type: user.customer_type,
          commercial_approval_status: user.commercial_approval_status,
          must_change_password: user.must_change_password,
        },
        commercial_customer: commercialCustomerResult.rows[0],

        /*
          For development/admin display only.
          In production, send this by email/SMS and do not expose in API response.
        */
        default_password: defaultPassword,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Approve commercial signup error:", {
      code: error.code,
      constraint: error.constraint,
      detail: error.detail,
      message: error.message,
    });

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to approve commercial signup",
      db_error: {
        code: error.code,
        constraint: error.constraint,
        detail: error.detail,
      },
    });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/commercial-signups/:id/reject
 */
router.post("/:id/reject", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const { admin_remarks } = req.body;

    await client.query("BEGIN");

    const requestResult = await client.query(
      `update commercial_signup_requests
       set
        status = 'rejected',
        rejected_by = $1,
        rejected_at = now(),
        admin_remarks = $2,
        updated_at = now()
       where id = $3
       and status = 'pending'
       returning *`,
      [req.user?.id || null, admin_remarks || null, req.params.id]
    );

    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Pending signup request not found",
      });
    }

    const request = requestResult.rows[0];

    await client.query(
      `update commercial_customers
       set
        status = 'rejected',
        rejected_reason = $1,
        updated_at = now()
       where lower(email) = lower($2)
          or phone = $3`,
      [
        admin_remarks || "Commercial signup rejected",
        request.email,
        normalizePhone(request.phone),
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Commercial signup rejected",
      data: request,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Reject commercial signup error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to reject commercial signup",
    });
  } finally {
    client.release();
  }
});

module.exports = router;