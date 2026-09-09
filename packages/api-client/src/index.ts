export interface HealthResponse { ok: true }

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return {
    async health(): Promise<HealthResponse> {
      const response = await request(`${baseUrl}/api/v1/health`);
      if (!response.ok) throw new Error(`Health check failed with status ${response.status}`);
      const data: unknown = await response.json();
      if (!isHealthResponse(data)) throw new Error("Health check returned an invalid response");
      return data;
    },
  };
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}
