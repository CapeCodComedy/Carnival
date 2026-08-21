/* Ticket codes, unambiguous alphabet, free of the ill-omen digit,
   trailing checksum. Same format the door scanner validates:
   CCC-XXXX-XXXXC  (8 payload chars + 1 checksum) */
const crypto = require("crypto");
const ALPHA = "235689ACDEFHJKLMNPRTUVWXY";

function gen() {
  let body = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) body += ALPHA[bytes[i] % ALPHA.length];
  let sum = 0;
  for (const ch of body) sum += ALPHA.indexOf(ch);
  return `CCC-${body.slice(0, 4)}-${body.slice(4)}${ALPHA[sum % ALPHA.length]}`;
}
function valid(code) {
  const m = /^CCC-([A-Z0-9]{4})-([A-Z0-9]{4})([A-Z0-9])$/.exec(String(code).toUpperCase());
  if (!m) return false;
  const body = m[1] + m[2];
  if ([...body].some(ch => ALPHA.indexOf(ch) < 0)) return false;
  let sum = 0;
  for (const ch of body) sum += ALPHA.indexOf(ch);
  return ALPHA[sum % ALPHA.length] === m[3];
}
module.exports = { gen, valid, ALPHA };
