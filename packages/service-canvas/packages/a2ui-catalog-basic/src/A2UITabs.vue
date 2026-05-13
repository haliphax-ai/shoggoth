<template>
  <div class="a2ui-tabs">
    <div
      v-if="pos !== 'hidden'"
      class="tabs tabs-border"
      :class="pos === 'bottom' ? 'tabs-bottom' : 'tabs-top'"
      role="tablist"
    >
      <a
        v-for="(tab, i) in tabs"
        :key="i"
        role="tab"
        class="tab"
        :class="{ 'tab-active': i === activeIndex }"
        @click="activeIndex = i"
        >{{ tab.label }}</a
      >
      <div
        class="tab-content a2ui-tabs-content"
        :class="{ 'a2ui-tabs-content--fixed': height !== 'auto' }"
        :style="height !== 'auto' ? `--tabs-content-height: ${height}` : undefined"
      >
        <div
          v-for="(tab, i) in tabs"
          :key="i"
          class="a2ui-tabs-panel"
          :class="{ 'a2ui-tabs-panel--hidden': i !== activeIndex }"
        >
          <A2UINode :component-id="tab.child" :surface-id="surfaceId" />
        </div>
      </div>
    </div>
    <div
      v-else
      class="a2ui-tabs-content"
      :class="{ 'a2ui-tabs-content--fixed': height !== 'auto' }"
      :style="height !== 'auto' ? `--tabs-content-height: ${height}` : undefined"
    >
      <div
        v-for="(tab, i) in tabs"
        :key="i"
        class="a2ui-tabs-panel"
        :class="{ 'a2ui-tabs-panel--hidden': i !== activeIndex }"
      >
        <A2UINode :component-id="tab.child" :surface-id="surfaceId" />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed } from "vue";

export default defineComponent({
  name: "A2UITabs",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const tabs = computed(() => {
      const raw = (props.def as any).tabs ?? [];
      return raw.map((t: any) => ({
        label: t.label ?? "",
        child: t.child ?? (Array.isArray(t.children) ? t.children[0] : null),
      }));
    });
    const pos = computed(() => (props.def as any).position ?? "top");
    const height = computed(() => (props.def as any).height ?? "auto");
    const activeIndex = ref((props.def as any).active ?? 0);

    return { tabs, pos, height, activeIndex };
  },
});
</script>

<style scoped>
/* min-width: 0 so nested wide content (e.g. tables) can shrink; overflow scrolls inside children */
.a2ui-tabs {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}
/* Mirror DaisyUI tab label inset (.tab uses --tab-p); used for panel horizontal alignment. */
.a2ui-tabs > .tabs {
  --tab-p: 0.75rem;
}
.a2ui-tabs-content {
  position: relative;
  display: grid;
  min-width: 0;
  box-sizing: border-box;
}
.a2ui-tabs-content--fixed {
  height: var(--tabs-content-height);
  overflow: auto;
}
/* Vertical gap on the content box so it clears the tab underline / border (panel padding was easy to miss). */
.a2ui-tabs .tabs.tabs-top .tab-content.a2ui-tabs-content {
  padding-top: 1rem;
}
.a2ui-tabs .tabs.tabs-bottom .tab-content.a2ui-tabs-content {
  padding-bottom: 1rem;
}
.a2ui-tabs-panel {
  grid-area: 1 / 1;
  min-width: 0;
  box-sizing: border-box;
  /* Narrower than full --tab-p so panel text lines up with tab label (tabs-border tabs still use --tab-p). */
  padding-inline: max(0.375rem, calc(var(--tab-p) - 0.25rem));
  padding-bottom: 1rem;
}
/* position=hidden: no .tabs / --tab-p */
.a2ui-tabs > .a2ui-tabs-content:not(.tab-content) .a2ui-tabs-panel {
  padding-inline: 0.5rem;
  padding-top: 1rem;
}
.a2ui-tabs-panel--hidden {
  visibility: hidden;
  pointer-events: none;
}
</style>
