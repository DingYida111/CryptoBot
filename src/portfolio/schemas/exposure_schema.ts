import { z } from "zod";
import { InstrumentIdSchema, ResidualReasonCodeSchema, SecurityIdSchema, StrategyBasisIdSchema, StrategyIdSchema } from "./ids_schema.js";

export const InstrumentPositionSchema = z.object({
  instrumentId: InstrumentIdSchema,
  quantity: z.number(),
});

export const SecurityExposureSchema = z.object({
  securityId: SecurityIdSchema,
  quantity: z.number(),
  unit: z.string().min(1),
});

export const ResidualPositionSchema = z.object({
  instrumentId: InstrumentIdSchema,
  quantity: z.number(),
  reasonCode: ResidualReasonCodeSchema,
});

export const ResidualLedgerSummarySchema = z.object({
  rowCount: z.number().int().nonnegative(),
  grossQuantity: z.number(),
  netQuantity: z.number(),
  byInstrument: z.record(InstrumentIdSchema, z.number()),
  byReasonCode: z.record(ResidualReasonCodeSchema, z.number()),
});

export const BasisDecompositionSchema = z.object({
  basisId: StrategyBasisIdSchema.nullable(),
  strategyWeight: z.number(),
  basisDqContracts: z.number(),
  residualDqContracts: z.number(),
  residualReasonCode: ResidualReasonCodeSchema.nullable(),
});

export const PortfolioStateSchema = z.object({
  asOfMs: z.number().int().nonnegative(),
  instrumentPositions: z.record(InstrumentIdSchema, z.number()),
  securityExposures: z.record(SecurityIdSchema, z.number()),
  cashBalances: z.record(z.string(), z.number()),
  residualPositions: z.record(InstrumentIdSchema, z.number()),
  residualLedger: z.array(ResidualPositionSchema),
  residualSummary: ResidualLedgerSummarySchema,
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])),
});

export const TradeLedgerEntrySchema = z.object({
  instrumentId: InstrumentIdSchema,
  route: z.enum([
    "noop",
    "open_long",
    "open_short",
    "close_long",
    "close_short",
    "partial_close_long",
    "partial_close_short",
    "grid_seed",
    "grid_exit",
    "grid_hold",
    "residual",
  ]),
  dq: z.number(),
  basisId: StrategyBasisIdSchema.nullable(),
  strategyWeight: z.number(),
  basisDq: z.number(),
  residualDq: z.number(),
  residualReasonCode: ResidualReasonCodeSchema.nullable(),
  explainsDqExactly: z.boolean(),
});

export const TradePackageLedgerSchema = z.object({
  basisId: StrategyBasisIdSchema.nullable(),
  strategyWeight: z.number(),
  legs: z.array(TradeLedgerEntrySchema),
  residualLedger: z.array(ResidualPositionSchema),
  residualSummary: ResidualLedgerSummarySchema,
  explainsPackageExactly: z.boolean(),
});

export const OptimizationRequestSchema = z.object({
  portfolioState: PortfolioStateSchema,
  enabledStrategies: z.array(StrategyIdSchema),
  basisIds: z.array(StrategyBasisIdSchema),
  objectiveScores: z.record(z.string(), z.number()),
  instrumentBounds: z.record(InstrumentIdSchema, z.tuple([z.number(), z.number()])),
  securityBounds: z.record(SecurityIdSchema, z.tuple([z.number(), z.number()])),
});

export const DecisionIntentSchema = z.object({
  mode: z.enum(["hold", "trade", "grid"]),
  route: z.enum([
    "noop",
    "open_long",
    "open_short",
    "close_long",
    "close_short",
    "partial_close_long",
    "partial_close_short",
    "grid_seed",
    "grid_exit",
    "grid_hold",
    "residual",
  ]),
  proposedDqContracts: z.number(),
  basis: BasisDecompositionSchema,
  reason: z.string().min(1),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])),
});
