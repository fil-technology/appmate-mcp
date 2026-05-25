// Thin fetch wrapper for the AppMate REST surface. Each tool builds the
// path + body and hands it off here. Centralizing the Bearer header + base
// URL + error parsing keeps each tool definition focused on its inputs
// and the response shape.

export type ApiConfig = {
  baseUrl: string;
  token: string;
};

export class AppMateApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(
      `AppMate API error ${status}: ${
        typeof body === "object" && body && "error" in body
          ? String((body as { error: unknown }).error)
          : JSON.stringify(body)
      }`,
    );
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(
  cfg: ApiConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = await res.text().catch(() => "");
    }
    throw new AppMateApiError(res.status, payload);
  }
  // Empty 204s are rare here but harmless to handle.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// Helper for CSV endpoints — returns the raw body string instead of JSON.
export async function apiFetchText(
  cfg: ApiConfig,
  method: "GET",
  path: string,
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = await res.text().catch(() => "");
    }
    throw new AppMateApiError(res.status, payload);
  }
  return res.text();
}
