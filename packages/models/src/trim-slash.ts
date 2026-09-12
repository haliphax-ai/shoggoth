/** Strip trailing slash(es) from a URL string. */
export function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}
