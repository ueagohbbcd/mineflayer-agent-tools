/**
 * The setting `MF_<name>`, else its older name `ARENA_<name>` (still read so
 * existing deployments keep working).
 */
export const setting = (name, env = process.env) =>
  env[`MF_${name}`] ?? env[`ARENA_${name}`];
