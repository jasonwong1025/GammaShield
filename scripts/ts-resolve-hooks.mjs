// Resolution hook for the self-check scripts. lib/ uses extensionless relative
// imports (the Next bundler resolves them); Node's ESM loader does not guess
// extensions, so retry a failed relative specifier with `.ts` appended rather
// than bending lib/ import style around the test runner.
export async function resolve(specifier, context, next) {
  if (!specifier.startsWith(".")) return next(specifier, context);
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    return next(`${specifier}.ts`, context);
  }
}
