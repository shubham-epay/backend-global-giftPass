const { parsePhoneNumberFromString, getCountryCallingCode } = require('libphonenumber-js/max');

/**
 * Checkout contact rules shared by validators and controllers.
 * The storefront applies the same email pattern and phone library, so both sides agree.
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;

const UAE_EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];

/** International dialling code for an ISO country ("AE" -> "+971"), or '' when unknown. */
function dialCodeOf(country) {
  try { return `+${getCountryCallingCode(country)}`; } catch { return ''; }
}

/**
 * Parses a phone number typed for `country` (national "050 123 4567", or full "+971 50…") and returns
 * it in E.164 ("+971501234567") when it is a valid number *for that country*; otherwise null.
 */
function normalizePhone(value, country) {
  const parsed = parsePhoneNumberFromString(String(value || ''), country);
  // Valid, and on the selected country's dialling code (+44 also covers Guernsey/Jersey, +1 Canada, etc.).
  if (!parsed || !parsed.isValid() || `+${parsed.countryCallingCode}` !== dialCodeOf(country)) return null;
  return parsed.number;
}

module.exports = { EMAIL_RE, UAE_EMIRATES, dialCodeOf, normalizePhone };
