/**
 * Compatibility entry point for the intelligence HTTP surface.
 *
 * Canonical implementation lives in ../routes/intelligence.ts. This shim
 * exists so an integrator importing either documented path gets the same
 * factory and mount function. No listener is registered here.
 */
export {
  createIntelligenceRouter,
  mountIntelligenceRoutes,
  default,
} from '../routes/intelligence.ts';
