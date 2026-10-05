// Fallback when the API is not serving /config.js (local Vite).
// Production overwrites this route with runtime Reown project id injection.
window.COPYRA_API = window.COPYRA_API || '';
window.__COPYRA_CONFIG__ = window.__COPYRA_CONFIG__ || { reownProjectId: '' };
