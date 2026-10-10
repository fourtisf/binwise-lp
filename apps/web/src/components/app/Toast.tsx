'use client';

import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';

export function Toast() {
  const { toastText, toastOn } = useUi();
  return (
    <div className={`toast${toastOn ? ' on' : ''}`} id="toast" role="status">
      <Icon id="i-check" />
      <span>{toastText}</span>
    </div>
  );
}
