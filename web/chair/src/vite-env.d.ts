// Ambient declarations for Vite side-effect asset imports.
// The chair tsconfig sets `types: []` (no `vite/client`), so declare the CSS
// module ourselves: TypeScript 6 (TS2882) requires a declaration for
// side-effect imports like `import "./theme.css"`.
declare module "*.css";
