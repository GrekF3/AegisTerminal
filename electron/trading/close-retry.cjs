function closeRetryDelay(error) {
  if (Number(error?.httpStatus || error?.status) === 429) return Math.max(5000, Number(error.retryAfterMs) || 0);
  if (error?.code === 'ORDER_PENDING_HISTORY') return Math.max(2000, Number(error.retryAfterMs) || 0);
  if (error?.code === 'SNAPSHOT_REFRESH_PENDING') return Math.max(250, Number(error.retryAfterMs) || 0);
  if (error?.code === 'POSITION_CLOSING') return Math.max(1000, Number(error.retryAfterMs) || 0);
  if (error?.code === 'RATE_LIMIT') return Math.max(5000, Number(error.retryAfterMs) || 0);
  if (error?.code === 'TEMPORARY') return Math.max(2000, Number(error.retryAfterMs) || 0);
  return null;
}
module.exports = { closeRetryDelay };
