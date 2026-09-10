import { createApiClient } from "@tention/api-client";

export const apiClient = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:3000",
});
