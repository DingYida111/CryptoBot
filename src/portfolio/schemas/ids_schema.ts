import { z } from "zod";
import {
  asInstrumentId,
  asResidualReasonCode,
  asSecurityId,
  asStrategyBasisId,
  asStrategyId,
} from "../ids.js";

export const SecurityIdSchema = z.string().min(1).transform(asSecurityId);
export const InstrumentIdSchema = z.string().min(1).transform(asInstrumentId);
export const StrategyBasisIdSchema = z.string().min(1).transform(asStrategyBasisId);
export const StrategyIdSchema = z.string().min(1).transform(asStrategyId);
export const ResidualReasonCodeSchema = z.string().min(1).transform(asResidualReasonCode);
