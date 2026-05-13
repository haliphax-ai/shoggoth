<template>
  <svg
    v-if="pathData"
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    :viewBox="'0 0 24 24'"
    role="img"
    aria-hidden="true"
  >
    <path :d="pathData" :fill="color" />
  </svg>
</template>

<script lang="ts">
import { computed, defineComponent } from "vue";
import { iconMap } from "./icon-map";

function resolveName(def: Record<string, unknown>): string | { path: string } | null {
  const name = def.name;
  if (typeof name === "string") return name;
  if (
    typeof name === "object" &&
    name !== null &&
    "path" in name &&
    typeof (name as { path: unknown }).path === "string"
  ) {
    return name as { path: string };
  }
  return null;
}

export default defineComponent({
  name: "A2UIIcon",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const refVal = computed(() => resolveName(props.def as Record<string, unknown>));

    const size = computed(() => {
      const n = (props.def as Record<string, unknown>).size;
      return typeof n === "number" && Number.isFinite(n) ? n : 24;
    });

    const color = computed(() => {
      const c = (props.def as Record<string, unknown>).color;
      return typeof c === "string" && c.length > 0 ? c : "currentColor";
    });

    const pathData = computed(() => {
      const v = refVal.value;
      if (!v) return null;
      if (typeof v === "object" && v?.path) return v.path;
      if (typeof v === "string") return iconMap[v] ?? null;
      return null;
    });

    return { pathData, size, color };
  },
});
</script>
