<template>
  <img :src="resolvedSrc" :alt="def.alt ?? ''" />
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { rewriteCanvasUrl } from "./url-rewriter";

export default defineComponent({
  name: "A2UIImage",
  props: { def: { type: Object, required: true } },
  setup(props) {
    const resolvedSrc = computed(() => rewriteCanvasUrl((props.def as any).src ?? ""));
    return { resolvedSrc };
  },
});
</script>
