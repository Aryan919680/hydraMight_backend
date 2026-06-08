const express = require("express");
const { pool } = require("../config/db");

const router = express.Router();

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

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

/**
 * Agency raises signup request using referral code
 * POST /api/distributor/agency-requests
 */
/**
 * Agency raises signup request
 * Referral code is optional.
 *
 * POST /api/distributor/agency-requests
 */
router.post("/", async (req, res) => {
  try {
    const requiredFields = [
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
      referral_code,
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

    const cleanReferralCode = referral_code
      ? String(referral_code).trim().toUpperCase()
      : null;

    let matchedStockistId = null;
    let matchedTerritory = null;
    let matchedStockist = null;

    /**
     * Referral code is optional.
     * If provided, validate and auto-match stockist.
     */
    if (cleanReferralCode) {
      const stockistResult = await pool.query(
        `
        select
          id as stockist_id,
          business_name,
          territory,
          status as stockist_status
        from public.stockists
        where referral_code = $1
        limit 1
        `,
        [cleanReferralCode]
      );

      if (stockistResult.rowCount === 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid referral code",
        });
      }

      matchedStockist = stockistResult.rows[0];

      if (matchedStockist.stockist_status !== "active") {
        return res.status(400).json({
          success: false,
          message: "Referral stockist is inactive",
        });
      }

      matchedStockistId = matchedStockist.stockist_id;
      matchedTerritory = matchedStockist.territory;
    }

    const existingUser = await pool.query(
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
      return res.status(409).json({
        success: false,
        message: "User with same email or mobile already exists",
      });
    }

    const existingPending = await pool.query(
      `
      select id
      from public.agency_signup_requests
      where status = 'pending'
        and (lower(email) = lower($1) or mobile = $2)
      limit 1
      `,
      [email, mobile]
    );

    if (existingPending.rowCount > 0) {
      return res.status(409).json({
        success: false,
        message: "Agency request already pending for this email or mobile",
      });
    }

    const result = await pool.query(
      `
      insert into public.agency_signup_requests (
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
        matched_stockist_id,
        matched_territory
      )
      values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        'pending',
        $12,
        $13
      )
      returning *
      `,
      [
        cleanReferralCode,
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
        matchedStockistId,
        matchedTerritory,
      ]
    );

    return res.status(201).json({
      success: true,
      message: cleanReferralCode
        ? "Agency request submitted and stockist matched by referral code"
        : "Agency request submitted successfully",
      data: {
        request: result.rows[0],
        matched_stockist: matchedStockist,
      },
    });
  } catch (error) {
    console.error("CREATE AGENCY REQUEST ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to submit agency request",
      error: error.message,
    });
  }
});



module.exports = router;