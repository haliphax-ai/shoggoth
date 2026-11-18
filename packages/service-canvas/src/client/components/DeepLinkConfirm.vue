<template>
  <Teleport to="body">
    <div v-if="visible" class="confirm-overlay" @click.self="onCancel">
      <div class="confirm-dialog">
        <h3>Send to Agent?</h3>
        <p class="confirm-message">{{ truncatedMessage }}</p>

        <div class="advanced-toggle" @click="showAdvanced = !showAdvanced">
          <span class="toggle-arrow">{{ showAdvanced ? "▾" : "▸" }}</span>
          Options
        </div>

        <div v-if="showAdvanced" class="advanced-controls">
          <label>
            Agent
            <select v-model="agentId">
              <option value="">(default)</option>
              <option v-for="a in agents" :key="a" :value="a">{{ a }}</option>
            </select>
          </label>
          <label>
            Model
            <input v-model="model" type="text" placeholder="auto" />
          </label>
          <label>
            Thinking
            <select v-model="thinking">
              <option value="">(default)</option>
              <option value="on">on</option>
              <option value="off">off</option>
              <option value="stream">stream</option>
            </select>
          </label>
          <label>
            Session Key
            <input v-model="sessionKey" type="text" placeholder="(auto)" />
          </label>
        </div>

        <div class="confirm-actions">
          <button class="btn-cancel" @click="onCancel">Cancel</button>
          <button class="btn-confirm" @click="onConfirm">Send</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  truncateMessage,
  executeDeepLink,
  fetchCanvasConfig,
  type DeepLinkRequest,
} from "../services/deep-link";

defineOptions({ name: "DeepLinkConfirm" });

const visible = ref(false);
const pending = ref<DeepLinkRequest | null>(null);
const resolvePromise = ref<((confirmed: boolean) => void) | null>(null);

const showAdvanced = ref(false);
const agents = ref<string[]>([]);
const agentId = ref("");
const model = ref("");
const thinking = ref("");
const sessionKey = ref("");

const truncatedMessage = computed(() =>
  pending.value ? truncateMessage(pending.value.message, 300) : "",
);

onMounted(async () => {
  const config = await fetchCanvasConfig();
  agents.value = config.agents ?? [];
});

function show(req: DeepLinkRequest): Promise<boolean> {
  pending.value = req;
  // Pre-populate from URL params
  agentId.value = req.agentId ?? "";
  model.value = req.model ?? "";
  thinking.value = req.thinking ?? "";
  sessionKey.value = req.sessionKey ?? "";
  showAdvanced.value = false;
  visible.value = true;
  return new Promise((resolve) => {
    resolvePromise.value = resolve;
  });
}

function onCancel() {
  visible.value = false;
  resolvePromise.value?.(false);
  pending.value = null;
  resolvePromise.value = null;
}

async function onConfirm() {
  visible.value = false;
  if (pending.value) {
    const req = { ...pending.value };
    if (agentId.value) req.agentId = agentId.value;
    if (model.value) req.model = model.value;
    if (thinking.value) req.thinking = thinking.value;
    if (sessionKey.value) req.sessionKey = sessionKey.value;
    const result = await executeDeepLink(req);
    if (!result.ok) {
      console.error("[deep-link] Failed:", result.error);
    }
  }
  resolvePromise.value?.(true);
  pending.value = null;
  resolvePromise.value = null;
}

defineExpose({ show });
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.confirm-dialog {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 20px;
  max-width: 440px;
  width: 90%;
  color: #eee;
}
.confirm-dialog h3 {
  margin: 0 0 12px;
  font-size: 18px;
  color: #fff;
}
.confirm-message {
  background: #0d0d0d;
  border: 1px solid #222;
  border-radius: 4px;
  padding: 12px;
  font-family: monospace;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
  margin: 0 0 12px;
  color: #ccc;
}
.advanced-toggle {
  cursor: pointer;
  font-size: 13px;
  color: #888;
  margin-bottom: 8px;
  user-select: none;
}
.advanced-toggle:hover {
  color: #bbb;
}
.toggle-arrow {
  display: inline-block;
  width: 14px;
}
.advanced-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px;
  background: #111;
  border: 1px solid #222;
  border-radius: 4px;
}
.advanced-controls label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: #aaa;
  gap: 12px;
}
.advanced-controls select,
.advanced-controls input {
  flex: 1;
  max-width: 200px;
  padding: 4px 8px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 4px;
  color: #eee;
  font-size: 13px;
}
.advanced-controls select:focus,
.advanced-controls input:focus {
  outline: none;
  border-color: #2563eb;
}
.confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 12px;
}
.confirm-actions button {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 14px;
}
.btn-cancel {
  background: #333;
  color: #ccc;
}
.btn-cancel:hover {
  background: #444;
}
.btn-confirm {
  background: #2563eb;
  color: #fff;
}
.btn-confirm:hover {
  background: #1d4ed8;
}
</style>
