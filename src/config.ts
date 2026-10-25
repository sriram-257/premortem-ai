const configuredApiBase = import.meta.env.VITE_API_BASE?.trim();
const defaultApiBase = import.meta.env.PROD
  ? "https://premortem-ai-h6je.onrender.com"
  : "http://localhost:8000";

export const API_BASE = (configuredApiBase || defaultApiBase).replace(/\/+$/, "");
