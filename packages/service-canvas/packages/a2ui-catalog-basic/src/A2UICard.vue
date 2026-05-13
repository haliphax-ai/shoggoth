<template>
  <div class="card a2ui-card" :class="cardClasses">
    <figure v-if="image">
      <img :src="resolvedImage" :alt="imageAlt" />
    </figure>
    <div class="card-body">
      <h2 v-if="title" class="card-title">{{ title }}</h2>
      <A2UINode v-if="child" :component-id="child" :surface-id="surfaceId" />
      <div v-if="actions.length" class="card-actions justify-end">
        <A2UINode
          v-for="actionId in actions"
          :key="actionId"
          :component-id="actionId"
          :surface-id="surfaceId"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { rewriteCanvasUrl } from "./url-rewriter";

const variantMap: Record<string, string> = {
  base: "bg-base-100",
  neutral: "bg-neutral text-neutral-content",
  primary: "bg-primary text-primary-content",
  secondary: "bg-secondary text-secondary-content",
  accent: "bg-accent text-accent-content",
  info: "bg-info text-info-content",
  success: "bg-success text-success-content",
  warning: "bg-warning text-warning-content",
  error: "bg-error text-error-content",
};

const shadowMap: Record<string, string> = {
  none: "shadow-none",
  sm: "shadow-sm",
  md: "shadow-md",
  lg: "shadow-lg",
  xl: "shadow-xl",
};

const sizeMap: Record<string, string> = {
  xs: "card-xs",
  sm: "card-sm",
  md: "card-md",
  lg: "card-lg",
  xl: "card-xl",
};

export default defineComponent({
  name: "A2UICard",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const child = computed(() => (props.def as any).child ?? null);
    const title = computed(() => (props.def as any).title ?? null);
    const image = computed(() => (props.def as any).image ?? null);
    const imageAlt = computed(() => (props.def as any).imageAlt ?? "");
    const actions = computed(() => (props.def as any).actions ?? []);
    const resolvedImage = computed(() => (image.value ? rewriteCanvasUrl(image.value) : ""));
    const cardClasses = computed(() => {
      const d = props.def as any;
      const shadow = d.shadow ?? "sm";
      const variant = d.variant ?? "base";
      const classes: string[] = [];
      classes.push(shadowMap[shadow] ?? "shadow-sm");
      if (variantMap[variant]) classes.push(variantMap[variant]);
      if (d.side) classes.push("lg:card-side");
      if (sizeMap[d.size]) classes.push(sizeMap[d.size]);
      return classes;
    });
    return { child, title, image, imageAlt, actions, resolvedImage, cardClasses };
  },
});
</script>

<style scoped>
.a2ui-card {
  color: var(--a2ui-text, inherit);
}
.a2ui-card figure img {
  width: 100%;
  object-fit: cover;
}
</style>
