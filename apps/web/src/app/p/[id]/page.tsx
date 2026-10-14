import type { Metadata } from 'next';
import { BRAND } from '@kovra/core/brand';
import { PublicPortfolioView } from '@/components/public/PublicPortfolioView';

export const metadata: Metadata = {
  title: `Public portfolio · ${BRAND}`,
  description: `A ${BRAND} vault, shared by its owner: net vs hold, positions and every agent move.`,
  // Owners share these links themselves; search engines don't need to list them.
  robots: { index: false, follow: true },
};

export default function PublicPortfolioPage({ params }: { params: { id: string } }) {
  return <PublicPortfolioView id={params.id} />;
}
