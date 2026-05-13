<template>
  <div class="a2ui-column">
    <A2UINode
      v-for="childId in children"
      :key="childId"
      :component-id="childId"
      :surface-id="surfaceId"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UIColumn",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
  },
  setup(props) {
    const children = computed(() => {
      const c = (props.def as any).children;
      return c?.explicitList ?? c ?? [];
    });
    return { children };
  },
});
</script>

<style scoped>
.a2ui-column {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* DaisyUI collapses (e.g. Accordion) live under nested catalog components — :deep so
 * panels span the column when the row/column flex layout is content-sized. */
.a2ui-column :deep(.collapse) {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
</style>
