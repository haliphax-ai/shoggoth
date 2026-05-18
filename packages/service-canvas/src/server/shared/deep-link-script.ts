/**
 * Script injected into canvas HTML to intercept shoggoth:// and shoggoth-fileprompt://
 * link clicks and forward them to the parent SPA via postMessage.
 */
export const DEEP_LINK_SCRIPT = `<script>document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var h=a.getAttribute('href')||'';if(h.indexOf('shoggoth-fileprompt://')===0||h.indexOf('shoggoth://')===0){e.preventDefault();window.parent.postMessage({type:'shoggoth-deeplink',url:h},'*')}},true)</script>`;

/**
 * Inject the deep link script into a data:text/html URL.
 * Returns the original URL unchanged if it's not a data:text/html URL.
 */
export function injectDeepLinkIntoDataUrl(url: string): string {
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
    html = html.replace("</body>", DEEP_LINK_SCRIPT + "</body>");
  } else if (html.includes("</html>")) {
    html = html.replace("</html>", DEEP_LINK_SCRIPT + "</html>");
  } else {
    html += DEEP_LINK_SCRIPT;
  }

  if (isBase64) {
    return meta + "," + Buffer.from(html, "utf-8").toString("base64");
  } else {
    return meta + "," + encodeURIComponent(html);
  }
}
