/**
 * Whether a registry build is unsigned, i.e. flashes over USB but is refused
 * over the air. Shared by the plugin's update gate and the hosted flasher so
 * the two cannot disagree.
 */
export function isUnsignedBuild(
  project: { signed?: boolean },
  build: { unsigned?: boolean },
): boolean {
  // Indexes written before the registry copied `signed: false` onto each
  // build carry it only at project level; either one means unsigned.
  return build.unsigned === true || project.signed === false;
}
