const { ApiError } = require("../utils/api-error");

const usageByDayAndKey = new Map();
let usageDayStamp = "";

function getUtcDayStamp(date) {
  return date.toISOString().slice(0, 10);
}

function getNextUtcMidnightEpochSeconds(now) {
  const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return Math.floor(resetDate.getTime() / 1000);
}

function cleanupOldEntries(currentDayStamp) {
  // Clear on every day rollover, even below the old 2,000-entry threshold.
  // Authenticated keys are configured server-side, so arbitrary user input
  // cannot create an unlimited number of counters.
  if (usageDayStamp !== currentDayStamp) {
    usageByDayAndKey.clear();
    usageDayStamp = currentDayStamp;
  }
}

function dailyRateLimit(req, res, next) {
  if (String(process.env.DISABLE_RATE_LIMIT).trim().toLowerCase() === "true") {
    return next();
  }

  const now = new Date();
  const dayStamp = getUtcDayStamp(now);
  const configuredLimit = Number(process.env.DAILY_REQUEST_LIMIT);
  const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 100;
  const usageKey = `${req.apiKey || "anonymous"}:${dayStamp}`;

  cleanupOldEntries(dayStamp);

  const currentUsage = usageByDayAndKey.get(usageKey) || 0;
  const resetAt = getNextUtcMidnightEpochSeconds(now);

  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Reset", String(resetAt));

  if (currentUsage >= limit) {
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("Retry-After", String(Math.max(1, resetAt - Math.floor(now.getTime() / 1000))));
    return next(new ApiError(429, `Limite de requests alcanzado. Tu plan permite ${limit} requests/dia.`));
  }

  const updatedUsage = currentUsage + 1;
  usageByDayAndKey.set(usageKey, updatedUsage);
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - updatedUsage)));

  return next();
}

module.exports = { dailyRateLimit };
