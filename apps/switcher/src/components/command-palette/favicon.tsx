import { useState } from 'react';
import { Globe2Icon } from 'lucide-react';

interface FaviconProps {
  readonly src: string | undefined;
  readonly label: string;
}

export function Favicon({ src, label }: FaviconProps) {
  const [failed, setFailed] = useState(false);
  if (src === undefined || failed) {
    const letter = label.trim().charAt(0).toLocaleUpperCase();
    return (
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-[9px] font-semibold text-muted-foreground"
        aria-hidden="true"
      >
        {letter || <Globe2Icon />}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="size-5 shrink-0 rounded-sm object-contain"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
