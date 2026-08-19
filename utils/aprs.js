// utils/aprs.js

/**
 * 生成APRS-IS登录passcode
 * @param {string} callsign 呼号
 * @returns {number} passcode
 */
function generateAPRSPasscode(callsign) {
  callsign = callsign.split('-')[0].toUpperCase();
  let passcode = 29666;
  let i = 0;
  while (i < callsign.length) {
    passcode ^= callsign.charCodeAt(i) * 256;
    if (i + 1 < callsign.length) {
      passcode ^= callsign.charCodeAt(i + 1);
    }
    i += 2;
  }
  passcode &= 32767;
  return passcode;
}

module.exports = {
  generateAPRSPasscode
};
