export const V1_PORT = 4777;
export const V1_MAX_HTML_SIZE_BYTES = 10 * 1024 * 1024;
export const V1_RETENTION_DAYS = 30;
export const V1_CLEANUP_INTERVAL_HOURS = 24;

export const V1_POLICY = Object.freeze({
  port: V1_PORT,
  maxHtmlSizeBytes: V1_MAX_HTML_SIZE_BYTES,
  retentionDays: V1_RETENTION_DAYS,
  cleanupIntervalHours: V1_CLEANUP_INTERVAL_HOURS,
} as const);
