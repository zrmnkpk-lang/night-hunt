Original prompt: 根据项目说明，优化所有的美术资产，参考图已经有了，部分资产也优化了，可以在blender里优化。

## 2026-09-10
- Read README, asset inventory, all reference mappings and runtime builders. Existing reference-inspired models are retained as the integration baseline. Git worktree initially clean.
- Blender bridge verified: 5.2.0, unsaved default scene. New asset library will be created separately.
- Scope: all existing 3D character, prop, environment and VFX families; retain menu artwork, HUD semantics, synthesized audio and gameplay/collisions. Add editable Blender library, GLB exchange files, asset review page, reproducible export and visual checks.
- Plan: shared low-poly bevel/faceted materials; character silhouette/accessories; worn wood/stone/metal; ground/foliage/night atmosphere; asset gallery and runtime state verification.

## Completed 2026-09-11
- Implemented shared 44-triangle chamfers and rigid material batching. Added detail across all existing 3D asset families plus a distant manor and broken pallet debris.
- Preserved original wall/collider/nav footprints. Fixed hand-held hunter weapon pivot, chair highlight local position, and stale character pose offsets.
- Added /art-review with 18 assets, studio/night light, orbit controls and six character poses. Reviewed React lifecycle, route lazy loading, semantic controls and renderer disposal.
- Exported 18 GLBs (1,129,636 bytes total) to art/models; source-of-truth remains procedural game geometry, not GLB runtime loading.
- Blender bridge generated art/night-hunt-art-library.blend and art/previews/asset-library.png. Job job-38b48f6c succeeded; 18 assets/255 scene objects. Opened and visually inspected the resulting render.
- Blender MCP requires script files within D:/blender; copied reproducible script there and supplied args.project_root. Fixed lack of __file__ in bridge script context and localized Background node lookup by using node type.
- npm run art:verify passes: exact HEAD collision/sight parity; all pallet fall/break states; gate hinge/status; cipher state; chair highlight; all pose transforms; GLB headers/lengths. World visible meshes roughly 1,315 -> 663, triangles 18k -> 113k including tile instances. This is not an FPS measurement.
- npm run build passed. Targeted ESLint passes for all new/changed art and UI modules; Engine retains its existing unused _c warning (verified in HEAD).
- Browser inspected survivor/hunter gameplay, props and poses, pause/menu switching; gallery has no console errors. Game has an existing embedded-browser pointer lock WrongDocumentError; independent-browser mouse-look remains unverified. Followed the selected Browser plugin's Playwright API instead of launching a second standalone browser client.
- Added dev-only render_game_to_text/advanceTime hooks, removed on React unmount. Production has no exposed harness.
- Menu image, HUD graphics and synthesized audio retained. No skeletal rigging/animation clips, photoreal textures or audio files were commissioned here; future scope documented in art/README.md.
- Deliverables are local and uncommitted. Dev server remains at http://127.0.0.1:3000.
