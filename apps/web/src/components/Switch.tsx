'use client';

import { useState } from 'react';

/** Toggle switch. Controlled when `checked` is given, otherwise keeps its own state. */
export function Switch({
  label,
  checked,
  defaultChecked = false,
  onChange,
}: {
  label: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (v: boolean) => void;
}) {
  const [own, setOwn] = useState(defaultChecked);
  const on = checked ?? own;
  return (
    <button
      className="sw"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => {
        setOwn(!on);
        onChange?.(!on);
      }}
    />
  );
}
