export type DocumentRecord = {
  _id: string;
  title: string;
  contentType: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
};

type ApiError = { error?: string };

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDocumentDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(timestamp);
}

export async function getErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as ApiError;
    return body.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}
