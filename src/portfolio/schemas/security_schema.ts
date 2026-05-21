import { z } from "zod";
import { SecurityIdSchema } from "./ids_schema.js";

export const SecurityCategorySchema = z.enum([
  "delta",
  "cash",
  "funding",
  "basis",
  "issuer",
  "borrow",
  "other",
]);

export const SecuritySpecSchema = z.object({
  securityId: SecurityIdSchema,
  category: SecurityCategorySchema,
  unit: z.string().min(1),
  markSource: z.string().min(1),
  description: z.string().min(1),
  active: z.boolean(),
});
