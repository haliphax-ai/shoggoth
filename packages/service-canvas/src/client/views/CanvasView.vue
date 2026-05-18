<template>
  <div ref="canvasRoot" class="canvas-view" :class="{ 'canvas-hidden': !visible }">
    <A2UIRenderer v-if="hasA2UISurface" :surface-id="activeSurfaceId" />
    <template v-else>
      <iframe
        v-if="externalUrl"
        ref="iframe"
        :src="externalUrl"
        class="canvas-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        @load="onIframeLoad"
      />
      <iframe
        v-else-if="iframeSrc"
        ref="iframe"
        :src="iframeSrc"
        class="canvas-frame"
        sandbox="allow-scripts allow-same-origin allow-forms"
        @load="onIframeLoad"
      />
      <div v-else class="canvas-loading">Loading…</div>
    </template>
    <DeepLinkConfirm ref="deepLinkConfirm" />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, onMounted, onUnmounted, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useStore } from "vuex";
import { wsClient } from "../services/ws-client";
import {
  parseShoggothUrl,
  executeDeepLink,
  fetchCanvasConfig,
  type DeepLinkRequest,
} from "../services/deep-link";
import { parseShoggothUrl as parseSchemeUrl } from "../utils/url-schemes";
import A2UIRenderer from "../components/A2UIRenderer.vue";
import DeepLinkConfirm from "../components/DeepLinkConfirm.vue";
import domtoimage from "dom-to-image-more";
import { SPA_DOCUMENT_TITLE, resolveCanvasDocumentTitle } from "../utils/document-title-sync";

export default defineComponent({
  name: "CanvasView",
  components: { A2UIRenderer, DeepLinkConfirm },
  setup() {
    const route = useRoute();
    const router = useRouter();
    const store = useStore();
    const iframe = ref<HTMLIFrameElement | null>(null);
    const canvasRoot = ref<HTMLElement | null>(null);
    const deepLinkConfirm = ref<InstanceType<typeof DeepLinkConfirm> | null>(null);
    const cacheBust = ref(0);
    const visible = computed(() => store.state.panel.visible);
    const activeSurfaceId = ref("main");
    const externalUrl = ref<string | null>(null);

    const hasA2UISurface = computed(() => {
      if (subpath.value) return false; // static file URL takes priority
      const surface = store.state.a2ui?.surfaces?.[activeSurfaceId.value];
      return surface?.root != null;
    });

    const sessionId = computed(() => route.params.sessionId as string);
    const subpath = computed(() => (route.params.path as string) || "");

    const iframeSrc = computed(() => {
      if (externalUrl.value) return null;
      const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const base = `${baseUrl}/_c/${sessionId.value}/${subpath.value}`;
      return cacheBust.value ? `${base}?_cb=${cacheBust.value}` : base;
    });

    watch(
      sessionId,
      (s) => {
        store.dispatch("switchSession", s);
        wsClient.switchSession(s);
      },
      { immediate: true },
    );

    function reload() {
      cacheBust.value = Date.now();
    }

    const onReload = (d: Record<string, unknown>) => {
      if (d.session && d.session !== sessionId.value) return;
      if (hasA2UISurface.value) return; // A2UI surfaces update via WebSocket, not file changes
      reload();
    };
    const onShow = (d: Record<string, unknown>) => {
      store.commit("setVisible", true);
      externalUrl.value = null;
      if (d.surface) activeSurfaceId.value = d.surface as string;
      if (d.session) router.push(`/${d.session}/`);
    };
    const onHide = () => store.commit("setVisible", false);
    const onNavigate = (d: Record<string, unknown>) => {
      store.commit("setVisible", true);
      externalUrl.value = null;
      const s = (d.session as string) || sessionId.value;
      const p = (d.path as string) || "";
      router.push(`/${s}/${p}`);
    };
    const onNavigateExternal = (d: Record<string, unknown>) => {
      const url = d.url as string;
      if (
        url &&
        (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:"))
      ) {
        store.commit("setVisible", true);
        externalUrl.value = url;
      }
    };
    const onEval = (d: Record<string, unknown>) => {
      if (d.session && d.session !== sessionId.value) return;
      const js = d.js as string;
      let result: unknown;
      let error: string | undefined;

      try {
        if (iframe.value?.contentWindow) {
          // Same-origin canvas iframe — direct eval
          result = iframe.value.contentWindow.eval(js);
        } else {
          // A2UI mode or no iframe — eval in main window context
          result = new Function(js)();
        }
      } catch (err) {
        error = String(err);
      }

      // Send result back if the command had an id
      if (d.id) {
        wsClient.send({
          type: "canvas.evalResult",
          id: d.id,
          result: result !== undefined ? String(result) : undefined,
          error,
        });
      }
    };
    const onSnapshot = async (d: Record<string, unknown>) => {
      try {
        const el = canvasRoot.value;
        if (!el) throw new Error("No canvas root element");

        // A2UI renders in the parent DOM — use direct capture
        // Also fall through to direct capture if no iframe is available
        const iframeEl = iframe.value;
        if (!hasA2UISurface.value && iframeEl?.contentWindow) {
          // Try iframe-based capture via postMessage
          try {
            const image = await new Promise<string>((resolve, reject) => {
              const timeoutId = setTimeout(() => {
                window.removeEventListener("message", handler);
                reject(new Error("Iframe snapshot timed out"));
              }, 10000);

              function handler(e: MessageEvent) {
                if (!e.data || e.data.type !== "canvas-snapshot-result") return;
                if (e.data.id && e.data.id !== d.id) return;
                window.removeEventListener("message", handler);
                clearTimeout(timeoutId);
                if (e.data.error) reject(new Error(e.data.error));
                else resolve(e.data.image);
              }

              window.addEventListener("message", handler);
              iframeEl.contentWindow!.postMessage(
                { type: "canvas-snapshot-request", id: d.id },
                "*",
              );
            });
            wsClient.send({ type: "canvas.snapshotResult", id: d.id, image });
            return;
          } catch (err) {
            console.error("[snapshot] Iframe capture failed, falling through:", err);
          }
        }

        // Fallback: capture the parent element directly
        const image = await domtoimage.toPng(el, { bgcolor: "#000000" });
        wsClient.send({ type: "canvas.snapshotResult", id: d.id, image });
      } catch (err) {
        wsClient.send({ type: "canvas.snapshotResult", id: d.id, error: String(err) });
      }
    };

    const onSurfaceUpdate = (d: Record<string, unknown>) => {
      if (d.session && d.session !== sessionId.value) return;
      store.commit("a2ui/upsertSurface", { surfaceId: d.surfaceId, components: d.components });
    };
    const onBeginRendering = (d: Record<string, unknown>) => {
      if (d.session && d.session !== sessionId.value) return;
      store.commit("a2ui/setRoot", {
        surfaceId: d.surfaceId,
        root: d.root,
        theme: d.theme,
        catalogId: d.catalogId,
      });
      store.commit("setVisible", true);
      activeSurfaceId.value = d.surfaceId as string;
    };
    const onDataModelUpdate = (d: Record<string, unknown>) => {
      if (d.session && d.session !== sessionId.value) return;
      store.commit("a2ui/updateDataModel", { surfaceId: d.surfaceId, data: d.data });
    };
    const onDeleteSurface = (d: Record<string, unknown>) => {
      if (d.session && d.session !== sessionId.value) return;
      store.commit("a2ui/deleteSurface", { surfaceId: d.surfaceId });
    };
    const onClearAll = (d: Record<string, unknown>) => {
      if (d.session && d.session !== sessionId.value) return;
      store.commit("a2ui/clearAll");
    };

    function applySpaDocumentTitle() {
      document.title = SPA_DOCUMENT_TITLE;
    }

    /** Same-origin canvas iframes expose the embedded document title; cross-origin blocks access → fall back to SPA title. */
    function syncTitleFromIframe() {
      document.title = resolveCanvasDocumentTitle({
        hasA2UISurface: hasA2UISurface.value,
        iframeContentDocument: iframe.value?.contentDocument ?? undefined,
      });
    }

    function onIframeLoad() {
      syncTitleFromIframe();
    }

    watch(
      hasA2UISurface,
      (a2ui) => {
        if (a2ui) applySpaDocumentTitle();
      },
      { immediate: true },
    );

    // Handle postMessage from iframes for shoggoth:// and shoggoth-fileprompt:// deep links
    async function onDeepLinkMessage(e: MessageEvent) {
      if (e.data?.type !== "shoggoth-deeplink" || !e.data?.url) return;
      const url: string = e.data.url;

      // Handle shoggoth-fileprompt:// URLs → /api/file-spawn
      const scheme = parseSchemeUrl(url);
      if (scheme?.type === "fileprompt") {
        const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
        const config = await fetchCanvasConfig();
        if (scheme.params.key || config.skipConfirmation) {
          fetch(`${baseUrl}/api/file-spawn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: scheme.path, ...scheme.params }),
          }).catch(() => {});
        } else {
          // Build a DeepLinkRequest-compatible object for the confirmation dialog
          const req: DeepLinkRequest = {
            message: `[file-spawn] ${scheme.path}`,
            ...scheme.params,
          };
          deepLinkConfirm.value?.show(req);
        }
        return;
      }

      // Handle shoggoth:// URLs → /api/agent
      const req = parseShoggothUrl(url);
      if (!req) return;
      const config = await fetchCanvasConfig();
      if (req.key || config.skipConfirmation) {
        executeDeepLink(req);
      } else {
        deepLinkConfirm.value?.show(req);
      }
    }

    const handlers: [string, (d: Record<string, unknown>) => void][] = [
      ["reload", onReload],
      ["canvas.show", onShow],
      ["canvas.hide", onHide],
      ["canvas.navigate", onNavigate],
      ["canvas.navigateExternal", onNavigateExternal],
      ["canvas.eval", onEval],
      ["canvas.snapshot", onSnapshot],
      ["a2ui.updateComponents", onSurfaceUpdate],
      ["a2ui.createSurface", onBeginRendering],
      ["a2ui.updateDataModel", onDataModelUpdate],
      ["a2ui.deleteSurface", onDeleteSurface],
      ["a2ui.clearAll", onClearAll],
    ];

    onMounted(() => {
      for (const [t, h] of handlers) wsClient.on(t, h);
      window.addEventListener("message", onDeepLinkMessage);
    });
    onUnmounted(() => {
      for (const [t, h] of handlers) wsClient.off(t, h);
      window.removeEventListener("message", onDeepLinkMessage);
    });

    // Attach deep link interceptor on iframe load via @load in template

    return {
      iframeSrc,
      iframe,
      canvasRoot,
      visible,
      reload,
      hasA2UISurface,
      activeSurfaceId,
      externalUrl,
      deepLinkConfirm,
      onIframeLoad,
    };
  },
});
</script>

<style scoped>
.canvas-view {
  width: 100%;
  min-height: 100%;
  height: auto;
  display: flex;
  flex-direction: column;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.canvas-view.canvas-hidden {
  opacity: 0;
  pointer-events: none;
  transform: scale(0.98);
}
.canvas-frame {
  flex: 1;
  border: none;
  width: 100%;
  height: 100%;
}
.canvas-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
}
</style>
