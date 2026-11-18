import { injectScriptIntoDataUrl } from "./inject-script";

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
  return injectScriptIntoDataUrl(url, DEEP_LINK_SCRIPT);
}
