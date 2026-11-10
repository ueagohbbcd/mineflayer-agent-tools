// SPDX-License-Identifier: MIT
// visual.live: caller-driven captures and CPU renders of a connected bot or
// local mirror (lib/live-*.js). Manual: docs/libraries/live-visual.md.
/** Synchronous, caller-driven views of current bot data. No background service. */
module.exports = {
  ...require("./lib/live-raster.js"),
  ...require("./lib/live-snapshot.js"),
  ...require("./lib/live-textures.js"),
};
