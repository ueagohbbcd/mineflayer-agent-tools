// SPDX-License-Identifier: MIT
// Generic visual primitives contributed from the craft-arena integration.
/** Synchronous, caller-driven views of current bot data. No background service. */
module.exports = {
  ...require("./lib/live-raster.js"),
  ...require("./lib/live-snapshot.js"),
  ...require("./lib/live-textures.js"),
};
