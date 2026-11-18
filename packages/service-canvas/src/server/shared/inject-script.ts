/**
 * Shared data:text/html script injection mechanics.
 */

/**
 * Inject a script into a data:text/html URL.
 * The script is placed before </body>, or before </html> if there is no body,
 * or appended to the end. Returns the original URL unchanged if it's not a
 * data:text/html URL.
 */
export function injectScriptIntoDataUrl(url: string, script: string): string {
  if (!url.startsWith("data:text/html")) return url;

  const commaIdx = url.indexOf(",");
  if (commaIdx < 0) return url;

  const meta = url.slice(0, commaIdx); // e.g. "data:text/html;base64" or "data:text/html"
  const isBase64 = meta.toLowerCase().includes(";base64");
  const encoded = url.slice(commaIdx + 1);

  let html: string;
  if (isBase64) {
    html = Buffer.from(encoded, "base64").toString("utf-8");
  } else {
    html = decodeURIComponent(encoded);
  }

  // Inject before </body>, </html>, or at the end
  if (html.includes("</body>")) {
    html = html.replace("</body>", script + "</body>");
  } else if (html.includes("</html>")) {
    html = html.replace("</html>", script + "</html>");
  } else {
    html += script;
  }

  if (isBase64) {
    return meta + "," + Buffer.from(html, "utf-8").toString("base64");
  } else {
    return meta + "," + encodeURIComponent(html);
  }
}
