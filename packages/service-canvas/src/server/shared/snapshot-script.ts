import { readFileSync } from "node:fs";
import { injectScriptIntoDataUrl } from "./inject-script";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Script injected into canvas HTML to handle snapshot requests from the parent SPA.
 * Inlines dom-to-image-more so no CDN fetch is needed at runtime.
 * Listens for postMessage of type 'canvas-snapshot-request', captures the page,
 * and sends the result back via postMessage.
 */

// Use createRequire for proper node_modules resolution in ESM (handles hoisting).
const esmRequire = createRequire(fileURLToPath(import.meta.url));

// Read the minified dom-to-image-more library at module load time.
// This will throw if the dependency is not installed — that's intentional.
const domToImageMin = readFileSync(
  esmRequire.resolve("dom-to-image-more/dist/dom-to-image-more.min.js"),
  "utf-8",
);

const SNAPSHOT_HANDLER = `(function(){
window.addEventListener('message',function(e){
if(!e.data||e.data.type!=='canvas-snapshot-request')return;
var id=e.data.id||'';
function send(r){r.type='canvas-snapshot-result';r.id=id;window.parent.postMessage(r,'*')}
domtoimage.toPng(document.body)
.then(function(img){send({image:img})})
.catch(function(err){send({error:String(err)})});
});
})()`;

export const SNAPSHOT_SCRIPT = `<script>${domToImageMin}</script><script>${SNAPSHOT_HANDLER}</script>`;

/**
 * Inject the snapshot script into a data:text/html URL.
 * Returns the original URL unchanged if it's not a data:text/html URL.
 */
export function injectSnapshotIntoDataUrl(url: string): string {
  return injectScriptIntoDataUrl(url, SNAPSHOT_SCRIPT);
}
