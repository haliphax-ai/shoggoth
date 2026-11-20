import { createRouter, createWebHistory } from "vue-router";
import CanvasView from "./views/CanvasView.vue";
import ScaffoldView from "./views/ScaffoldView.vue";

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // Static routes MUST be defined before the catch-all /:sessionId route
    { path: "/scaffold", name: "scaffold", component: ScaffoldView },
    { path: "/", redirect: "/main/" },
    // Redirect single-segment canvas URLs to the canonical trailing-slash form
    // so the deeper /:sessionId/:path(.*) route below matches and CanvasView
    // mounts. Without this, hitting e.g. /developer leaves the route unmatched,
    // CanvasView never mounts, A2UI WS handlers never register, and surfaces
    // appear to never render.
    {
      path: "/:sessionId",
      name: "canvas-root-redirect",
      redirect: (to) => `${to.path}/`,
    },
    { path: "/:sessionId/:path(.*)", name: "canvas", component: CanvasView },
  ],
});
