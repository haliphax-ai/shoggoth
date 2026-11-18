<template>
  <div class="a2ui-renderer" v-if="root" :data-theme="activeTheme">
    <A2UINode :component-id="root" :surface-id="surfaceId" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useStore } from "vuex";
import A2UINode from "./A2UINode.vue";

defineOptions({ name: "A2UIRenderer" });

const props = defineProps<{
  surfaceId: string;
}>();

const store = useStore();
const surface = computed(() => store.state.a2ui?.surfaces?.[props.surfaceId]);
const root = computed(() => surface.value?.root ?? null);

const activeTheme = computed(() => {
  return surface.value?.theme || "dark";
});
</script>

<style scoped>
.a2ui-renderer {
  width: 100%;
  min-height: 100dvh;
  height: auto;
  padding: 12px;
  box-sizing: border-box;

  --a2ui-primary: var(--color-primary);
  --a2ui-primary-hover: color-mix(in oklch, var(--color-primary) 85%, white);
  --a2ui-text: var(--color-base-content);
  --a2ui-text-muted: color-mix(in oklch, var(--color-base-content) 60%, transparent);
  --a2ui-bg: var(--color-base-100);
  --a2ui-bg-surface: var(--color-base-200);
  --a2ui-bg-raised: var(--color-base-300);
  --a2ui-bg-raised-hover: var(--color-neutral);
  --a2ui-bg-inset: var(--color-base-200);
  --a2ui-border: var(--color-base-300);
  --a2ui-track: var(--color-base-300);
  --a2ui-badge-info-bg: var(--color-info-content);
  --a2ui-badge-info-fg: var(--color-info);
  --a2ui-badge-success-bg: var(--color-success-content);
  --a2ui-badge-success-fg: var(--color-success);
  --a2ui-badge-warning-bg: var(--color-warning-content);
  --a2ui-badge-warning-fg: var(--color-warning);
  --a2ui-badge-error-bg: var(--color-error-content);
  --a2ui-badge-error-fg: var(--color-error);
}
</style>
