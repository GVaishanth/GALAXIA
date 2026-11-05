/**
 * P11.1 lazy fleet chunk entry (FLEET_COMMAND.md "Lazy fleet chunk"): the only module the shell
 * imports dynamically for Fleet Command, once, with a cached promise. Eager code imports types
 * only (fleet/vessels.ts FleetKit = typeof this module); nothing deploys until it has loaded.
 */
export { assignCaptain, captainRefusal, hullRefusal, commissionedText, FLEET_PRICING, hullPrice, purchase, purchaseRefusal, refusalText, releaseCaptain, setService, transfer, transferRefusal, transferRefusalText, type CommandRefusal, type CommandWorld, type HullPrice, type PurchaseWorld, type TransferEnd, type TransferRefusal, type TransferResult } from './command.ts';
export { attackRefusal, orderRefusalText, beamHit, blastHit, deploy, issueOrder, nearUnit, regroup, shotHit, stepWing, syncWing, WING, wingStatus, type OrderRefusal, type OrderRequest } from './wing.ts';
