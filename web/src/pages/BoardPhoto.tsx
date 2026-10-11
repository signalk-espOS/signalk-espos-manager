import { useState } from "preact/hooks";

/**
 * A board's catalogue photo. It comes from the vendor's or the registry's
 * site, which a boat without internet cannot reach, so a photo that fails to
 * load disappears instead of leaving a broken-image box. Callers key it by
 * `src`, so a new photo gets a fresh try.
 */
export function BoardPhoto({
  src,
  class: className,
}: {
  src: string;
  class: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      class={className}
      src={src}
      alt=""
      loading="lazy"
      // The host is whatever the registry names; it learns nothing about
      // this server, not even its LAN address.
      referrerpolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
