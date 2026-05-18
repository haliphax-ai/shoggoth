import type { PackageDefinition } from "@shoggoth/a2ui-sdk";
import A2UIBadge from "./A2UIBadge.vue";
import A2UITable from "./A2UITable.vue";
import A2UIStack from "./A2UIStack.vue";
import A2UISpacer from "./A2UISpacer.vue";
import A2UIProgressBar from "./A2UIProgressBar.vue";
import A2UIRepeat from "./A2UIRepeat.vue";
import A2UIAccordion from "./A2UIAccordion.vue";
import A2UIWrap from "./A2UIWrap.vue";

const definition: PackageDefinition = {
  components: [
    { name: "Badge", component: A2UIBadge },
    { name: "Table", component: A2UITable },
    { name: "Stack", component: A2UIStack },
    { name: "Spacer", component: A2UISpacer },
    { name: "ProgressBar", component: A2UIProgressBar },
    { name: "Repeat", component: A2UIRepeat },
    { name: "Accordion", component: A2UIAccordion },
    { name: "Wrap", component: A2UIWrap },
  ],
};

export default definition;
