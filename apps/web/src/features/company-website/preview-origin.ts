const allowedPreviewParentOrigins = new Set([
  "http://127.0.0.1:5176",
  "http://localhost:5176",
  "https://platform.tawseelhub.com",
  "https://bluelinegpt-platform-test.onrender.com",
]);

export function isAllowedCompanyWebsitePreviewParent(origin: string): boolean {
  return allowedPreviewParentOrigins.has(origin);
}
