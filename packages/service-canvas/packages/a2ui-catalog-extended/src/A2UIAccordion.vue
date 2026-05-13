<template>
  <div class="a2ui-accordion">
    <div v-for="(item, idx) in items" :key="item.id ?? idx" class="a2ui-accordion-item">
      <button class="a2ui-accordion-header" :aria-expanded="openIndex === idx" @click="toggle(idx)">
        <span>{{ item.title }}</span>
        <span class="a2ui-accordion-chevron" :class="{ open: openIndex === idx }">▾</span>
      </button>
      <div v-if="openIndex === idx" class="a2ui-accordion-body">
        <slot :name="`panel-${idx}`">
          <span v-if="item.content">{{ item.content }}</span>
        </slot>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed } from "vue";
import { sendEvent } from "@shoggoth/a2ui-sdk";

export default defineComponent({
  name: "A2UIAccordion",
  props: {
    def: { type: Object, required: true },
    componentId: { type: String, required: true },
    surfaceId: { type: String, default: "" },
  },
  setup(props) {
    const items = computed(() => (props.def as any).items ?? []);
    const openIndex = ref<number | null>((props.def as any).defaultOpen ?? null);

    const toggle = (idx: number) => {
      openIndex.value = openIndex.value === idx ? null : idx;
      sendEvent("a2ui.accordionToggle", {
        componentId: props.componentId,
        index: idx,
        open: openIndex.value === idx,
      });
    };

    return { items, openIndex, toggle };
  },
});
</script>

<style scoped>
.a2ui-accordion {
  width: 100%;
  border: 1px solid var(--a2ui-border, #e5e7eb);
  border-radius: var(--rounded-box, 0.5rem);
  overflow: hidden;
}
.a2ui-accordion-item + .a2ui-accordion-item {
  border-top: 1px solid var(--a2ui-border, #e5e7eb);
}
.a2ui-accordion-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 0.75rem 1rem;
  background: transparent;
  border: none;
  cursor: pointer;
  font-weight: 500;
  text-align: left;
  color: var(--a2ui-text, inherit);
}
.a2ui-accordion-header:hover {
  background: var(--a2ui-hover, rgba(0, 0, 0, 0.04));
}
.a2ui-accordion-chevron {
  transition: transform 0.2s;
}
.a2ui-accordion-chevron.open {
  transform: rotate(180deg);
}
.a2ui-accordion-body {
  padding: 0.5rem 1rem 0.75rem;
}
</style>
