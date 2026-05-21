import { z } from "zod";
import { InstrumentIdSchema, SecurityIdSchema } from "./ids_schema.js";

export const InstrumentKindSchema = z.enum(["spot", "perp", "future", "synthetic", "spread"]);

export const InstrumentSpecSchema = z.object({
  instrumentId: InstrumentIdSchema,
  kind: InstrumentKindSchema,
  venue: z.string().min(1),
  baseAsset: z.string().min(1),
  quoteAsset: z.string().min(1),
  quantityUnit: z.string().min(1),
  priceUnit: z.string().min(1),
  minTradeSize: z.number().positive(),
  stepSize: z.number().positive(),
  contractMultiplier: z.number().positive(),
  allowedSides: z.array(z.enum(["buy", "sell"])).min(1),
  exposurePerContract: z.record(SecurityIdSchema, z.number()),
  tags: z.array(z.string()),
});
