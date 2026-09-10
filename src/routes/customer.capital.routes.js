const express = require("express");
const router = express.Router();

const db = require("../config/db");

const {
  authenticateCustomer,
} = require("../middleware/customerAuth.middleware");


router.use(authenticateCustomer);


/**
 * Calculate projected SIP value.
 *
 * This is only an illustrative calculation.
 * 12% annual return assumption by default.
 */
function calculateSipFutureValue(
  monthlyAmount,
  years,
  annualRate = 12
) {
  const monthlyRate = annualRate / 12 / 100;
  const months = years * 12;

  if (monthlyRate === 0) {
    return monthlyAmount * months;
  }

  const value =
    monthlyAmount *
    (((Math.pow(1 + monthlyRate, months) - 1) /
      monthlyRate) *
      (1 + monthlyRate));

  return Math.round(value);
}


/**
 * Generate readable capital account number.
 */
function generateAccountNumber() {
  const year = new Date()
    .getFullYear()
    .toString()
    .slice(-2);

  const part1 = Math.floor(
    1000 + Math.random() * 9000
  );

  const part2 = Math.floor(
    1000 + Math.random() * 9000
  );

  return `HM-CAP-${year}-${part1}-${part2}`;
}


/**
 * GET CAPITAL OVERVIEW
 *
 * GET /api/customer/capital/overview
 */
router.get("/overview", async (req, res) => {
  try {
    const customerId = req.customer.id;

    const leadResult = await db.query(
      `
      select
        id,
        customer_id,
        full_name,
        mobile,
        email,
        primary_goal,
        status,
        created_at,
        updated_at
      from capital_leads
      where customer_id = $1
      order by created_at desc
      limit 1
      `,
      [customerId]
    );

    const sipResult = await db.query(
      `
      select
        id,
        customer_id,
        lead_id,
        account_number,
        monthly_amount,
        tenure_years,
        debit_day,
        assumed_return_percent,
        projected_value,
        status,
        start_date,
        created_at,
        updated_at
      from capital_sip_plans
      where customer_id = $1
      order by created_at desc
      limit 1
      `,
      [customerId]
    );

    return res.json({
      success: true,

      data: {
        customer: {
          id: req.customer.id,
          full_name:
            req.customer.full_name || "",
          mobile:
            req.customer.mobile || "",
          email:
            req.customer.email || "",
        },

        lead:
          leadResult.rows[0] || null,

        sip:
          sipResult.rows[0] || null,
      },
    });
  } catch (error) {
    console.error(
      "Capital overview error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load capital information",
    });
  }
});


/**
 * CREATE / UPDATE LEAD
 *
 * POST /api/customer/capital/leads
 */
router.post("/leads", async (req, res) => {
  try {
    const customerId = req.customer.id;

const {
  full_name,
  mobile,
  email,
  service,
} = req.body;

const allowedServices = [
  "mutual_funds",
  "tax_saving",
  "child_future",
  "retirement",
  "fixed_deposits",
  "insurance",
  "bonds",
  "home_loan",
  "personal_loan",
  "business_loan",
  "loan_against_property",
  "balance_transfer",
  "commercial_property_loan",
  "education_loan",
  "used_car_loan",
  "tractor_loan",
  "used_bike_loan",
  "working_capital_loan",
  "overdraft_cash_credit",
];
  if (!service) {
  return res.status(400).json({
    success: false,
    message: "Service is required",
  });
}

   if (!allowedServices.includes(service)) {
  return res.status(400).json({
    success: false,
    message: "Invalid service selected",
  });
}

    const finalName =
      full_name ||
      req.customer.full_name;

    const finalMobile =
      mobile ||
      req.customer.mobile;

    const finalEmail =
      email ||
      req.customer.email ||
      null;

    if (!finalName) {
      return res.status(400).json({
        success: false,
        message:
          "Full name is required",
      });
    }

    if (!finalMobile) {
      return res.status(400).json({
        success: false,
        message:
          "Mobile number is required",
      });
    }

    const result = await db.query(
      `
      insert into capital_leads
      (
        customer_id,
        full_name,
        mobile,
        email,
        service,
        status,
        created_at,
        updated_at
      )
      values
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        'new',
        now(),
        now()
      )

      on conflict (customer_id)

      do update set
        full_name =
          excluded.full_name,

        mobile =
          excluded.mobile,

        email =
          excluded.email,

        service =
          excluded.service,

        status =
          'new',

        updated_at =
          now()

      returning *
      `,
      [
        customerId,
        finalName,
        finalMobile,
        finalEmail,
        service,
      ]
    );

    return res.json({
      success: true,
      message:
        "Capital profile saved successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error(
      "Capital lead error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to save capital profile",
    });
  }
});


/**
 * CREATE SIP
 *
 * POST /api/customer/capital/sips
 */
router.post("/sips", async (req, res) => {
  const client =
    await db.connect();

  try {
    await client.query("begin");

    const customerId =
      req.customer.id;

    const {
      lead_id,
      monthly_amount,
      tenure_years,
      debit_day = 1,
    } = req.body;

    const amount =
      Number(monthly_amount);

    const tenure =
      Number(tenure_years);

    const debitDay =
      Number(debit_day);

    if (
      !Number.isFinite(amount) ||
      amount < 500 ||
      amount > 50000
    ) {
      await client.query(
        "rollback"
      );

      return res.status(400).json({
        success: false,
        message:
          "Monthly SIP amount must be between ₹500 and ₹50,000",
      });
    }

    if (
      !Number.isInteger(tenure) ||
      tenure < 1 ||
      tenure > 40
    ) {
      await client.query(
        "rollback"
      );

      return res.status(400).json({
        success: false,
        message:
          "Tenure must be between 1 and 40 years",
      });
    }

    if (
      !Number.isInteger(debitDay) ||
      debitDay < 1 ||
      debitDay > 28
    ) {
      await client.query(
        "rollback"
      );

      return res.status(400).json({
        success: false,
        message:
          "Debit day must be between 1 and 28",
      });
    }

    let leadId = lead_id || null;

    if (leadId) {
      const leadResult =
        await client.query(
          `
          select id
          from capital_leads
          where id = $1
          and customer_id = $2
          limit 1
          `,
          [
            leadId,
            customerId,
          ]
        );

      if (
        leadResult.rows.length === 0
      ) {
        await client.query(
          "rollback"
        );

        return res.status(404).json({
          success: false,
          message:
            "Capital lead not found",
        });
      }
    } else {
      const leadResult =
        await client.query(
          `
          select id
          from capital_leads
          where customer_id = $1
          order by created_at desc
          limit 1
          `,
          [customerId]
        );

      if (
        leadResult.rows.length === 0
      ) {
        await client.query(
          "rollback"
        );

        return res.status(400).json({
          success: false,
          message:
            "Complete the Capital profile before creating a SIP",
        });
      }

      leadId =
        leadResult.rows[0].id;
    }

    const assumedReturn = 12;

    const projectedValue =
      calculateSipFutureValue(
        amount,
        tenure,
        assumedReturn
      );

    let accountNumber;
    let accountExists = true;

    while (accountExists) {
      accountNumber =
        generateAccountNumber();

      const existing =
        await client.query(
          `
          select id
          from capital_sip_plans
          where account_number = $1
          limit 1
          `,
          [accountNumber]
        );

      accountExists =
        existing.rows.length > 0;
    }

   const today = new Date();

let nextInvestmentDate = new Date(
  today.getFullYear(),
  today.getMonth(),
  debitDay
);

if (nextInvestmentDate <= today) {
  nextInvestmentDate = new Date(
    today.getFullYear(),
    today.getMonth() + 1,
    debitDay
  );
}

const nextInvestmentDateValue =
  nextInvestmentDate.toISOString().split("T")[0];

const result = await client.query(
  `
  insert into capital_sip_plans
  (
    customer_id,
    lead_id,
    account_number,
    monthly_amount,
    tenure_years,
    debit_day,
    assumed_return_percent,
    projected_value,
    expected_value,
    next_investment_date,
    status,
    created_at,
    updated_at
  )
  values
  (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $8,
    $9,
    'pending',
    now(),
    now()
  )
  returning *
  `,
  [
    customerId,
    leadId,
    accountNumber,
    amount,
    tenure,
    debitDay,
    assumedReturn,
    projectedValue,
    nextInvestmentDateValue,
  ]
);

    await client.query(
      `
      update capital_leads
      set
        status = 'converted',
        updated_at = now()
      where id = $1
      `,
      [leadId]
    );

    await client.query("commit");

    return res.status(201).json({
      success: true,
      message:
        "SIP plan created successfully",

      data: result.rows[0],
    });
  } catch (error) {
    await client.query(
      "rollback"
    );

    console.error(
      "Create Capital SIP error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to create SIP plan",
    });
  } finally {
    client.release();
  }
});


/**
 * GET CUSTOMER SIPs
 *
 * GET /api/customer/capital/sips
 */
router.get("/sips", async (req, res) => {
  try {
    const result = await db.query(
      `
      select
        id,
        lead_id,
        account_number,
        monthly_amount,
        tenure_years,
        debit_day,
        assumed_return_percent,
        projected_value,
        status,
        start_date,
        created_at,
        updated_at
      from capital_sip_plans
      where customer_id = $1
      order by created_at desc
      `,
      [req.customer.id]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error(
      "Get Capital SIPs error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load SIP plans",
    });
  }
});


module.exports = router;