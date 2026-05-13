<template>
  <div class="a2ui-table-wrapper">
    <table class="a2ui-table" :class="{ striped, bordered }">
      <thead v-if="headers.length">
        <tr>
          <th v-for="(h, i) in headers" :key="i">{{ h }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, ri) in rows" :key="ri">
          <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";

export default defineComponent({
  name: "A2UITable",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const headers = computed(() => (props.def as any).headers ?? []);
    const rows = computed(() => (props.def as any).rows ?? []);
    const striped = computed(() => (props.def as any).striped ?? false);
    const bordered = computed(() => (props.def as any).bordered ?? false);

    return { headers, rows, striped, bordered };
  },
});
</script>

<style scoped>
.a2ui-table-wrapper {
  width: 100%;
  overflow-x: auto;
}
.a2ui-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.a2ui-table th,
.a2ui-table td {
  padding: 0.5rem 0.75rem;
  text-align: left;
}
.a2ui-table th {
  font-weight: 600;
  border-bottom: 2px solid var(--a2ui-border, #e5e7eb);
}
.a2ui-table td {
  border-bottom: 1px solid var(--a2ui-border, #e5e7eb);
}
.a2ui-table.striped tbody tr:nth-child(even) {
  background: var(--a2ui-hover, rgba(0, 0, 0, 0.02));
}
.a2ui-table.bordered th,
.a2ui-table.bordered td {
  border: 1px solid var(--a2ui-border, #e5e7eb);
}
</style>
