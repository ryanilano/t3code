/**
 * CodePuppyAdapter — shape type for the Code Puppy provider adapter.
 *
 * The driver model ({@link ../Drivers/CodePuppyDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module CodePuppyAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CodePuppyAdapterShape — per-instance Code Puppy adapter contract.
 */
export interface CodePuppyAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
