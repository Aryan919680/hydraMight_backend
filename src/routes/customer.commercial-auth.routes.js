const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "hydramight_customer_dev_secret";
const JWT_EXPIRES_IN = process.env.CUSTOMER_JWT_EXPIRES_IN || "30d";

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

function isValidIndianPhone(phone) {
  return /^91[6-9]\d{9}$/.test(phone);
}

function getDefaultPassword(contactPerson) {
  const firstName = String(contactPerson || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();

  return `${firstName}@123`;
}

function createCommercialToken(user) {
  return jwt.sign(
    {
      id: user.id,
      mobile: user.mobile,
      email: user.email,
      full_name: user.full_name,
      user_type: user.user_type,
      customer_type: user.customer_type,

      company_name: user.company_name,
      contact_person: user.contact_person,
      gst_number: user.gst_number,
      commercial_profile_completed: user.commercial_profile_completed,
      commercial_approval_status: user.commercial_approval_status,
      must_change_password: user.must_change_password || false,
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
    }
  );
}

/**
 * POST /api/customer/commercial/signup-request
 *
 * Public API.
 * Commercial customer raises signup request.
 * Also creates/updates pending commercial customer master row.
 */
router.post("/signup-request", async (req, res) => {
  const client = await db.pool.connect();

  try {
    const {
      business_name,
      contact_person,
      gst_number,
      email,
      phone,
      business_type,
      address_line1,
      address_line2,
      city,
      state,
      pincode,
    } = req.body;

    if (!business_name || !String(business_name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Business name is required",
      });
    }

    if (!contact_person || !String(contact_person).trim()) {
      return res.status(400).json({
        success: false,
        message: "Contact person is required",
      });
    }

    if (!email || !String(email).includes("@")) {
      return res.status(400).json({
        success: false,
        message: "Valid email is required",
      });
    }

    const normalizedPhone = normalizePhone(phone);

    if (!isValidIndianPhone(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: "Valid Indian phone number is required",
      });
    }

    if (!address_line1 || !city || !state || !pincode) {
      return res.status(400).json({
        success: false,
        message: "Address line1, city, state and pincode are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const cleanBusinessName = String(business_name).trim();
    const cleanContactPerson = String(contact_person).trim();

    const billingAddress = {
      address_line1: String(address_line1).trim(),
      address_line2: address_line2 ? String(address_line2).trim() : null,
      city: String(city).trim(),
      state: String(state).trim(),
      pincode: String(pincode).trim(),
    };

    await client.query("BEGIN");

    console.log("COMMERCIAL SIGNUP REQUEST START:", {
      email: normalizedEmail,
      phone: normalizedPhone,
      business_name: cleanBusinessName,
    });

    /**
     * 1. Upsert signup request.
     */
    const signupResult = await client.query(
      `insert into commercial_signup_requests
       (
        business_name,
        contact_person,
        gst_number,
        email,
        phone,
        business_type,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        status,
        created_at,
        updated_at
       )
       values
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',now(),now())
       on conflict (email)
       do update set
        business_name = excluded.business_name,
        contact_person = excluded.contact_person,
        gst_number = excluded.gst_number,
        phone = excluded.phone,
        business_type = excluded.business_type,
        address_line1 = excluded.address_line1,
        address_line2 = excluded.address_line2,
        city = excluded.city,
        state = excluded.state,
        pincode = excluded.pincode,
        status = case
          when commercial_signup_requests.status = 'approved'
          then commercial_signup_requests.status
          else 'pending'
        end,
        updated_at = now()
       returning
        id,
        business_name,
        contact_person,
        gst_number,
        email,
        phone,
        business_type,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        status,
        created_at,
        updated_at`,
      [
        cleanBusinessName,
        cleanContactPerson,
        gst_number ? String(gst_number).trim() : null,
        normalizedEmail,
        normalizedPhone,
        business_type ? String(business_type).trim() : null,
        billingAddress.address_line1,
        billingAddress.address_line2,
        billingAddress.city,
        billingAddress.state,
        billingAddress.pincode,
      ]
    );

    const signupRequest = signupResult.rows[0];

    /**
     * 2. Upsert commercial customer master as pending.
     * user_profile_id will be null until admin approves.
     */
    const commercialCustomerResult = await client.query(
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
        created_at,
        updated_at
       )
       values
       (
        null,
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        'pending',
        now(),
        now()
       )
       on conflict (email)
       do update set
        business_name = excluded.business_name,
        contact_person = excluded.contact_person,
        gst_number = excluded.gst_number,
        phone = excluded.phone,
        address = excluded.address,
        status = case
          when commercial_customers.status = 'approved'
          then commercial_customers.status
          else 'pending'
        end,
        updated_at = now()
       returning *`,
      [
        cleanBusinessName,
        cleanContactPerson,
        gst_number ? String(gst_number).trim() : null,
        normalizedEmail,
        normalizedPhone,
        JSON.stringify(billingAddress),
      ]
    );

    console.log("COMMERCIAL SIGNUP CREATED:", {
      signup_request_id: signupRequest.id,
      signup_status: signupRequest.status,
      commercial_customer_id: commercialCustomerResult.rows[0]?.id,
      commercial_customer_status: commercialCustomerResult.rows[0]?.status,
    });

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Commercial signup request submitted successfully",
      data: {
        signup_request: signupRequest,
        commercial_customer: commercialCustomerResult.rows[0],
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Commercial signup request error:", {
      code: error.code,
      constraint: error.constraint,
      detail: error.detail,
      message: error.message,
    });

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to submit signup request",
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
 * POST /api/customer/commercial/login
 *
 * Approved commercial customer login.
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const result = await db.query(
      `select *
       from user_profiles
       where lower(email) = lower($1)
       and user_type = 'customer'
       and customer_type = 'commercial'
       limit 1`,
      [String(email).trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your account is not active",
      });
    }

    if (user.commercial_approval_status !== "approved") {
      return res.status(403).json({
        success: false,
        message: "Your commercial account is not approved yet",
      });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash || "");

    if (!ok) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    await db.query(
      `update user_profiles
       set last_login_at = now(),
           updated_at = now()
       where id = $1`,
      [user.id]
    );

    const token = createCommercialToken(user);

    res.json({
      success: true,
      message: "Commercial login successful",
      data: {
        token,
        user: {
          id: user.id,
          full_name: user.full_name,
          mobile: user.mobile,
          email: user.email,
          user_type: user.user_type,
          customer_type: user.customer_type,
          company_name: user.company_name,
          gst_number: user.gst_number,
          contact_person: user.contact_person,
          business_email: user.business_email,
          business_phone: user.business_phone,
          business_type: user.business_type,
          billing_address: user.billing_address,
          delivery_address: user.delivery_address,
          commercial_profile_completed: user.commercial_profile_completed,
          commercial_approval_status: user.commercial_approval_status,
          must_change_password: user.must_change_password,
        },
      },
    });
  } catch (error) {
    console.error("Commercial login error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Commercial login failed",
    });
  }
});

module.exports = router;