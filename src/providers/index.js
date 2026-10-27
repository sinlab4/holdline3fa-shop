/**
 * Number provider interface. A provider is any module exporting these async functions:
 *
 *   getStock(serviceCode, countryCodes[]) -> { [countryCode]: numberOfAvailableNumbers }
 *   buyNumber({ serviceCode, countryCode }) -> { ref, phone }      (phone in +E.164 form, e.g. "+447700900123")
 *   checkSms(ref)                           -> { code, text } | null (null while nothing has arrived)
 *   cancel(ref)                             -> void              (release the number, best effort)
 *   finish(ref)                             -> void              (mark the order complete, best effort)
 *
 * Pick one with the PROVIDER env var: "mock" (simulated) or "http" (see http.js).
 */
const cfg = require("../config");

module.exports = cfg.provider === "http" ? require("./http") : require("./mock");
