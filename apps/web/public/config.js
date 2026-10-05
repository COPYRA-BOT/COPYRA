// Fallback when the API is not serving /config.js (local Vite).
// Production overwrites this route with runtime Reown + Venly public config.
window.COPYRA_API = window.COPYRA_API || '';
window.__COPYRA_CONFIG__ = window.__COPYRA_CONFIG__ || {
  reownProjectId: '',
  venlyClientId: '',
  venlyEnvironment: 'production',
};
