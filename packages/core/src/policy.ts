export const V1_PORT = 4777;
export const V1_MAX_HTML_SIZE_BYTES = 10 * 1024 * 1024;
export const V1_RETENTION_DAYS = 30;
export const V1_CLEANUP_INTERVAL_HOURS = 24;
/**
 * The fixed logical ceiling for committed snapshots. This is deliberately a
 * policy constant rather than user configuration: v1 accounts for published
 * HTML bytes plus the per-document metadata allowance in the metadata store.
 */
export const V1_STORAGE_QUOTA_BYTES = 1 * 1024 * 1024 * 1024;
/** A conservative charge for one document row, generation, and indexes. */
export const V1_STORAGE_METADATA_BYTES_PER_DOCUMENT = 4 * 1024;

export const V1_POLICY = Object.freeze({
  port: V1_PORT,
  maxHtmlSizeBytes: V1_MAX_HTML_SIZE_BYTES,
  retentionDays: V1_RETENTION_DAYS,
  cleanupIntervalHours: V1_CLEANUP_INTERVAL_HOURS,
  storageQuotaBytes: V1_STORAGE_QUOTA_BYTES,
  storageMetadataBytesPerDocument: V1_STORAGE_METADATA_BYTES_PER_DOCUMENT,
} as const);
