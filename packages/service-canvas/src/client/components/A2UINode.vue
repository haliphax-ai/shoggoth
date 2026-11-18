<template>
  <component
    v-if="resolvedComponent"
    :is="resolvedComponent"
    :def="componentDef"
    :component-id="componentId"
    :surface-id="surfaceId"
  />
</template>

<script lang="ts">
import type { Component } from "vue";
import { catalogComponents } from "virtual:shoggoth-catalogs";

/**
 * Resolve a component by name using catalog components from virtual:shoggoth-catalogs.
 *
 * Exported for testability.
 */
export function resolveA2UIComponent(name: string | null): Component | null {
  if (!name) return null;
  // TODO: catalogId filtering — restrict catalog components by surface catalogId
  const catalogEntry = catalogComponents[name];
  if (catalogEntry) return catalogEntry.component;

  return null;
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import { useStore } from "vuex";

defineOptions({ name: "A2UINode" });

const props = defineProps<{
  componentId: string;
  surfaceId: string;
}>();

const store = useStore();

const componentEntry = computed(() => {
  const surface = store.state.a2ui?.surfaces?.[props.surfaceId];
  return surface?.components?.[props.componentId] ?? null;
});

// v0.9 flat shape: { component: "Column", children: [...] }
const typeName = computed(() => {
  const entry = componentEntry.value;
  if (!entry) return null;
  return (entry.component as string) ?? null;
});

const componentDef = computed(() => {
  const entry = componentEntry.value;
  if (!entry || !typeName.value) return null;
  const { component, ...rest } = entry as Record<string, unknown>;
  // MultiSelect alias implies multi: true
  if (component === "MultiSelect") return { ...rest, multi: true };
  return rest;
});

const resolvedComponent = computed(() => resolveA2UIComponent(typeName.value));
</script>
