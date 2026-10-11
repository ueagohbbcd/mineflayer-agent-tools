// SPDX-License-Identifier: MIT
// Generic visual primitives contributed from the craft-arena integration.
import live from "./live.js";
export default live;
export const {
  PALETTE,
  UNKNOWN_COLOR,
  AIR_COLOR,
  materialColor,
  normalizeSnapshot,
  snapshotFromBot,
  snapshotFromExplored,
  validateImageDimensions,
  encodePNG,
  renderMinimap,
  renderSurfaceMinimap,
  VIEW_DIRECTIONS,
  viewDirectionSigns,
  renderOblique,
  saveRender,
  observationViewBounds,
  surfaceSnapshotFromBot,
  validBounds,
  radiusValue,
  decodeTextureAtlas,
  renderTexturedSurface,
} = live;
