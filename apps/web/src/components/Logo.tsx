import { BRAND } from '@kovra/core/brand';
import { BrandMark } from './BrandMark';

export function Logo() {
  return (
    <a href="#" className="logo">
      <BrandMark />
      {BRAND}
    </a>
  );
}
