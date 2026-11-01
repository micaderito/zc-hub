/**
 * Producción (GitHub Pages). La URL del backend se inyecta en CI con el secreto BACKEND_API_URL.
 * En local/build manual: poné acá la URL (ej. https://zonacuaderno-hub.onrender.com/api).
 */
export const environment = {
  production: true,
  apiUrl: '__BACKEND_API_URL__',
  /** Lo inyecta deploy-pages.yml: la versión sale del merge "release vN" (ver agente go-to-prod). */
  build: { version: '__BUILD_VERSION__', sha: '__BUILD_SHA__', date: '__BUILD_DATE__' },
};
