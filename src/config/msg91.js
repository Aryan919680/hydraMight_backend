const axios = require("axios");

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;
const MSG91_OTP_EXPIRY = process.env.MSG91_OTP_EXPIRY || "5";
const MSG91_OTP_LENGTH = process.env.MSG91_OTP_LENGTH || "4";

function normalizeIndianMobile(mobile) {
  const raw = String(mobile || "").replace(/\D/g, "");

  if (!raw) return null;

  if (raw.length === 10) {
    return `91${raw}`;
  }

  if (raw.length === 12 && raw.startsWith("91")) {
    return raw;
  }

  return null;
}

async function sendOtp(mobile) {
  if (!MSG91_AUTH_KEY || !MSG91_TEMPLATE_ID) {
    throw new Error("MSG91 configuration missing");
  }

  const normalizedMobile = normalizeIndianMobile(mobile);

  if (!normalizedMobile) {
    throw new Error("Invalid mobile number");
  }

  const response = await axios.get("https://control.msg91.com/api/v5/otp", {
    params: {
      mobile: normalizedMobile,
      template_id: MSG91_TEMPLATE_ID,
      otp_expiry: MSG91_OTP_EXPIRY,
      otp_length: MSG91_OTP_LENGTH,
    },
    headers: {
      authkey: MSG91_AUTH_KEY,
    },
    timeout: 15000,
  });

  console.log("MSG91 send OTP response:", response.data);
  return {
    mobile: normalizedMobile,
    response: response.data,
  };
}

async function verifyOtp(mobile, otp) {
  if (!MSG91_AUTH_KEY) {
    throw new Error("MSG91 configuration missing");
  }

  const normalizedMobile = normalizeIndianMobile(mobile);

  if (!normalizedMobile) {
    throw new Error("Invalid mobile number");
  }

  const response = await axios.get(
    "https://control.msg91.com/api/v5/otp/verify",
    {
      params: {
        mobile: normalizedMobile,
        otp,
      },
      headers: {
        authkey: MSG91_AUTH_KEY,
      },
      timeout: 15000,
    }
  );

  return {
    mobile: normalizedMobile,
    response: response.data,
  };
}

module.exports = {
  normalizeIndianMobile,
  sendOtp,
  verifyOtp,
};