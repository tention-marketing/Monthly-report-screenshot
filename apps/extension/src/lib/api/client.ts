import { createApiClient } from "@tention/api-client";

export const localApiBaseUrl = "http://127.0.0.1:4000";
export function resolveApiBaseUrl(configuredBaseUrl: string | undefined): string {
  return configuredBaseUrl || localApiBaseUrl;
}

export const extensionApiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export const apiClient = createApiClient({
  baseUrl: extensionApiBaseUrl,
});
