/**
 * Transform settings shared by all three jest configs (`jest.config.js`,
 * `jest.config.all.js`, `jest.config.integration.js`). Extracted because the regex below is subtle
 * and three hand-copied versions would drift.
 */

/**
 * `.tsx?`: the repo tsconfig sets `jsx: "preserve"` (Next compiles JSX itself), which ts-jest would
 * otherwise honour — emitting raw JSX that node cannot parse the moment a test imports a `.tsx`
 * component module. Override it for tests only so React components are importable/renderable.
 *
 * `.js`: needed purely so the un-ignored d3 packages below actually have a transformer. Without this
 * entry `transformIgnorePatterns` is inert for them, because d3 ships `.js`, not `.ts`.
 */
const transform = {
  "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react-jsx" } }],
  "^.+\\.js$": ["ts-jest", { tsconfig: { allowJs: true } }],
};

/**
 * Every d3 package we depend on is `"type": "module"` and ships untranspiled ESM, so importing one
 * from a test throws `SyntaxError: Unexpected token 'export'` under Jest's default
 * "never transform node_modules" rule. Un-ignore `d3-*` and `internmap` (a d3-array/d3-scale
 * transitive) so they get compiled to CJS.
 *
 * The negative lookahead is deliberately re-evaluated at every `/node_modules/` segment: `d3-sankey`
 * has its own nested `node_modules/d3-sankey/node_modules/{d3-array,d3-shape}` at pinned v1/v2, and
 * those must be transformed too. Guarded by `lib/charts/__tests__/d3-esm-imports.test.ts`.
 */
const transformIgnorePatterns = ["/node_modules/(?!(d3-[^/]+|internmap)/)"];

module.exports = { transform, transformIgnorePatterns };
