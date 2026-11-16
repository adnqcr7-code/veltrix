# The desktop's one corner

`veltrix-corner` is the corner every rounded shape of Veltrix is drawn with: continuous (no jump in
curvature where the edge turns), stated by a radius alone. Hyalo puts its GLSL twin into its
shaders (`glsl()`); the toolkit's CPU paint (`nk-render`) draws its `outline()`.

`src/reference.rs` is the exact curve; `src/lib.rs` is the fitted one everything draws, and its
tests hold the two together. The skill's design-system reference, "The corner", says why.

Its tests are not run by CI yet (they need a CI step):
`cargo test --manifest-path crates/veltrix-corner/Cargo.toml`.
