import { BRAND } from '@kovra/core/brand';
import { Icon } from './Sprite';

export function Logo() {
  return (
    <a href="#" className="logo">
      <span className="mark">
        <Icon id="i-mark" />
      </span>
      {BRAND}
    </a>
  );
}
