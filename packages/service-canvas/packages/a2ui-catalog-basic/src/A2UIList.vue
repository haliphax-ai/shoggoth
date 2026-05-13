<template>
  <ul class="list bg-base-100 rounded-box shadow-md">
    <li v-for="rowId in rows" :key="rowId" class="list-row">
      <template v-for="(colId, colIdx) in getRowChildren(rowId)" :key="colId">
        <div :class="colClasses(colIdx)">
          <A2UINode :component-id="colId" :surface-id="surfaceId" />
        </div>
      </template>
    </li>
  </ul>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { useStore } from "vuex";

export default defineComponent({
  name: "A2UIList",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const store = useStore();

    const rows = computed(() => {
      const r = (props.def as any).rows;
      return r?.explicitList ?? r ?? [];
    });
    const wrap = computed((): number | null => (props.def as any).wrap ?? null);
    const grow = computed((): number => (props.def as any).grow ?? 1);

    function getRowChildren(rowId: string): string[] {
      const surface = store.state.a2ui?.surfaces?.[props.surfaceId];
      const entry = surface?.components?.[rowId];
      if (!entry) return [];
      const c = entry.children;
      return c?.explicitList ?? c ?? [];
    }

    function colClasses(colIdx: number): Record<string, boolean> {
      return {
        "list-col-wrap": wrap.value !== null && colIdx === wrap.value,
        "list-col-grow": colIdx === grow.value,
      };
    }

    return { rows, getRowChildren, colClasses };
  },
});
</script>
