/**
 * Let modules outside this package import the packages installed with it.
 *
 * Agents write modules in their own working directory, which usually has no
 * node_modules; `import { Vec3 } from "vec3"` there would fail. A bare
 * specifier that does not resolve from the importing file is resolved again
 * from this package, so mineflayer, its plugins and their dependencies load
 * as they do for the toolkit itself. Packages the module can reach itself
 * still win.
 */
import { registerHooks } from "node:module";

const bare = (specifier) =>
  !/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);

export function installPackageFallback(parentURL = import.meta.url) {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (
          error?.code !== "ERR_MODULE_NOT_FOUND" ||
          !bare(specifier) ||
          context.parentURL === parentURL
        )
          throw error;
        return nextResolve(specifier, { ...context, parentURL });
      }
    },
  });
}
