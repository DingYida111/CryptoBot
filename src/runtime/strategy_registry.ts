import {
  BUILTIN_MANAGED_STRATEGIES,
  ManagedStrategyRegistry,
  type ManagedStrategyDefinition,
} from "./managed_strategies.js";
import { OkxContractGridController } from "./okx_contract_grid_controller.js";

export function createManagedStrategyRegistry(): ManagedStrategyRegistry {
  const registry = new ManagedStrategyRegistry();
  for (const definition of BUILTIN_MANAGED_STRATEGIES) {
    registerDefinition(registry, definition);
  }
  return registry;
}

function registerDefinition(
  registry: ManagedStrategyRegistry,
  definition: ManagedStrategyDefinition
): void {
  if (definition.type === "okx_contract_grid") {
    registry.register(definition, () => new OkxContractGridController());
    return;
  }
  registry.register(definition);
}
