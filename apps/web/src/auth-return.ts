/** Keep shared document destinations through sign-in without enabling open redirects. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/overview";
  if (value.split(/[?#]/)[0] === "/login") return "/overview";
  return value;
}
