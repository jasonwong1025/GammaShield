export const gonkaApiKey = process.env.GONKAROUTER_API_KEY?.trim();
export const gonkaBaseUrl = (process.env.GONKAROUTER_BASE_URL?.trim() || "https://api.gonkarouter.io/v1").replace(/\/$/, "");
