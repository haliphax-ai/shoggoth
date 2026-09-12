/** Convert a `Headers` instance into a plain record with lower-cased keys. */
export function headersToRecord(h: Headers): Record<string, string | undefined> {
  const rec: Record<string, string | undefined> = {};
  h.forEach((v, k) => {
    rec[k.toLowerCase()] = v;
  });
  return rec;
}
