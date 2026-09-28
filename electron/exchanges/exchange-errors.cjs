const LABELS = Object.freeze({
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  bitget: "Bitget",
  mexc: "MEXC",
  gateio: "Gate.io",
  lbank: "LBank",
});

const sets = (values) => new Set(values.map(String));
const TABLE = Object.freeze({
  binance: {
    EXECUTION_UNKNOWN: sets([-1000, -1006, -1007]),
    RATE_LIMIT: sets([-1003, -1008, -1015]),
    TEMPORARY: sets([-1001, -1016]),
    AUTHENTICATION: sets([-1002, -1021, -1022, -1099, -2014, -2015]),
    ORDER_NOT_FOUND: sets([-2011, -2013]),
    NO_POSITION: sets([-2024, -4054]),
    INSUFFICIENT_MARGIN: sets([-2018, -2019, -2028, -4050, -4051]),
    LIQUIDATION: sets([-2023]),
    POSITION_MODE_MISMATCH: sets([-4046, -4059, -4060, -4061, -4062, -4067, -4068]),
    RISK_LIMIT: sets([-2025, -2027, -4045, -4087, -4105, -4106, -4107, -4118]),
    POST_ONLY_WOULD_TAKE: sets([-5022]),
    DUPLICATE_REQUEST: sets([-4115, -4116]),
  },
  bybit: {
    EXECUTION_UNKNOWN: sets([10000]),
    RATE_LIMIT: sets([10006, 10429, 20003, 20006]),
    TEMPORARY: sets([10016, 10019, 110063, 110079]),
    AUTHENTICATION: sets([10002, 10003, 10004, 10005, 10007, 10009, 10010]),
    ORDER_NOT_FOUND: sets([110001]),
    ALREADY_FINAL: sets([110008, 110010]),
    NO_POSITION: sets([110017, 110034]),
    INSUFFICIENT_MARGIN: sets([110004, 110006, 110007, 110012, 110014, 110044, 110045, 110051, 110052, 110053]),
    LIQUIDATION: sets([110011, 110035, 110040, 110046, 110080]),
    POSITION_MODE_MISMATCH: sets([10008, 110015, 110024, 110025, 110026, 110028, 110029, 110036, 110038, 110067, 110073, 110076, 110077]),
    RISK_LIMIT: sets([110013, 110016, 110021, 110031, 110039, 110047, 110048, 110085, 110086, 110087, 110089, 110090]),
    DUPLICATE_REQUEST: sets([10014, 110030, 110072]),
  },
  okx: {
    EXECUTION_UNKNOWN: sets([50004]),
    RATE_LIMIT: sets([50011, 50040, 50061]),
    TEMPORARY: sets([50001, 50013, 50026, 51034, 51113, 51115, 54008, 54049]),
    AUTHENTICATION: sets([50007, 50014, 50102, 50103, 50104, 50105, 50106, 50107, 50108, 50109, 50110, 50111, 50112, 50113, 50114, 50115, 50119]),
    ORDER_NOT_FOUND: sets([51400, 51503, 51603]),
    ALREADY_FINAL: sets([51401, 51402]),
    NO_POSITION: sets([51169, 51173, 51521]),
    INSUFFICIENT_MARGIN: sets([51008, 51119, 51131, 51133, 51134, 51147, 51148, 51149, 51150, 54024, 54025, 54026, 54027, 54028]),
    LIQUIDATION: sets([51035, 51037, 51038]),
    POSITION_MODE_MISMATCH: sets([51010, 51019, 51023, 51024, 51025, 51039, 51041, 51170, 51522, 50072]),
    RISK_LIMIT: sets([51004, 51005, 51020, 51030, 51031, 51101, 51102, 51104, 51112, 51121, 51122, 51124, 51129, 51130, 51174, 54030]),
    DUPLICATE_REQUEST: sets([50071, 51011, 51511]),
  },
  bitget: {
    EXECUTION_UNKNOWN: sets([40010, 40725, 45001]),
    RATE_LIMIT: sets([429, 25004, 40047]),
    TEMPORARY: sets([25000, 25001, 25003, 25102, 25108, 25113, 25114, 25209, 25210, 25239, 25572, 40015, 40200, 40780, 40808, 40842, 40844, 45043]),
    AUTHENTICATION: sets([25005, 25006, 25007, 25620, 40001, 40002, 40003, 40005, 40006, 40008, 40009, 40011, 40012, 40014, 40018, 40025, 40036, 40037, 40038, 40040, 40041, 40752, 40753]),
    ORDER_NOT_FOUND: sets([25204, 45057]),
    ALREADY_FINAL: sets([45031, 45055, 50062]),
    NO_POSITION: sets([25225, 25226, 25227, 25231, 25242, 40746, 40757, 40758, 40765, 40837]),
    POSITION_CLOSING: sets([50066]),
    INSUFFICIENT_MARGIN: sets([25202, 25203, 25219, 25220, 25228, 40754, 40755, 40756, 40798]),
    LIQUIDATION: sets([25008, 25011, 25012, 25218]),
    POSITION_MODE_MISMATCH: sets([25009, 25010, 25107, 25232, 25236, 25237, 25238, 25245, 40716, 40730, 40775, 45020, 45021]),
    RISK_LIMIT: sets([25211, 25213, 25214, 25215, 25216, 25221, 25223, 25229, 25230, 25233, 25234, 25235, 25243, 25567, 40715, 40761, 40762]),
    DUPLICATE_REQUEST: sets([25212, 45034, 50060]),
  },
  mexc: {
    RATE_LIMIT: sets([510]),
    TEMPORARY: sets([500, 501, 511, 513]),
    AUTHENTICATION: sets([401, 402, 406, 602, 701, 702, 703, 704]),
    ORDER_NOT_FOUND: sets([2040]),
    ALREADY_FINAL: sets([2041]),
    NO_POSITION: sets([2008, 2009]),
    INSUFFICIENT_MARGIN: sets([2005, 2018]),
    POSITION_MODE_MISMATCH: sets([2002, 2019, 2021, 2022, 2026, 2027]),
    RISK_LIMIT: sets([1003, 2006, 2023, 2024, 2025, 2028]),
    DUPLICATE_REQUEST: sets([603]),
  },
  gateio: {
    RATE_LIMIT: sets(["TOO_MANY_REQUESTS"]),
    TEMPORARY: sets(["INTERNAL", "SERVER_ERROR", "INTERNAL_SERVER_ERROR", "TOO_BUSY", "SERVER_TIMEOUT", "RISK_REJECT"]),
    AUTHENTICATION: sets(["INVALID_KEY", "INVALID_SIGNATURE", "IP_FORBIDDEN", "FORBIDDEN", "USER_NOT_FOUND"]),
    ORDER_NOT_FOUND: sets(["ORDER_NOT_FOUND", "ORDER_NOT_OWNED"]),
    ALREADY_FINAL: sets(["ORDER_FINISHED", "ORDER_CLOSED", "ORDER_CANCELLED"]),
    NO_POSITION: sets(["POSITION_EMPTY", "POSITION_NOT_FOUND", "REDUCE_EXCEEDED"]),
    POSITION_CLOSING: sets(["POSITION_IN_CLOSE"]),
    POST_ONLY_WOULD_TAKE: sets(["ORDER_POC_IMMEDIATE", "POC_FILL_IMMEDIATELY"]),
    INSUFFICIENT_MARGIN: sets(["INSUFFICIENT_AVAILABLE", "BALANCE_NOT_ENOUGH", "MARGIN_BALANCE_NOT_ENOUGH"]),
    LIQUIDATION: sets(["LIQUIDATE_IMMEDIATELY", "POSITION_IN_LIQUIDATION"]),
    POSITION_MODE_MISMATCH: sets(["POSITION_CROSS_MARGIN", "POSITION_DUAL_MODE", "POSITION_HOLDING", "ORDER_PENDING", "INCREASE_POSITION"]),
    RISK_LIMIT: sets(["RISK_LIMIT_EXCEEDED", "RISK_LIMIT_NOT_MULTIPLE", "RISK_LIMIT_TOO_HIGH", "RISK_LIMIT_TOO_lOW", "RISK_LIMIT_TOO_LOW", "LEVERAGE_TOO_HIGH", "LEVERAGE_TOO_LOW", "TOO_MANY_ORDERS", "SIZE_TOO_LARGE", "SIZE_TOO_SMALL", "CONTRACT_IN_DELISTING"]),
    DUPLICATE_REQUEST: sets(["DUPLICATE_REQUEST", "ORDER_EXISTS"]),
  },
  // LBank Futures has no stable public error-code reference. Keep this table
  // deliberately limited to codes observed on the selected Futures page.
  // Unknown codes remain EXCHANGE_REJECTED and are never
  // allowed to authorize another trading write.
  lbank: {
    NO_POSITION: sets([31]),
    POST_ONLY_WOULD_TAKE: sets([187, 188]),
    INSUFFICIENT_MARGIN: sets([22001]),
  },
});

const UNCERTAIN = new Set(["EXECUTION_UNKNOWN", "RATE_LIMIT", "TEMPORARY", "DUPLICATE_REQUEST", "EXCHANGE_REJECTED"]);

function categoryFor(exchange, exchangeCode) {
  const code = String(exchangeCode ?? "");
  const table = TABLE[String(exchange || "").toLowerCase()] || {};
  for (const [category, codes] of Object.entries(table)) if (codes.has(code)) return category;
  return "EXCHANGE_REJECTED";
}

function exchangeApiError(exchange, exchangeCode, message, properties = {}) {
  const id = String(exchange || "").toLowerCase();
  const category = categoryFor(id, exchangeCode);
  const label = LABELS[id] || exchange || "Биржа";
  const rawMessage = String(message || "запрос отклонён").slice(0, 300);
  const hasPrefix = rawMessage.toLowerCase().startsWith(String(label).toLowerCase() + ":");
  const hasCode = exchangeCode != null && rawMessage.includes(`[${exchangeCode}]`);
  return Object.assign(new Error(`${hasPrefix ? "" : `${label}: `}${rawMessage}${exchangeCode == null || hasCode ? "" : ` [${exchangeCode}]`}`), {
    code: category,
    category,
    exchange: id,
    exchangeCode: exchangeCode == null ? undefined : String(exchangeCode),
    definitive: !UNCERTAIN.has(category),
    ...properties,
  });
}

function classifyTransportError(exchange, error) {
  if (!error || error.exchangeCode == null || error.exchange) return error;
  const classified = exchangeApiError(exchange, error.exchangeCode, error.message, {
    httpStatus: error.httpStatus,
    endpoint: error.endpoint,
    retryAfterMs: error.retryAfterMs,
  });
  if (error.stack) classified.stack = error.stack;
  return classified;
}

async function exchangeRequest(exchange, promise) {
  try { return await promise; }
  catch (error) { throw classifyTransportError(exchange, error); }
}

module.exports = { TABLE, categoryFor, exchangeApiError, classifyTransportError, exchangeRequest };
