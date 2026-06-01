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
 * Approves request and creates commercial customer login.
 */
router.post("/:id/approve", async (req, res) => {
  const client = await db.pool.connect();

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

    if (request.status === "approved") {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Signup request is already approved",
      });
    }

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
    const email = String(request.email).trim().toLowerCase();

    const billingAddress = {
      address_line1: request.address_line1,
      address_line2: request.address_line2,
      city: request.city,
      state: request.state,
      pincode: request.pincode,
    };

    const existingUserResult = await client.query(
      `select *
       from user_profiles
       where lower(email) = lower($1)
       or mobile = $2
       limit 1`,
      [email, normalizedPhone]
    );

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
          billing_address = $8,
          delivery_address = $8,

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
          billingAddress,
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
          $8,
          $8,

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
          billingAddress,
          passwordHash,
        ]
      );

      user = insertUserResult.rows[0];
    }

    const approvedBy = req.user?.id || null;

    const updateRequestResult = await client.query(
      `update commercial_signup_requests
       set
        status = 'approved',
        approved_by = $1,
        approved_at = now(),
        admin_remarks = $2,
        created_user_id = $3,
        updated_at = now()
       where id = $4
       returning *`,
      [approvedBy, admin_remarks || null, user.id, request.id]
    );

    await client.query("COMMIT");

    res.json({
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

        /*
          For development/admin display only.
          In production, send this by email/SMS and do not expose in API response.
        */
        default_password: defaultPassword,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Approve commercial signup error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to approve commercial signup",
    });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/commercial-signups/:id/reject
 */
router.post("/:id/reject", async (req, res) => {
  try {
    const { admin_remarks } = req.body;

    const result = await db.query(
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

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending signup request not found",
      });
    }

    res.json({
      success: true,
      message: "Commercial signup rejected",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Reject commercial signup error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Failed to reject commercial signup",
    });
  }
});

module.exports = router;