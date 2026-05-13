/**
 * A2UI Complete Catalog - All UI elements for Shoggoth canvas service
 * Combines basic and extended catalogs into a single PackageDefinition.
 */

import type { PackageDefinition } from "@shoggoth/a2ui-sdk";
import basicCatalog from "@shoggoth/a2ui-catalog-basic";
import extendedCatalog from "@shoggoth/a2ui-catalog-extended";

const definition: PackageDefinition = {
  components: [...basicCatalog.components, ...extendedCatalog.components],
};

export default definition;
