<template>
  <div class="scaffold">
    <h1>Canvas Ready</h1>
    <p>
      No <code>index.html</code> found for session <strong>{{ session }}</strong
      >.
    </p>
    <p>Place files in the session directory to get started.</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";

defineOptions({ name: "ScaffoldView" });

const route = useRoute();
const session = computed(() => (route.query.session as string) || "main");
</script>

<style scoped>
.scaffold {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  text-align: center;
  padding: 2rem;
}
h1 {
  font-size: 1.5rem;
  margin-bottom: 0.5rem;
}
p {
  color: #888;
  line-height: 1.6;
  margin-top: 0.5rem;
}
code {
  background: #2a2a3e;
  padding: 0.2em 0.5em;
  border-radius: 4px;
}
</style>
