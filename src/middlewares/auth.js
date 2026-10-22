const { timingSafeEqual } = require("node:crypto");
const { ApiError } = require("../utils/api-error");

function getConfiguredApiKeys() {
  const raw = process.env.API_KEYS || "";
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function requireApiKey(req, _res, next) {
  if (String(process.env.DISABLE_AUTH).trim().toLowerCase() === "true") {
    req.apiKey = "local-dev";
    return next();
  }

  const header = req.header("x-api-key");
  const apiKeyFromHeader = typeof header === "string" ? header.trim() : "";
  const apiKeyFromQuery = typeof req.query.apiKey === "string" ? req.query.apiKey.trim() : "";
  const apiKey = apiKeyFromHeader || apiKeyFromQuery;

  if (!apiKey) {
    return next(new ApiError(401, "API Key requerida. Usa el header X-API-Key o parametro apiKey"));
  }

  const configuredKeys = getConfiguredApiKeys();
  if (configuredKeys.length === 0) {
    return next(new ApiError(503, "La autenticación está activada, pero no hay API Keys configuradas"));
  }
  const provided = Buffer.from(apiKey);
  const valid = configuredKeys.some(key => {
    const expected = Buffer.from(key);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!valid) {
    return next(new ApiError(401, "API Key invalida o expirada"));
  }

  req.apiKey = apiKey;
  return next();
}

module.exports = { requireApiKey };
